"""Canonical simulation inputs and the two sampling cadences."""

import hashlib
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from math import gcd
from pathlib import Path

from pydantic import AwareDatetime, BaseModel

from ..ephemeris.states import BATCH_SIZE, KERNEL_NAMES
from ..simulation.engine import SimulationSettings, grid_half_width
from ..simulation.frames import SiteFootprint
from ..terrain.model import LOCAL_DEM_NAMES, REGIONAL_DEM_NAMES

# Change this when the solver or output meaning changes so old runs stay immutable.
MODEL_REVISION = 6
DEFAULT_INTEGRATION_MINUTES = 15
# One year at the default 15 minute cadence is 35,040 intervals.
MAX_INTERVALS = 40_000


class MissingScienceInputs(RuntimeError):
    """A required terrain or orientation file is unavailable."""


class RunPlan(BaseModel):
    """The immutable, content-addressed parameters of a run."""

    site: SiteFootprint
    settings: SimulationSettings
    start_utc: AwareDatetime
    end_utc: AwareDatetime
    snapshot_minutes: int
    integration_minutes: int
    model_revision: int
    sources_sha256: dict[str, str]

    @property
    def integration_step(self) -> timedelta:
        return timedelta(minutes=self.integration_minutes)

    @property
    def stride(self) -> int:
        return self.snapshot_minutes // self.integration_minutes

    @property
    def interval_count(self) -> int:
        return (
            self.end_utc - self.start_utc - timedelta(microseconds=1)
        ) // self.integration_step + 1

    @property
    def frame_count(self) -> int:
        return (self.interval_count - 1) // self.stride + 1

    def at(self, index: int) -> datetime:
        return min(self.start_utc + index * self.integration_step, self.end_utc)

    def ephemeris_batch(self, index: int) -> tuple[int, tuple[datetime, ...]]:
        """The first sample index and the epochs of the Horizons batch that holds sample `index`."""
        return ephemeris_batch(self.start_utc, self.end_utc, self.integration_minutes, index)

    def is_frame(self, index: int) -> bool:
        # Integration includes the endpoint. The dashboard date range is half-open.
        return 0 <= index < self.interval_count and index % self.stride == 0

    def frame_index(self, at: datetime) -> int:
        index = (at - self.start_utc) // self.integration_step
        if not self.is_frame(index) or self.at(index) != at:
            raise ValueError("Priority time must be a snapshot in the requested UTC range.")
        return index

    def identity(self) -> str:
        return hashlib.sha256(self.model_dump_json().encode()).hexdigest()

    def physics_key(self) -> str:
        """Identity of everything except the dates.

        Runs with the same key compute identical samples at identical times, so a run over a
        longer or shorter range can reuse the samples of another instead of repeating them.
        """
        everything_but_dates = self.model_dump_json(exclude={"start_utc", "end_utc"})
        return hashlib.sha256(everything_but_dates.encode()).hexdigest()


def ephemeris_batch(
    start_utc: datetime, end_utc: datetime, integration_minutes: int, index: int
) -> tuple[int, tuple[datetime, ...]]:
    """The first sample index and the epochs of the Horizons batch that holds sample `index`.

    Sample k is at start + k × cadence, and the last sample is the end of the range. Samples
    are requested from Horizons in fixed batches, so everything that uses the same dates and
    cadence (every site's run, and the 3D view) asks for identical batches and shares the
    saved replies.
    """
    step = timedelta(minutes=integration_minutes)
    interval_count = (end_utc - start_utc - timedelta(microseconds=1)) // step + 1
    if not 0 <= index <= interval_count:
        raise ValueError("The sample is outside the requested UTC range.")

    first = (index // BATCH_SIZE) * BATCH_SIZE
    stop = min(interval_count + 1, first + BATCH_SIZE)
    return first, tuple(min(start_utc + k * step, end_utc) for k in range(first, stop))


def create_plan(
    data_dir: Path,
    *,
    site: SiteFootprint,
    settings: SimulationSettings,
    start_utc: datetime,
    end_utc: datetime,
    snapshot_minutes: int,
    integration_minutes: int | None,
) -> RunPlan:
    if start_utc.utcoffset() is None or end_utc.utcoffset() is None:
        raise ValueError("Run dates need a UTC offset.")
    if snapshot_minutes < 1:
        raise ValueError("Snapshot cadence must be at least one minute.")

    grid_half_width(site, settings)
    cadence = integration_minutes or gcd(snapshot_minutes, DEFAULT_INTEGRATION_MINUTES)
    if cadence < 1 or snapshot_minutes % cadence:
        raise ValueError("Integration cadence must divide the snapshot cadence.")

    duration = end_utc - start_utc
    if duration <= timedelta(0):
        raise ValueError("End time must be after start time.")
    if duration > timedelta(minutes=cadence * MAX_INTERVALS):
        raise ValueError("The time range is too long for this integration cadence.")

    return RunPlan(
        site=site,
        settings=settings,
        start_utc=start_utc.astimezone(UTC),
        end_utc=end_utc.astimezone(UTC),
        snapshot_minutes=snapshot_minutes,
        integration_minutes=cadence,
        model_revision=MODEL_REVISION,
        sources_sha256=science_sources(data_dir),
    )


def science_sources(data_dir: Path) -> dict[str, str]:
    terrain = data_dir / "raw" / "terrain"
    spice = data_dir / "raw" / "spice"
    required = [
        *(terrain / name for name in REGIONAL_DEM_NAMES),
        *(spice / name for name in KERNEL_NAMES),
    ]
    missing = [path.name for path in required if not path.is_file()]
    if missing:
        raise MissingScienceInputs(
            f"Missing science inputs ({', '.join(missing)}). Run lunascout-science fetch-data."
        )

    optional = [path for name in LOCAL_DEM_NAMES if (path := terrain / name).is_file()]
    checksums = {}
    for path in sorted(required + optional):
        details = path.stat()
        checksums[path.relative_to(data_dir).as_posix()] = _checksum(
            path, details.st_size, details.st_mtime_ns
        )
    return checksums


@lru_cache(maxsize=32)
def _checksum(path: Path, size: int, modified_ns: int) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()
