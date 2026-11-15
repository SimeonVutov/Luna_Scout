"""Persist runs and choose short, fair batches for the science worker."""

import os
import shutil
import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import islice
from pathlib import Path
from time import time_ns
from typing import Literal

from pydantic import BaseModel

from ..ephemeris.horizons import Correction
from .metrics import PeriodSummary, Reading
from .plan import RunPlan


class RunStatus(BaseModel):
    run_id: str
    stage: Literal["queued", "running", "complete", "failed"]
    revision: int
    plan: RunPlan
    ready_indices: list[int]
    ready_times_utc: list[datetime]
    completed_samples: int
    total_samples: int
    total_frames: int
    period: PeriodSummary | None
    message: str | None
    submitted_utc: datetime | None = None


class WorkerStatus(BaseModel):
    """Whether a worker process is alive and what it is doing right now."""

    running: bool
    pid: int | None
    activity: str | None
    run_id: str | None


class RunList(BaseModel):
    worker: WorkerStatus
    runs: list[RunStatus]


class EphemerisChunk(BaseModel):
    from_utc: datetime
    through_utc: datetime
    frame: str
    correction: Correction
    api_versions: tuple[str, ...]
    planetary_ephemerides: tuple[str, ...]
    response_sha256: tuple[str, ...]
    kernels_sha256: dict[str, str]


class ReusedSamples(BaseModel):
    from_run_id: str
    samples: int


class Provenance(BaseModel):
    plan: RunPlan
    ephemeris_chunks: list[EphemerisChunk]
    # Samples copied from earlier runs of the same site and settings instead of recomputed.
    reused_samples: list[ReusedSamples] = []


class RunRemoved(RuntimeError):
    """The run was deleted, for example with its site, while the worker was computing it."""


# A worker that has not reported for this long is treated as stopped.
WORKER_TIMEOUT_NS = 10_000_000_000


@dataclass(frozen=True)
class WorkBatch:
    run_id: str
    plan: RunPlan
    indices: tuple[int, ...]
    # True when this batch is only the playhead sample that the dashboard is waiting for.
    playhead_only: bool = False


class RunQueue:
    """Durable state shared by FastAPI and a single worker process."""

    def __init__(self, data_dir: Path) -> None:
        self.directory = data_dir / "runs"

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        with closing(sqlite3.connect(self.directory / "queue.sqlite3", timeout=15)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            yield db

    def initialize(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            db.execute("PRAGMA journal_mode = WAL")
            self._create_tables(db)
            self._add_physics_keys(db)

    @staticmethod
    def _create_tables(db: sqlite3.Connection) -> None:
        db.executescript("""
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    plan TEXT NOT NULL,
                    stage TEXT NOT NULL DEFAULT 'queued',
                    priority_index INTEGER NOT NULL,
                    submitted INTEGER NOT NULL,
                    last_served INTEGER NOT NULL DEFAULT 0,
                    revision INTEGER NOT NULL DEFAULT 1,
                    completed_samples INTEGER NOT NULL DEFAULT 0,
                    period TEXT,
                    message TEXT
                );
                CREATE TABLE IF NOT EXISTS readings (
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    sample_index INTEGER NOT NULL,
                    is_frame INTEGER NOT NULL,
                    reading TEXT NOT NULL,
                    PRIMARY KEY (run_id, sample_index)
                );
                CREATE TABLE IF NOT EXISTS reused_samples (
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    from_run_id TEXT NOT NULL,
                    samples INTEGER NOT NULL,
                    PRIMARY KEY (run_id, from_run_id)
                );
                CREATE TABLE IF NOT EXISTS worker (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    pid INTEGER,
                    heartbeat_ns INTEGER NOT NULL DEFAULT 0,
                    activity TEXT,
                    activity_run TEXT
                );
                CREATE TABLE IF NOT EXISTS ephemeris_chunks (
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    start_index INTEGER NOT NULL,
                    provenance TEXT NOT NULL,
                    PRIMARY KEY (run_id, start_index)
                );
        """)

    @staticmethod
    def _add_physics_keys(db: sqlite3.Connection) -> None:
        """Older databases lack the column that lets runs share samples; add and fill it."""
        columns = {row["name"] for row in db.execute("PRAGMA table_info(runs)")}
        if "physics_key" not in columns:
            db.execute("ALTER TABLE runs ADD COLUMN physics_key TEXT")
        if "orphaned" not in columns:
            # Zero for a live run; otherwise when its site was deleted and its results were kept.
            db.execute("ALTER TABLE runs ADD COLUMN orphaned INTEGER NOT NULL DEFAULT 0")
        for row in db.execute("SELECT run_id, plan FROM runs WHERE physics_key IS NULL").fetchall():
            key = RunPlan.model_validate_json(row["plan"]).physics_key()
            db.execute("UPDATE runs SET physics_key = ? WHERE run_id = ?", (key, row["run_id"]))

    def submit(self, plan: RunPlan, priority_at: datetime | None = None) -> RunStatus:
        """Reuse identical inputs. A failed run can resume its remaining samples.

        A new run first copies the samples that earlier runs of the same site and settings already
        computed at the same times, so a longer or shorter range only computes what is missing.
        """
        index = plan.frame_index(priority_at) if priority_at is not None else 0
        run_id = plan.identity()
        with self._connection() as db:
            is_new = self._find(db, run_id) is None
            db.execute(
                """
                INSERT INTO runs (run_id, plan, priority_index, submitted, physics_key) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    priority_index = excluded.priority_index,
                    message = NULL,
                    stage = CASE WHEN runs.stage = 'failed' THEN 'queued' ELSE runs.stage END,
                    revision = runs.revision + CASE WHEN runs.stage = 'failed' THEN 1 ELSE 0 END
                WHERE runs.stage != 'complete'
                """,
                (run_id, plan.model_dump_json(), index, time_ns(), plan.physics_key()),
            )
            db.execute("UPDATE runs SET orphaned = 0 WHERE run_id = ?", (run_id,))
            discarded: list[str] = []
            if is_new:
                self._reuse_samples(db, run_id, plan)
                # What was kept for this site has now been restored where it falls inside the new
                # range. The rest, outside the timeline, is of no further use.
                discarded = self._remove_runs(db, self._orphaned_runs_of(db, plan))
            row = self._find(db, run_id)
            if row is None:
                raise RuntimeError("Could not read the submitted run.")
            status = self._status(db, row)

        self._delete_run_files(discarded)
        return status

    def _reuse_samples(self, db: sqlite3.Connection, run_id: str, plan: RunPlan) -> None:
        """Copy matching samples, and their snapshot files, from earlier runs of the same physics."""
        step = plan.integration_step
        siblings = db.execute(
            "SELECT run_id, plan FROM runs WHERE physics_key = ? AND run_id != ?",
            (plan.physics_key(), run_id),
        ).fetchall()

        total = 0
        for sibling in siblings:
            other = RunPlan.model_validate_json(sibling["plan"])
            shift = other.start_utc - plan.start_utc
            if shift % step != timedelta(0):
                continue

            # New index = old index + offset. Frames repeat every `stride` samples, so they only
            # line up between the two runs when the offset is a whole number of strides.
            offset = shift // step
            if offset % plan.stride != 0:
                continue

            first = max(0, -offset)
            last = min(other.interval_count, plan.interval_count - offset)
            if first > last:
                continue

            copied = 0
            rows = db.execute(
                "SELECT sample_index, is_frame, reading FROM readings WHERE run_id = ? AND sample_index BETWEEN ? AND ?",
                (sibling["run_id"], first, last),
            ).fetchall()
            for row in rows:
                old_index, new_index = row["sample_index"], row["sample_index"] + offset
                if other.at(old_index) != plan.at(new_index):
                    continue
                if plan.is_frame(new_index) and not (
                    row["is_frame"]
                    and self._link_frame(self.frame_path(sibling["run_id"], old_index), self.frame_path(run_id, new_index))
                ):
                    continue

                inserted = db.execute(
                    "INSERT OR IGNORE INTO readings VALUES (?, ?, ?, ?)",
                    (run_id, new_index, plan.is_frame(new_index), row["reading"]),
                )
                copied += inserted.rowcount

            if copied:
                db.execute("INSERT OR REPLACE INTO reused_samples VALUES (?, ?, ?)", (run_id, sibling["run_id"], copied))
                total += copied

        if total:
            db.execute(
                "UPDATE runs SET completed_samples = completed_samples + ?, revision = revision + 1 WHERE run_id = ?",
                (total, run_id),
            )

    @staticmethod
    def _link_frame(source: Path, destination: Path) -> bool:
        """Share a snapshot file between runs with a hard link, or copy it where links fail."""
        if not source.is_file():
            return False
        if destination.exists():
            return True

        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(source, destination)
        except OSError:
            shutil.copy2(source, destination)
        return True

    def purge_site(self, latitude_deg: float, longitude_deg: float, radius_m: float) -> int:
        """Delete every run and snapshot file of a site; returns how many runs were removed.

        Snapshot files are hard-linked between runs, so a file is only freed once every run that
        shares it is gone.
        """
        with self._connection() as db:
            doomed = self._remove_runs(db, self._runs_of_site(db, latitude_deg, longitude_deg, radius_m))
        self._delete_run_files(doomed)
        return len(doomed)

    def keep_site(self, latitude_deg: float, longitude_deg: float, radius_m: float) -> int:
        """Hide a deleted site's runs but keep their results, so the site can be restored later.

        Runs still computing are stopped, since nobody is waiting for them. Returns the run count.
        """
        with self._connection() as db:
            kept = self._runs_of_site(db, latitude_deg, longitude_deg, radius_m)
            for run_id in kept:
                db.execute(
                    """
                    UPDATE runs SET orphaned = ?, revision = revision + 1,
                        message = CASE WHEN stage IN ('queued', 'running') THEN 'The site was deleted.' ELSE message END,
                        stage = CASE WHEN stage IN ('queued', 'running') THEN 'failed' ELSE stage END
                    WHERE run_id = ?
                    """,
                    (time_ns(), run_id),
                )
        return len(kept)

    def prune_kept(self, older_than: timedelta) -> int:
        """Delete kept results of sites that never came back; returns how many runs were removed."""
        cutoff = time_ns() - int(older_than.total_seconds() * 1e9)
        with self._connection() as db:
            stale = [
                row["run_id"]
                for row in db.execute("SELECT run_id FROM runs WHERE orphaned > 0 AND orphaned < ?", (cutoff,))
            ]
            doomed = self._remove_runs(db, stale)
        self._delete_run_files(doomed)
        return len(doomed)

    @staticmethod
    def _runs_of_site(db: sqlite3.Connection, latitude_deg: float, longitude_deg: float, radius_m: float) -> list[str]:
        return [
            row["run_id"]
            for row in db.execute("SELECT run_id, plan FROM runs").fetchall()
            if _same_site(RunPlan.model_validate_json(row["plan"]), latitude_deg, longitude_deg, radius_m)
        ]

    def _orphaned_runs_of(self, db: sqlite3.Connection, plan: RunPlan) -> list[str]:
        site = plan.site
        kept = set(self._runs_of_site(db, site.latitude_deg, site.longitude_deg, site.radius_m))
        return [
            row["run_id"]
            for row in db.execute("SELECT run_id FROM runs WHERE orphaned > 0").fetchall()
            if row["run_id"] in kept
        ]

    @staticmethod
    def _remove_runs(db: sqlite3.Connection, run_ids: Sequence[str]) -> list[str]:
        for run_id in run_ids:
            for table in ("readings", "ephemeris_chunks", "reused_samples"):
                db.execute(f"DELETE FROM {table} WHERE run_id = ?", (run_id,))
            db.execute("DELETE FROM runs WHERE run_id = ?", (run_id,))
        return list(run_ids)

    def _delete_run_files(self, run_ids: Sequence[str]) -> None:
        for run_id in run_ids:
            shutil.rmtree(self.directory / run_id, ignore_errors=True)

    def unfinished_count(self) -> int:
        """How many runs are waiting or running."""
        with self._connection() as db:
            row = db.execute(
                "SELECT COUNT(*) FROM runs WHERE stage IN ('queued', 'running') AND orphaned = 0"
            ).fetchone()
        return int(row[0])

    def list_runs(self, limit: int = 30) -> list[RunStatus]:
        """The most recently submitted runs first, whatever their state."""
        with self._connection() as db:
            rows = db.execute(
                "SELECT * FROM runs WHERE orphaned = 0 ORDER BY submitted DESC LIMIT ?", (limit,)
            ).fetchall()
            # Long runs have thousands of ready snapshots; the list only needs their progress.
            return [self._status(db, row, include_ready=False) for row in rows]

    def beat(self, pid: int) -> None:
        """Report that the worker is alive. Called every few seconds, even during long batches."""
        with self._connection() as db:
            db.execute(
                """
                INSERT INTO worker (id, pid, heartbeat_ns) VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, heartbeat_ns = excluded.heartbeat_ns
                """,
                (pid, time_ns()),
            )

    def set_activity(self, run_id: str | None, activity: str | None) -> None:
        with self._connection() as db:
            db.execute(
                """
                INSERT INTO worker (id, activity, activity_run) VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET activity = excluded.activity, activity_run = excluded.activity_run
                """,
                (activity, run_id),
            )

    def stop_beating(self) -> None:
        """Mark the worker as stopped right away, instead of after the timeout."""
        with self._connection() as db:
            db.execute("UPDATE worker SET heartbeat_ns = 0, activity = NULL, activity_run = NULL WHERE id = 1")

    def worker_status(self, now_ns: int | None = None) -> WorkerStatus:
        with self._connection() as db:
            row = db.execute("SELECT * FROM worker WHERE id = 1").fetchone()
        if row is None:
            return WorkerStatus(running=False, pid=None, activity=None, run_id=None)

        alive = (now_ns if now_ns is not None else time_ns()) - row["heartbeat_ns"] < WORKER_TIMEOUT_NS
        return WorkerStatus(
            running=alive,
            pid=row["pid"] if alive else None,
            activity=row["activity"] if alive else None,
            run_id=row["activity_run"] if alive else None,
        )

    def status(self, run_id: str) -> RunStatus | None:
        with self._connection() as db:
            row = self._find(db, run_id)
            return self._status(db, row) if row is not None else None

    def changes(self, watched: dict[str, int]) -> list[RunStatus]:
        """Read durable revisions even after an event stream reconnects."""
        with self._connection() as db:
            db.execute("BEGIN")
            statuses = []
            for run_id, revision in watched.items():
                row = self._find(db, run_id)
                if row is not None and row["revision"] != revision:
                    statuses.append(self._status(db, row))
            return statuses

    def set_priority(self, run_ids: Sequence[str], at: datetime) -> None:
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            for run_id in run_ids:
                row = self._find(db, run_id)
                if row is None or row["stage"] not in ("queued", "running"):
                    continue
                plan = RunPlan.model_validate_json(row["plan"])
                index = plan.frame_index(at)
                db.execute("UPDATE runs SET priority_index = ? WHERE run_id = ?", (index, run_id))

    def next_batch(self, batch_size: int) -> WorkBatch | None:
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """
                SELECT * FROM runs AS run WHERE stage IN ('queued', 'running') AND orphaned = 0
                ORDER BY EXISTS (
                    SELECT 1 FROM readings
                    WHERE run_id = run.run_id AND sample_index = run.priority_index
                ), last_served, submitted
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None

            run_id = row["run_id"]
            plan = RunPlan.model_validate_json(row["plan"])
            computed = {
                result[0]
                for result in db.execute(
                    "SELECT sample_index FROM readings WHERE run_id = ?", (run_id,)
                )
            }
            priority: int = row["priority_index"]
            indices: tuple[int, ...]
            playhead_only = priority not in computed
            if playhead_only:
                indices = (priority,)
            else:
                # Published snapshots first, then the samples between them, each in time order.
                missing_frames = (
                    index for index in range(0, plan.interval_count + 1, plan.stride) if index not in computed
                )
                missing_between = (
                    index for index in range(plan.interval_count + 1)
                    if index not in computed and not plan.is_frame(index)
                )
                indices = tuple(islice(missing_frames, batch_size))
                if len(indices) < batch_size:
                    indices += tuple(islice(missing_between, batch_size - len(indices)))

            db.execute(
                """
                UPDATE runs SET stage = 'running', last_served = ?,
                    revision = revision + CASE WHEN stage = 'queued' THEN 1 ELSE 0 END
                WHERE run_id = ?
                """,
                (time_ns(), run_id),
            )
            return WorkBatch(run_id, plan, indices, playhead_only)

    def record(self, batch: WorkBatch, index: int, reading: Reading) -> None:
        with self._connection() as db:
            if self._find(db, batch.run_id) is None:
                raise RunRemoved(batch.run_id)
            inserted = db.execute(
                "INSERT OR IGNORE INTO readings VALUES (?, ?, ?, ?)",
                (batch.run_id, index, batch.plan.is_frame(index), reading.model_dump_json()),
            )
            if inserted.rowcount:
                db.execute(
                    """
                    UPDATE runs SET completed_samples = completed_samples + 1, revision = revision + 1
                    WHERE run_id = ?
                    """,
                    (batch.run_id,),
                )

    def readings(self, run_id: str, *, frames_only: bool = False) -> list[Reading]:
        sql = "SELECT reading FROM readings WHERE run_id = ?"
        if frames_only:
            sql += " AND is_frame = 1"
        with self._connection() as db:
            return [
                Reading.model_validate_json(row[0])
                for row in db.execute(sql + " ORDER BY sample_index", (run_id,))
            ]

    def frame(self, run_id: str, index: int) -> tuple[Reading, Path] | None:
        with self._connection() as db:
            row = self._find(db, run_id)
            if row is None:
                return None
            plan = RunPlan.model_validate_json(row["plan"])
            sample_index = index * plan.stride
            result = db.execute(
                "SELECT reading FROM readings WHERE run_id = ? AND sample_index = ? AND is_frame = 1",
                (run_id, sample_index),
            ).fetchone()
            if result is None:
                return None
            return Reading.model_validate_json(result[0]), self.frame_path(run_id, sample_index)

    def frame_path(self, run_id: str, sample_index: int) -> Path:
        return self.directory / run_id / "snapshots" / f"{sample_index}.npz"

    def record_ephemeris(self, run_id: str, start: int, provenance: EphemerisChunk) -> None:
        with self._connection() as db:
            db.execute(
                "INSERT OR IGNORE INTO ephemeris_chunks VALUES (?, ?, ?)",
                (run_id, start, provenance.model_dump_json()),
            )

    def provenance(self, run_id: str) -> Provenance | None:
        with self._connection() as db:
            row = self._find(db, run_id)
            if row is None:
                return None
            chunks = db.execute(
                "SELECT provenance FROM ephemeris_chunks WHERE run_id = ? ORDER BY start_index",
                (run_id,),
            )
            reused = db.execute(
                "SELECT from_run_id, samples FROM reused_samples WHERE run_id = ? ORDER BY from_run_id",
                (run_id,),
            )
            return Provenance(
                plan=RunPlan.model_validate_json(row["plan"]),
                ephemeris_chunks=[EphemerisChunk.model_validate_json(chunk[0]) for chunk in chunks],
                reused_samples=[ReusedSamples(from_run_id=item[0], samples=item[1]) for item in reused],
            )

    def complete(self, run_id: str, period: PeriodSummary) -> None:
        with self._connection() as db:
            db.execute(
                "UPDATE runs SET stage = 'complete', period = ?, revision = revision + 1 WHERE run_id = ?",
                (period.model_dump_json(), run_id),
            )

    def fail(self, run_id: str, message: str) -> None:
        with self._connection() as db:
            db.execute(
                "UPDATE runs SET stage = 'failed', message = ?, revision = revision + 1 WHERE run_id = ?",
                (message, run_id),
            )

    @staticmethod
    def _find(db: sqlite3.Connection, run_id: str) -> sqlite3.Row | None:
        return db.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()

    @staticmethod
    def _status(db: sqlite3.Connection, row: sqlite3.Row, *, include_ready: bool = True) -> RunStatus:
        plan = RunPlan.model_validate_json(row["plan"])
        samples = [
            item[0]
            for item in db.execute(
                "SELECT sample_index FROM readings WHERE run_id = ? AND is_frame = 1 ORDER BY sample_index",
                (row["run_id"],),
            )
        ] if include_ready else []
        return RunStatus(
            run_id=row["run_id"],
            stage=row["stage"],
            revision=row["revision"],
            plan=plan,
            ready_indices=[index // plan.stride for index in samples],
            ready_times_utc=[plan.at(index) for index in samples],
            completed_samples=row["completed_samples"],
            total_samples=plan.interval_count + 1,
            total_frames=plan.frame_count,
            period=PeriodSummary.model_validate_json(row["period"]) if row["period"] else None,
            message=row["message"],
            submitted_utc=datetime.fromtimestamp(row["submitted"] / 1e9, UTC),
        )


def _same_site(plan: RunPlan, latitude_deg: float, longitude_deg: float, radius_m: float) -> bool:
    site = plan.site
    return (
        abs(site.latitude_deg - latitude_deg) < 1e-9
        and abs(site.longitude_deg - longitude_deg) < 1e-9
        and site.radius_m == radius_m
    )
