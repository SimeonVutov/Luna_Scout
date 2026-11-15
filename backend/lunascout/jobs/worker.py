"""Run pending lunar simulations in a dedicated process."""

import argparse
import logging
import os
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory
from time import sleep

import numpy as np
from filelock import FileLock, Timeout

from ..ephemeris.horizons import (
    BATCH_SIZE,
    Ephemerides,
    EphemerisError,
    load_ephemerides_at,
)
from ..simulation.engine import (
    PreparedSite,
    SimulationSettings,
    SnapshotGrid,
    prepare_site,
    trace_snapshot,
)
from ..simulation.frames import SiteFootprint
from ..terrain.model import TerrainError, prepare_terrain
from .metrics import Reading, integrate
from .plan import MODEL_REVISION, MissingScienceInputs, science_sources
from .scheduler import EphemerisChunk, RunQueue, WorkBatch

_BATCH_SIZE = 3
_DEFAULT_DATA_DIR = Path(__file__).resolve().parents[3] / "DATA"
logger = logging.getLogger(__name__)


class Worker:
    def __init__(self, data_dir: Path, queue: RunQueue) -> None:
        self.data_dir = data_dir
        self.queue = queue

    def process(self, batch: WorkBatch) -> None:
        plan = batch.plan
        sources = science_sources(self.data_dir)
        if plan.model_revision != MODEL_REVISION or plan.sources_sha256 != sources:
            raise ValueError("The science inputs changed. Submit a run with the new inputs.")

        if not batch.indices:
            readings = self.queue.readings(batch.run_id)
            self.queue.complete(batch.run_id, integrate(readings))
            logger.info("Completed run %.12s", batch.run_id)
            return

        prepared = self._prepared(plan.site, plan.settings, tuple(sources.items()))
        for index in batch.indices:
            start = (index // BATCH_SIZE) * BATCH_SIZE
            stop = min(plan.interval_count + 1, start + BATCH_SIZE)
            epochs = tuple(plan.at(index) for index in range(start, stop))
            ephemerides = self._ephemerides(epochs)

            self.queue.record_ephemeris(
                batch.run_id,
                start,
                EphemerisChunk(
                    from_utc=plan.at(start),
                    through_utc=plan.at(stop - 1),
                    frame=ephemerides.frame,
                    correction=ephemerides.correction,
                    api_versions=ephemerides.horizons_api_versions,
                    planetary_ephemerides=ephemerides.ephemeris_sources,
                    response_sha256=ephemerides.response_sha256,
                    kernels_sha256=ephemerides.kernels_sha256,
                ),
            )

            snapshot = trace_snapshot(prepared, ephemerides.samples[index - start])
            if plan.is_frame(index):
                path = self.queue.frame_path(batch.run_id, index)
                _save_grid(path, snapshot.grid)

            reading = Reading.model_validate(snapshot, from_attributes=True)
            self.queue.record(batch, index, reading)

    @lru_cache(maxsize=2)
    def _prepared(
        self,
        site: SiteFootprint,
        settings: SimulationSettings,
        _source_revision: tuple[tuple[str, str], ...],
    ) -> PreparedSite:
        """Reuse receiver geometry only for matching settings and source revisions."""
        terrain = prepare_terrain(self.data_dir, site)
        return prepare_site(site, terrain, settings)

    @lru_cache(maxsize=8)
    def _ephemerides(self, epochs: tuple[datetime, ...]) -> Ephemerides:
        return load_ephemerides_at(epochs, data_dir=self.data_dir, correction="LT+S")


def _save_grid(path: Path, grid: SnapshotGrid) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=path.parent) as temporary:
        staging = Path(temporary) / path.name
        np.savez_compressed(staging, **vars(grid))
        staging.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(os.environ.get("LUNASCOUT_DATA_DIR", _DEFAULT_DATA_DIR)),
    )
    parser.add_argument("--until-idle", action="store_true", help="Drain pending work and exit.")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    queue = RunQueue(args.data_dir)
    queue.initialize()
    worker = Worker(args.data_dir, queue)
    lock = FileLock(queue.directory / "worker.lock", timeout=0)
    try:
        with lock:
            logger.info("Worker listening in %s", queue.directory)
            while True:
                batch = queue.next_batch(_BATCH_SIZE)
                if batch is None:
                    if args.until_idle:
                        return
                    sleep(0.5)
                    continue
                try:
                    worker.process(batch)
                except (EphemerisError, TerrainError, MissingScienceInputs, ValueError) as exc:
                    # Keep the chained cause (DNS, TLS, timeout, HTTP) in the log;
                    # the queue message stays short for the dashboard.
                    logger.warning(
                        "Run %.12s failed at samples %s: %s",
                        batch.run_id,
                        batch.indices,
                        exc,
                        exc_info=exc.__cause__ is not None,
                    )
                    queue.fail(batch.run_id, str(exc))
                except Exception:
                    logger.exception("Unexpected failure for run %.12s", batch.run_id)
                    queue.fail(batch.run_id, "Simulation failed. See the science worker log.")
    except Timeout:
        parser.exit(1, "A science worker is already running in this data directory.\n")
    except KeyboardInterrupt:
        logger.info("Worker stopped. Saved samples will be reused on restart.")


if __name__ == "__main__":
    main()
