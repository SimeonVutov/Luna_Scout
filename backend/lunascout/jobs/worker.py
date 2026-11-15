"""Run pending lunar simulations in a dedicated process."""

import argparse
import logging
import os
import sqlite3
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from time import perf_counter, sleep

import numpy as np
from filelock import FileLock, Timeout

from ..ephemeris.horizons import (
    BATCH_SIZE,
    Ephemerides,
    EphemerisError,
    EphemerisSample,
    HorizonsUnavailable,
    load_ephemerides_at,
)
from ..simulation.engine import (
    PreparedSite,
    SimulationSettings,
    SnapshotGrid,
    prepare_site,
    trace_snapshot,
)
from ..simulation.events import centre_windows
from ..simulation.frames import SiteFootprint
from ..simulation.rays import site_ray_arrays
from ..terrain.horizon import (
    HorizonMap,
    load_or_build_horizons,
    read_cached_horizons,
    site_label,
)
from ..terrain.model import TerrainError, prepare_terrain
from .metrics import Reading, integrate
from .plan import MODEL_REVISION, MissingScienceInputs, RunPlan, science_sources
from .scheduler import EphemerisChunk, RunQueue, RunRemoved, WorkBatch

# A batch is long enough to amortise preparing a site's terrain when several sites take turns.
_BATCH_SIZE = 96
_DEFAULT_DATA_DIR = Path(__file__).resolve().parents[3] / "DATA"
# Waits before retrying a run whose Horizons request failed transiently.
_HORIZONS_RETRY_DELAYS_S = (15, 60, 180)
_HORIZON_MAPS_IN_MEMORY = 6
# Results kept for a deleted reference site are dropped if the site does not return in this time.
KEPT_RESULTS_LIFETIME = timedelta(days=14)
logger = logging.getLogger(__name__)

SourceRevision = tuple[tuple[str, str], ...]


class Worker:
    def __init__(self, data_dir: Path, queue: RunQueue) -> None:
        self.data_dir = data_dir
        self.queue = queue
        self.horizon_cache_dir = data_dir / "cache" / "horizons"
        self._horizon_maps: dict[tuple[SiteFootprint, SimulationSettings, SourceRevision], HorizonMap] = {}

    def process(self, batch: WorkBatch) -> None:
        plan = batch.plan
        sources = science_sources(self.data_dir)
        if plan.model_revision != MODEL_REVISION or plan.sources_sha256 != sources:
            raise ValueError("The science inputs changed. Submit a run with the new inputs.")

        source_revision = tuple(sources.items())
        self.queue.set_activity(batch.run_id, "Preparing terrain")
        prepared = self._prepared(plan.site, plan.settings, source_revision)
        if not batch.indices:
            self._complete(batch.run_id, plan, prepared)
            return

        horizons = self._horizons(batch.run_id, plan, prepared, source_revision, batch.playhead_only)
        self.queue.set_activity(batch.run_id, "Computing snapshots")
        for index in batch.indices:
            start, epochs = plan.ephemeris_batch(index)
            stop = start + len(epochs)
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

            snapshot = trace_snapshot(prepared, ephemerides.samples[index - start], horizons)
            if plan.is_frame(index):
                path = self.queue.frame_path(batch.run_id, index)
                # The rays drawn in the 3D view are saved with the frame, so showing them
                # later needs no terrain and follows the timeline instantly.
                rays = site_ray_arrays(prepared, ephemerides.samples[index - start], plan.settings.solar_disk_samples)
                _save_grid(path, snapshot.grid, rays)

            reading = Reading.model_validate(snapshot, from_attributes=True)
            self.queue.record(batch, index, reading)

    def _complete(self, run_id: str, plan: RunPlan, prepared: PreparedSite) -> None:
        """Find exact centre windows over the run, integrate, and publish the summary."""
        started = perf_counter()
        self.queue.set_activity(run_id, "Finding sunrise and sunset times")
        windows = centre_windows(prepared, self._run_samples(plan))
        readings = self.queue.readings(run_id)
        self.queue.complete(run_id, integrate(readings, windows))
        logger.info("Completed run %.12s (centre windows in %.1f s)", run_id, perf_counter() - started)

    def _horizons(
        self,
        run_id: str,
        plan: RunPlan,
        prepared: PreparedSite,
        source_revision: SourceRevision,
        playhead_only: bool,
    ) -> HorizonMap | None:
        """The run's horizon map, or None to trace every ray directly.

        The playhead's first result is traced directly while no map exists yet, so
        the dashboard does not wait for the one-off horizon build.
        """
        if plan.settings.ray_method == "direct" or not len(prepared.solar_origins_m):
            return None

        key = (plan.site, plan.settings, source_revision)
        if key in self._horizon_maps:
            return self._horizon_maps[key]

        terrain, origins_m = prepared.terrain, prepared.solar_origins_m
        horizons = read_cached_horizons(terrain, origins_m, self.horizon_cache_dir)
        if horizons is None:
            if playhead_only:
                return None
            started = perf_counter()
            self.queue.set_activity(run_id, "Building terrain horizons (one time per site, about a minute)")
            site = plan.site
            horizons = load_or_build_horizons(
                terrain, origins_m, self.horizon_cache_dir,
                site_label(site.latitude_deg, site.longitude_deg, site.radius_m),
            )
            logger.info(
                "Built terrain horizons for %d receivers in %.1f s",
                len(origins_m),
                perf_counter() - started,
            )

        if len(self._horizon_maps) >= _HORIZON_MAPS_IN_MEMORY:
            self._horizon_maps.pop(next(iter(self._horizon_maps)))
        self._horizon_maps[key] = horizons
        return horizons

    def _run_samples(self, plan: RunPlan) -> list[EphemerisSample]:
        """All integration epochs, loaded in the same cached batches used while processing."""
        samples: list[EphemerisSample] = []
        for start in range(0, plan.interval_count + 1, BATCH_SIZE):
            _, epochs = plan.ephemeris_batch(start)
            samples.extend(self._ephemerides(epochs).samples)
        return samples

    @lru_cache(maxsize=2)
    def _prepared(
        self,
        site: SiteFootprint,
        settings: SimulationSettings,
        _source_revision: SourceRevision,
    ) -> PreparedSite:
        """Reuse receiver geometry only for matching settings and source revisions."""
        terrain = prepare_terrain(self.data_dir, site)
        return prepare_site(site, terrain, settings)

    @lru_cache(maxsize=8)
    def _ephemerides(self, epochs: tuple[datetime, ...]) -> Ephemerides:
        return load_ephemerides_at(epochs, data_dir=self.data_dir, correction="LT+S")


def _save_grid(path: Path, grid: SnapshotGrid, rays: dict[str, np.ndarray]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=path.parent) as temporary:
        staging = Path(temporary) / path.name
        np.savez_compressed(staging, **vars(grid), **rays)
        staging.replace(path)


def _report_alive(queue: RunQueue, stop: Event) -> None:
    """Tell the dashboard the worker is alive every two seconds, even during a long batch."""
    while True:
        try:
            queue.beat(os.getpid())
        except sqlite3.Error:
            # A busy database must not end the heartbeat; the next beat will get through.
            logger.warning("Could not report that the worker is alive.", exc_info=True)
        if stop.wait(2.0):
            return


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
    removed = queue.prune_kept(KEPT_RESULTS_LIFETIME)
    if removed:
        logger.info("Removed %d kept runs of sites that were deleted more than %s ago.", removed, KEPT_RESULTS_LIFETIME)
    worker = Worker(args.data_dir, queue)
    horizons_retries: dict[str, int] = {}
    lock = FileLock(queue.directory / "worker.lock", timeout=0)
    stop_beating = Event()
    owns_lock = False
    try:
        with lock:
            owns_lock = True
            logger.info("Worker listening in %s", queue.directory)
            Thread(target=_report_alive, args=(queue, stop_beating), daemon=True).start()
            while True:
                batch = queue.next_batch(_BATCH_SIZE)
                if batch is None:
                    if args.until_idle:
                        return
                    sleep(0.5)
                    continue
                try:
                    worker.process(batch)
                    queue.set_activity(None, None)
                    horizons_retries.pop(batch.run_id, None)
                except RunRemoved:
                    # The run was deleted with its site while this batch was computing.
                    logger.info("Run %.12s was removed; dropping its remaining work.", batch.run_id)
                    queue.set_activity(None, None)
                except HorizonsUnavailable as exc:
                    # Saved samples stay recorded, so a later attempt resumes the run.
                    attempt = horizons_retries.get(batch.run_id, 0)
                    if attempt < len(_HORIZONS_RETRY_DELAYS_S):
                        horizons_retries[batch.run_id] = attempt + 1
                        delay = _HORIZONS_RETRY_DELAYS_S[attempt]
                        logger.warning(
                            "Run %.12s: %s Retrying in %d s (attempt %d of %d).",
                            batch.run_id,
                            exc,
                            delay,
                            attempt + 1,
                            len(_HORIZONS_RETRY_DELAYS_S),
                            exc_info=exc.__cause__ is not None,
                        )
                        sleep(delay)
                        continue

                    horizons_retries.pop(batch.run_id, None)
                    logger.warning("Run %.12s failed: %s", batch.run_id, exc, exc_info=True)
                    queue.fail(
                        batch.run_id,
                        f"{exc} Saved snapshots are kept; retry the run to resume it.",
                    )
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
    finally:
        # A rejected second worker must not mark the real one as stopped.
        if owns_lock:
            stop_beating.set()
            queue.stop_beating()


if __name__ == "__main__":
    main()
