"""Persist runs and choose short, fair batches for the science worker."""

import json
import os
import shutil
import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import closing, contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from itertools import islice
from pathlib import Path
from time import sleep, time_ns
from typing import Literal

from pydantic import BaseModel

from ..ephemeris.states import Correction
from ..terrain.horizon import saved_point_count, site_label
from .metrics import PeriodSummary, Reading
from .performance import load_model
from .progress import ProgressState, RunProgress, StageKey, estimate, shared_remaining
from .plan import RunPlan


class RunStatus(BaseModel):
    run_id: str
    stage: Literal["queued", "running", "paused", "complete", "failed"]
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
    # Precomputed ahead of time while the server is idle, rather than asked for by a visitor.
    background: bool = False
    # Stages and time left, for runs that are waiting, running or paused.
    progress: RunProgress | None = None


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
    # Which ephemeris produced the positions. Rows saved before SPICE replaced Horizons lack it.
    source: str = "JPL Horizons"
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


class RunPaused(RuntimeError):
    """The run was paused while the worker was computing it."""


class RunYielded(RuntimeError):
    """A background run stepped aside because a visitor's run is waiting."""


class Coverage(BaseModel):
    """The dates a site's precomputed results cover, with the website's default settings."""

    latitude_deg: float
    longitude_deg: float
    radius_m: float
    start_utc: datetime
    end_utc: datetime
    complete: bool


class RunLookup(BaseModel):
    """What the server already has for a request, without starting anything."""

    run: RunStatus | None
    # Samples that earlier runs of the same site and settings already computed for this range.
    reusable_samples: int
    total_samples: int


# The request recorded for callers without a browser session, such as a private server's CLI.
LOCAL_SESSION = "local"

# Tries, 0.1 s apart, at switching the database to write-ahead logging while another process does.
_WAL_ATTEMPTS = 50

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
            _use_write_ahead_log(db)
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
                CREATE TABLE IF NOT EXISTS run_requests (
                    -- Each browser session that asked for a run. A run is computed while at least
                    -- one request is active, so one visitor's pause or cancel never stops another's.
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    session TEXT NOT NULL,
                    paused INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (run_id, session)
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
        """Add the columns older databases lack, and fill the one that lets runs share samples.

        The API and the worker start together, so the check and the additions happen under the
        database's write lock: the second process waits, then finds the columns already there.
        """
        db.execute("BEGIN IMMEDIATE")
        columns = {row["name"] for row in db.execute("PRAGMA table_info(runs)")}
        if "physics_key" not in columns:
            db.execute("ALTER TABLE runs ADD COLUMN physics_key TEXT")
        if "orphaned" not in columns:
            # Zero for a live run; otherwise when its site was deleted and its results were kept.
            db.execute("ALTER TABLE runs ADD COLUMN orphaned INTEGER NOT NULL DEFAULT 0")
        if "background" not in columns:
            db.execute("ALTER TABLE runs ADD COLUMN background INTEGER NOT NULL DEFAULT 0")
        if "owner" not in columns:
            # The session that first asked for the run, kept for the record.
            db.execute("ALTER TABLE runs ADD COLUMN owner TEXT")
        if "progress" not in columns:
            # JSON the worker updates as a run moves through its stages; see jobs/progress.py.
            db.execute("ALTER TABLE runs ADD COLUMN progress TEXT")
        if "abandoned" not in columns:
            # Zero while someone wants the run; otherwise when the last request was cancelled. An
            # abandoned run is hidden and not computed, but its samples stay for others to reuse.
            db.execute("ALTER TABLE runs ADD COLUMN abandoned INTEGER NOT NULL DEFAULT 0")
        for row in db.execute("SELECT run_id, plan FROM runs WHERE physics_key IS NULL").fetchall():
            key = RunPlan.model_validate_json(row["plan"]).physics_key()
            db.execute("UPDATE runs SET physics_key = ? WHERE run_id = ?", (key, row["run_id"]))

    def submit(
        self, plan: RunPlan, priority_at: datetime | None = None, session: str | None = None, *, background: bool = False
    ) -> RunStatus:
        """Reuse identical inputs, and record `session` as wanting the run.

        A failed run resumes its remaining samples. A run its requesters paused stays paused when
        one of them submits again, so changing the timeline never restarts it by surprise, but a
        new requester restarts it. A new run first copies the samples that earlier runs of the
        same site and settings computed at the same times, so only the missing times are computed.
        """
        session = session or LOCAL_SESSION
        index = plan.frame_index(priority_at) if priority_at is not None else 0
        run_id = plan.identity()
        with self._connection() as db:
            is_new = self._find(db, run_id) is None
            db.execute(
                """
                INSERT INTO runs (run_id, plan, priority_index, submitted, physics_key, owner, background)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    priority_index = excluded.priority_index,
                    background = MIN(runs.background, excluded.background),
                    message = NULL,
                    stage = CASE WHEN runs.stage = 'failed' THEN 'queued' ELSE runs.stage END,
                    revision = runs.revision + CASE WHEN runs.stage = 'failed' THEN 1 ELSE 0 END
                WHERE runs.stage != 'complete'
                """,
                (run_id, plan.model_dump_json(), index, time_ns(), plan.physics_key(), session, int(background)),
            )
            db.execute("UPDATE runs SET orphaned = 0 WHERE run_id = ?", (run_id,))
            new_request = db.execute(
                "INSERT OR IGNORE INTO run_requests (run_id, session) VALUES (?, ?)", (run_id, session)
            ).rowcount
            # Someone new wants a run that was abandoned or paused by everyone else: restart it.
            db.execute(
                """
                UPDATE runs SET abandoned = 0,
                    stage = CASE WHEN stage = 'paused' THEN 'queued' ELSE stage END,
                    revision = revision + 1
                WHERE run_id = ? AND (abandoned > 0 OR (? AND stage = 'paused'))
                """,
                (run_id, new_request),
            )
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

    def lookup(self, plan: RunPlan) -> RunLookup:
        """The run for this plan if it exists, and how much of it earlier runs already computed."""
        with self._connection() as db:
            row = self._find(db, plan.identity())
            if row is not None and not row["abandoned"]:
                status = self._status(db, row)
                return RunLookup(run=status, reusable_samples=status.completed_samples, total_samples=status.total_samples)
            new_indices = {new_index for _, _, new_index, _ in self._aligned_samples(db, plan.identity(), plan)}
            if row is not None:
                new_indices |= {item[0] for item in db.execute("SELECT sample_index FROM readings WHERE run_id = ?", (row["run_id"],))}
        return RunLookup(run=None, reusable_samples=len(new_indices), total_samples=plan.interval_count + 1)

    def _aligned_samples(
        self, db: sqlite3.Connection, run_id: str, plan: RunPlan
    ) -> Iterator[tuple[str, int, int, bool]]:
        """Samples of other runs with the same physics at the same times as samples of `plan`.

        Yields the other run, its sample index, the matching index in `plan`, and whether the
        other run published that sample as a snapshot. Samples `run_id` already has are skipped.
        """
        have = {item[0] for item in db.execute("SELECT sample_index FROM readings WHERE run_id = ?", (run_id,))}
        step = plan.integration_step
        siblings = db.execute(
            "SELECT run_id, plan FROM runs WHERE physics_key = ? AND run_id != ?",
            (plan.physics_key(), run_id),
        ).fetchall()

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

            rows = db.execute(
                "SELECT sample_index, is_frame FROM readings WHERE run_id = ? AND sample_index BETWEEN ? AND ?",
                (sibling["run_id"], first, last),
            ).fetchall()
            for row in rows:
                old_index, new_index = row["sample_index"], row["sample_index"] + offset
                if new_index not in have and other.at(old_index) == plan.at(new_index):
                    have.add(new_index)
                    yield sibling["run_id"], old_index, new_index, bool(row["is_frame"])

    def _reuse_samples(self, db: sqlite3.Connection, run_id: str, plan: RunPlan) -> None:
        """Copy matching samples, and their snapshot files, from other runs of the same physics.

        Called when a run is submitted and again before each of its batches, so runs whose dates
        overlap compute each time only once, even while both are running.
        """
        copied_from: dict[str, int] = {}
        for sibling_id, old_index, new_index, sibling_frame in self._aligned_samples(db, run_id, plan):
            if plan.is_frame(new_index) and not (
                sibling_frame
                and self._link_frame(self.frame_path(sibling_id, old_index), self.frame_path(run_id, new_index))
            ):
                continue

            inserted = db.execute(
                """
                INSERT OR IGNORE INTO readings
                SELECT ?, ?, ?, reading FROM readings WHERE run_id = ? AND sample_index = ?
                """,
                (run_id, new_index, plan.is_frame(new_index), sibling_id, old_index),
            )
            copied_from[sibling_id] = copied_from.get(sibling_id, 0) + inserted.rowcount

        for sibling_id, copied in copied_from.items():
            if copied:
                db.execute(
                    """
                    INSERT INTO reused_samples VALUES (?, ?, ?)
                    ON CONFLICT(run_id, from_run_id) DO UPDATE SET samples = samples + excluded.samples
                    """,
                    (run_id, sibling_id, copied),
                )

        total = sum(copied_from.values())
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
            for table in ("readings", "ephemeris_chunks", "reused_samples", "run_requests"):
                db.execute(f"DELETE FROM {table} WHERE run_id = ?", (run_id,))
            db.execute("DELETE FROM runs WHERE run_id = ?", (run_id,))
        return list(run_ids)

    def _delete_run_files(self, run_ids: Sequence[str]) -> None:
        for run_id in run_ids:
            shutil.rmtree(self.directory / run_id, ignore_errors=True)

    def pause(self, run_id: str, session: str | None) -> RunStatus | None:
        """Pause `session`'s request. The run stops once no requester wants it computed.

        None for an unknown run. A run others still want keeps running.
        """
        with self._connection() as db:
            if self._find(db, run_id) is None:
                return None
            db.execute(
                "UPDATE run_requests SET paused = 1 WHERE run_id = ? AND session = ?",
                (run_id, session or LOCAL_SESSION),
            )
            self._stop_if_unwanted(db, run_id, abandon=False)
            return self._status(db, self._find_existing(db, run_id))

    def resume(self, run_id: str, session: str | None) -> RunStatus | None:
        """Make `session` want the run again and continue it from where it stopped."""
        with self._connection() as db:
            if self._find(db, run_id) is None:
                return None
            db.execute(
                """
                INSERT INTO run_requests (run_id, session) VALUES (?, ?)
                ON CONFLICT(run_id, session) DO UPDATE SET paused = 0
                """,
                (run_id, session or LOCAL_SESSION),
            )
            db.execute(
                """
                UPDATE runs SET abandoned = 0, message = NULL, revision = revision + 1,
                    stage = CASE WHEN stage IN ('paused', 'failed') THEN 'queued' ELSE stage END
                WHERE run_id = ?
                """,
                (run_id,),
            )
            return self._status(db, self._find_existing(db, run_id))

    def cancel(self, run_id: str, session: str | None) -> RunStatus | None:
        """Withdraw `session`'s request. Nothing computed is deleted.

        When nobody else wants the run, it stops and is hidden, but its samples stay for any
        later or overlapping request to reuse, and are only removed when no one asked for them
        for `KEEP_ABANDONED`.
        """
        with self._connection() as db:
            if self._find(db, run_id) is None:
                return None
            db.execute(
                "DELETE FROM run_requests WHERE run_id = ? AND session = ?", (run_id, session or LOCAL_SESSION)
            )
            self._stop_if_unwanted(db, run_id, abandon=True)
            return self._status(db, self._find_existing(db, run_id))

    def prune_abandoned(self, older_than: timedelta) -> int:
        """Delete runs nobody has wanted for `older_than`; returns how many were removed.

        Samples other runs copied from them are their own and stay.
        """
        cutoff = time_ns() - int(older_than.total_seconds() * 1e9)
        with self._connection() as db:
            stale = [
                row["run_id"]
                for row in db.execute("SELECT run_id FROM runs WHERE abandoned > 0 AND abandoned < ?", (cutoff,))
            ]
            doomed = self._remove_runs(db, stale)
        self._delete_run_files(doomed)
        return len(doomed)

    def _stop_if_unwanted(self, db: sqlite3.Connection, run_id: str, *, abandon: bool) -> None:
        """Pause the run when no request is active; with `abandon`, also hide it when none is left."""
        requests = db.execute(
            "SELECT COUNT(*), COALESCE(SUM(paused = 0), 0) FROM run_requests WHERE run_id = ?", (run_id,)
        ).fetchone()
        total, active = int(requests[0]), int(requests[1])
        if active == 0:
            db.execute(
                """
                UPDATE runs SET stage = 'paused', revision = revision + 1
                WHERE run_id = ? AND stage IN ('queued', 'running')
                """,
                (run_id,),
            )
        if abandon and total == 0:
            db.execute(
                "UPDATE runs SET abandoned = ?, revision = revision + 1 WHERE run_id = ?", (time_ns(), run_id)
            )

    def _find_existing(self, db: sqlite3.Connection, run_id: str) -> sqlite3.Row:
        row = self._find(db, run_id)
        if row is None:
            raise RunRemoved(run_id)
        return row

    def check_wanted(self, run_id: str) -> None:
        """Raise if the run was deleted or paused, or is background work a visitor is waiting
        behind, so long work on it can stop early."""
        with self._connection() as db:
            row = self._find(db, run_id)
            visitor_waiting = row is not None and bool(row["background"]) and self._visitor_waiting(db)
        if row is None:
            raise RunRemoved(run_id)
        if row["stage"] == "paused":
            raise RunPaused(run_id)
        if visitor_waiting:
            raise RunYielded(run_id)

    @staticmethod
    def _visitor_waiting(db: sqlite3.Connection) -> bool:
        row = db.execute(
            "SELECT 1 FROM runs WHERE stage IN ('queued', 'running') AND orphaned = 0 AND background = 0 LIMIT 1"
        ).fetchone()
        return row is not None

    def coverage(self, physics_keys: dict[str, tuple[float, float, float]]) -> list[Coverage]:
        """Precomputed date ranges for the given physics keys, newest first per key.

        `physics_keys` maps each key to the site's latitude, longitude and radius.
        """
        if not physics_keys:
            return []
        placeholders = ", ".join("?" for _ in physics_keys)
        with self._connection() as db:
            rows = db.execute(
                f"""
                SELECT physics_key, plan, stage FROM runs
                WHERE background = 1 AND orphaned = 0 AND physics_key IN ({placeholders})
                ORDER BY submitted DESC
                """,
                tuple(physics_keys),
            ).fetchall()

        result = []
        for row in rows:
            plan = RunPlan.model_validate_json(row["plan"])
            latitude, longitude, radius = physics_keys[row["physics_key"]]
            result.append(Coverage(
                latitude_deg=latitude, longitude_deg=longitude, radius_m=radius,
                start_utc=plan.start_utc, end_utc=plan.end_utc, complete=row["stage"] == "complete",
            ))
        return result

    def drop_superseded_background(self, plan: RunPlan, session: str) -> int:
        """Delete older precomputed runs of the same physics whose dates `plan` covers.

        Called after `plan` was submitted, which copied their samples, so nothing is lost. A run
        that anyone besides `session` (the precompute) asked for is kept.
        """
        with self._connection() as db:
            doomed = []
            for row in db.execute(
                """
                SELECT run_id, plan FROM runs AS run
                WHERE background = 1 AND physics_key = ? AND run_id != ? AND NOT EXISTS (
                    SELECT 1 FROM run_requests WHERE run_id = run.run_id AND session != ?
                )
                """,
                (plan.physics_key(), plan.identity(), session),
            ).fetchall():
                other = RunPlan.model_validate_json(row["plan"])
                if plan.start_utc <= other.start_utc and other.end_utc <= plan.end_utc:
                    doomed.append(row["run_id"])
            removed = self._remove_runs(db, doomed)
        self._delete_run_files(removed)
        return len(removed)

    def set_progress(
        self,
        run_id: str,
        *,
        phase: StageKey | None = None,
        finished: StageKey | None = None,
        points: int | None = None,
        horizon_missing: int | None = None,
        horizon_done: int | None = None,
    ) -> None:
        """Record where the worker is in a run. Changes reach watching pages through the run's revision."""
        with self._connection() as db:
            row = self._find(db, run_id)
            if row is None:
                return
            state = ProgressState.from_dict(json.loads(row["progress"] or "{}"))
            if phase is not None and phase != state.phase:
                state.phase, state.phase_started_ns = phase, time_ns()
            if finished is not None and finished not in state.finished:
                state.finished.append(finished)
            if points is not None:
                state.points = points
            if horizon_missing is not None:
                state.horizon_missing = horizon_missing
            if horizon_done is not None:
                state.horizon_done = horizon_done
            db.execute(
                "UPDATE runs SET progress = ?, revision = revision + 1 WHERE run_id = ?",
                (json.dumps(asdict(state)), run_id),
            )

    def progress_state(self, run_id: str) -> ProgressState:
        with self._connection() as db:
            row = self._find(db, run_id)
        return ProgressState.from_dict(json.loads(row["progress"] or "{}")) if row is not None else ProgressState()

    def unfinished_count(self) -> int:
        """How many visitors' runs are waiting or running. Precomputed runs are not counted."""
        with self._connection() as db:
            row = db.execute(
                "SELECT COUNT(*) FROM runs WHERE stage IN ('queued', 'running') AND orphaned = 0 AND background = 0 AND abandoned = 0"
            ).fetchone()
        return int(row[0])

    def list_runs(self, limit: int = 30) -> list[RunStatus]:
        """The most recently submitted runs first, whatever their state."""
        with self._connection() as db:
            rows = db.execute(
                "SELECT * FROM runs WHERE orphaned = 0 AND abandoned = 0 ORDER BY submitted DESC LIMIT ?", (limit,)
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

    def changes(self, watched: dict[str, int]) -> tuple[list[RunStatus], list[str]]:
        """Changed runs, and watched runs that no longer exist. Durable, so it survives a reconnect."""
        with self._connection() as db:
            db.execute("BEGIN")
            statuses = []
            removed = []
            for run_id, revision in watched.items():
                row = self._find(db, run_id)
                if row is None:
                    removed.append(run_id)
                elif row["revision"] != revision:
                    statuses.append(self._status(db, row))
            return statuses, removed

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
                ORDER BY background,
                    -- Visitors' runs take turns; background runs finish one site at a time, so
                    -- the worker keeps one site's terrain loaded instead of switching every batch.
                    CASE WHEN background = 1 THEN submitted ELSE 0 END,
                    EXISTS (
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
            # Take what overlapping runs computed since this one last ran, rather than repeat it.
            self._reuse_samples(db, run_id, plan)
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
                # The closing sample is not a published snapshot, so it belongs to the samples between.
                missing_frames = (
                    index for index in range(0, plan.interval_count + 1, plan.stride)
                    if index not in computed and plan.is_frame(index)
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
            row = self._find(db, batch.run_id)
            if row is None:
                raise RunRemoved(batch.run_id)
            if row["stage"] == "paused":
                # Pausing takes effect within one sample; this sample is not saved.
                raise RunPaused(batch.run_id)
            if row["background"] and self._visitor_waiting(db):
                raise RunYielded(batch.run_id)
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

    def _status(self, db: sqlite3.Connection, row: sqlite3.Row, *, include_ready: bool = True) -> RunStatus:
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
            background=bool(row["background"]),
            progress=self._progress(db, row, plan),
        )

    def _progress(self, db: sqlite3.Connection, row: sqlite3.Row, plan: RunPlan) -> RunProgress | None:
        """Stages and time left for a waiting, running or paused run; None otherwise."""
        if row["stage"] not in ("queued", "running", "paused"):
            return None

        stages, own = self._own_estimate(db, row, plan)
        state = ProgressState.from_dict(json.loads(row["progress"] or "{}"))
        others: list[float] = []
        # Visitors' runs take turns with each other. Background runs step aside, so they are not
        # counted, and a background run's own estimate is only a guide.
        if not row["background"] and row["stage"] != "paused":
            for other in db.execute(
                """
                SELECT * FROM runs WHERE stage IN ('queued', 'running') AND background = 0
                    AND orphaned = 0 AND abandoned = 0 AND run_id != ?
                """,
                (row["run_id"],),
            ).fetchall():
                others.append(self._own_estimate(db, other, RunPlan.model_validate_json(other["plan"]))[1])

        return RunProgress(
            stages=stages,
            remaining_s=round(shared_remaining(own, others), 1),
            basis=self._model().basis,
            sharing_with=len(others),
            waiting=row["stage"] == "queued" and state.phase is None,
        )

    def _own_estimate(self, db: sqlite3.Connection, row: sqlite3.Row, plan: RunPlan):
        reused = db.execute(
            "SELECT COALESCE(SUM(samples), 0) FROM reused_samples WHERE run_id = ?", (row["run_id"],)
        ).fetchone()[0]
        site = plan.site
        return estimate(
            plan,
            completed_samples=row["completed_samples"],
            reused_samples=int(reused),
            state=ProgressState.from_dict(json.loads(row["progress"] or "{}")),
            model=self._model(),
            saved_horizon_points=saved_point_count(
                self.directory.parent / "cache" / "horizons", site_label(site.latitude_deg, site.longitude_deg)
            ),
            now_ns=time_ns(),
        )

    def _model(self):
        return load_model(self.directory.parent)


def _use_write_ahead_log(db: sqlite3.Connection) -> None:
    """Switch the database to write-ahead logging, which lets the API read while the worker writes.

    Switching needs the file to itself for a moment, and the usual wait for a lock does not apply.
    The API and the worker start together, so a switch already under way elsewhere is waited for.
    """
    for attempt in range(_WAL_ATTEMPTS):
        try:
            if db.execute("PRAGMA journal_mode").fetchone()[0] != "wal":
                db.execute("PRAGMA journal_mode = WAL")
            return
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc) or attempt == _WAL_ATTEMPTS - 1:
                raise
            sleep(0.1)

def _same_site(plan: RunPlan, latitude_deg: float, longitude_deg: float, radius_m: float) -> bool:
    site = plan.site
    return (
        abs(site.latitude_deg - latitude_deg) < 1e-9
        and abs(site.longitude_deg - longitude_deg) < 1e-9
        and site.radius_m == radius_m
    )
