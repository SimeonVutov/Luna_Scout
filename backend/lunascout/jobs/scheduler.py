"""Persist runs and choose short, fair batches for the science worker."""

import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import datetime
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


class EphemerisChunk(BaseModel):
    from_utc: datetime
    through_utc: datetime
    frame: str
    correction: Correction
    api_versions: tuple[str, ...]
    planetary_ephemerides: tuple[str, ...]
    response_sha256: tuple[str, ...]
    kernels_sha256: dict[str, str]


class Provenance(BaseModel):
    plan: RunPlan
    ephemeris_chunks: list[EphemerisChunk]


@dataclass(frozen=True)
class WorkBatch:
    run_id: str
    plan: RunPlan
    indices: tuple[int, ...]


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
                CREATE TABLE IF NOT EXISTS ephemeris_chunks (
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    start_index INTEGER NOT NULL,
                    provenance TEXT NOT NULL,
                    PRIMARY KEY (run_id, start_index)
                );
            """)

    def submit(self, plan: RunPlan, priority_at: datetime | None = None) -> RunStatus:
        """Reuse identical inputs. A failed run can resume its remaining samples."""
        index = plan.frame_index(priority_at) if priority_at is not None else 0
        run_id = plan.identity()
        with self._connection() as db:
            db.execute(
                """
                INSERT INTO runs (run_id, plan, priority_index, submitted) VALUES (?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    priority_index = excluded.priority_index,
                    message = NULL,
                    stage = CASE WHEN runs.stage = 'failed' THEN 'queued' ELSE runs.stage END,
                    revision = runs.revision + CASE WHEN runs.stage = 'failed' THEN 1 ELSE 0 END
                WHERE runs.stage != 'complete'
                """,
                (run_id, plan.model_dump_json(), index, time_ns()),
            )
            row = self._find(db, run_id)
            if row is None:
                raise RuntimeError("Could not read the submitted run.")
            return self._status(db, row)

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
                SELECT * FROM runs AS run WHERE stage IN ('queued', 'running')
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
            if priority not in computed:
                indices = (priority,)
            else:
                remaining = (
                    index for index in range(plan.interval_count + 1) if index not in computed
                )
                frame_first = sorted(
                    remaining, key=lambda index: (not plan.is_frame(index), index)
                )
                indices = tuple(frame_first[:batch_size])

            db.execute(
                """
                UPDATE runs SET stage = 'running', last_served = ?,
                    revision = revision + CASE WHEN stage = 'queued' THEN 1 ELSE 0 END
                WHERE run_id = ?
                """,
                (time_ns(), run_id),
            )
            return WorkBatch(run_id, plan, indices)

    def record(self, batch: WorkBatch, index: int, reading: Reading) -> None:
        with self._connection() as db:
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
            return Provenance(
                plan=RunPlan.model_validate_json(row["plan"]),
                ephemeris_chunks=[EphemerisChunk.model_validate_json(chunk[0]) for chunk in chunks],
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
    def _status(db: sqlite3.Connection, row: sqlite3.Row) -> RunStatus:
        plan = RunPlan.model_validate_json(row["plan"])
        samples = [
            item[0]
            for item in db.execute(
                "SELECT sample_index FROM readings WHERE run_id = ? AND is_frame = 1 ORDER BY sample_index",
                (row["run_id"],),
            )
        ]
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
        )
