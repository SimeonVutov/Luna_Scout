"""Run submission, streaming progress, and scientific display data."""

import asyncio
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi import Path as PathParameter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..jobs.metrics import Reading
from ..jobs.plan import MissingScienceInputs, create_plan
from ..jobs.scheduler import Provenance, RunList, RunQueue, RunStatus
from ..simulation.engine import SimulationSettings
from ..simulation.frames import SiteFootprint
from ..terrain.horizon import purge_horizons, site_label
from ..terrain.model import TerrainError
from . import site_store
from .insight import InsightService, SiteInsight
from .models import RunPriority, RunSpec, SiteSpec

RunId = Annotated[str, PathParameter(pattern=r"^[a-f0-9]{64}$")]
logger = logging.getLogger(__name__)


class GridPayload(BaseModel):
    """Row-major arrays with north increasing by row and east by column."""

    offsets_m: list[float]
    inside_site: list[bool]
    visible_sun_fraction_lower: list[float | None]
    visible_sun_fraction_upper: list[float | None]
    irradiance_lower_w_m2: list[float | None]
    irradiance_upper_w_m2: list[float | None]
    # Fraction of Earth's disk in line of sight from mast height; absent from older snapshots.
    earth_visible_fraction_lower: list[float | None] | None = None
    earth_visible_fraction_upper: list[float | None] | None = None


class PurgeResult(BaseModel):
    runs_removed: int
    runs_kept: int
    horizon_maps_removed: int


class FramePayload(BaseModel):
    reading: Reading
    grid: GridPayload


def science_router(data_dir: Path, queue: RunQueue) -> APIRouter:
    router = APIRouter(prefix="/api")
    insights = InsightService(data_dir)

    @router.post("/runs", status_code=202)
    def request_run(spec: RunSpec) -> RunStatus:
        site = (
            site_store.get_site(data_dir, spec.site_id) if spec.site_id is not None else spec.site
        )
        if site is None:
            raise HTTPException(404, "Site not found")

        try:
            footprint = SiteFootprint(site.latitude_deg, site.longitude_deg, site.radius_m)
            settings = SimulationSettings(
                grid_spacing_m=spec.grid_spacing_m,
                solar_disk_samples=spec.solar_disk_samples,
                mast_height_m=spec.mast_height_m,
                collector_height_m=spec.collector_height_m,
                receiver=spec.receiver,
                collector_tilt_deg=spec.collector_tilt_deg,
                collector_azimuth_deg=spec.collector_azimuth_deg,
                ray_method=spec.ray_method,
            )

            plan = create_plan(
                data_dir,
                site=footprint,
                settings=settings,
                start_utc=spec.start_utc,
                end_utc=spec.end_utc,
                snapshot_minutes=spec.snapshot_minutes,
                integration_minutes=spec.integration_minutes,
            )

            return queue.submit(plan, spec.priority_utc)
        except MissingScienceInputs as exc:
            raise HTTPException(503, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.get("/runs")
    def list_runs(limit: Annotated[int, Query(ge=1, le=100)] = 30) -> RunList:
        """Recent runs and the worker's state, so the dashboard can show what is happening."""
        return RunList(worker=queue.worker_status(), runs=queue.list_runs(limit))

    @router.delete("/runs/site")
    def purge_site_data(
        latitude_deg: float, longitude_deg: float, radius_m: float, keep: bool = False
    ) -> PurgeResult:
        """Free the space a deleted site used.

        With `keep`, the results and horizon maps are retained so the site can be restored when
        it comes back, and a restore later discards whatever falls outside its timeline. Without
        it, everything of the site is removed.
        """
        if keep:
            return PurgeResult(
                runs_removed=0, runs_kept=queue.keep_site(latitude_deg, longitude_deg, radius_m), horizon_maps_removed=0
            )

        runs = queue.purge_site(latitude_deg, longitude_deg, radius_m)
        maps = purge_horizons(data_dir / "cache" / "horizons", site_label(latitude_deg, longitude_deg, radius_m))
        return PurgeResult(runs_removed=runs, runs_kept=0, horizon_maps_removed=maps)

    @router.put("/runs/priority", status_code=204)
    def prioritize(spec: RunPriority) -> None:
        try:
            queue.set_priority(spec.run_ids, spec.at_utc)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.get("/runs/events")
    async def events(
        request: Request, run_id: Annotated[list[str], Query(min_length=1, max_length=50)]
    ) -> StreamingResponse:
        async def updates() -> AsyncIterator[str]:
            versions = dict.fromkeys(run_id, -1)
            loops = 0
            while not await request.is_disconnected():
                statuses = await asyncio.to_thread(queue.changes, versions)
                for status in statuses:
                    versions[status.run_id] = status.revision
                    yield f"data: {status.model_dump_json()}\n\n"
                if loops % 15 == 0:
                    yield ": keep-alive\n\n"
                loops += 1
                await asyncio.sleep(1)

        return StreamingResponse(
            updates(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.get("/runs/{run_id}")
    def run_status(run_id: RunId) -> RunStatus:
        status = queue.status(run_id)
        if status is None:
            raise HTTPException(404, "Run not found")
        return status

    @router.get("/runs/{run_id}/series")
    def run_series(run_id: RunId) -> list[Reading]:
        if queue.status(run_id) is None:
            raise HTTPException(404, "Run not found")
        return queue.readings(run_id, frames_only=True)

    @router.get("/runs/{run_id}/provenance")
    def run_provenance(run_id: RunId) -> Provenance:
        provenance = queue.provenance(run_id)
        if provenance is None:
            raise HTTPException(404, "Run not found")
        return provenance

    @router.get("/runs/{run_id}/snapshots/{index}")
    def snapshot(run_id: RunId, index: Annotated[int, PathParameter(ge=0)]) -> FramePayload:
        entry = queue.frame(run_id, index)
        if entry is None:
            raise HTTPException(404, "This snapshot is not ready.")
        reading, path = entry
        try:
            with np.load(path, allow_pickle=False) as grid:
                payload = GridPayload(
                    offsets_m=grid["offsets_m"].tolist(),
                    inside_site=grid["inside_site"].ravel().tolist(),
                    visible_sun_fraction_lower=_nullable(grid["visible_sun_fraction_lower"]),
                    visible_sun_fraction_upper=_nullable(grid["visible_sun_fraction_upper"]),
                    irradiance_lower_w_m2=_nullable(grid["irradiance_lower_w_m2"]),
                    irradiance_upper_w_m2=_nullable(grid["irradiance_upper_w_m2"]),
                    earth_visible_fraction_lower=_optional(grid, "earth_visible_fraction_lower"),
                    earth_visible_fraction_upper=_optional(grid, "earth_visible_fraction_upper"),
                )
        except (OSError, ValueError, KeyError) as exc:
            logger.exception("Could not read a published snapshot of run %s", run_id)
            raise HTTPException(500, "The saved snapshot could not be read.") from exc
        return FramePayload(reading=reading, grid=payload)

    @router.post("/terrain/insight")
    def terrain_insight(
        spec: SiteSpec,
        grid_spacing_m: Annotated[float, Query(gt=0)] = 20,
        collector_height_m: Annotated[float, Query(ge=0)] = 2,
        mast_height_m: Annotated[float, Query(ge=0)] = 2,
    ) -> SiteInsight:
        """Terrain detail, slope and skyline for a site. Independent of time."""
        try:
            site = SiteFootprint(spec.latitude_deg, spec.longitude_deg, spec.radius_m)
            settings = SimulationSettings(
                grid_spacing_m=grid_spacing_m,
                collector_height_m=collector_height_m,
                mast_height_m=mast_height_m,
            )
            return insights.insight(site, settings)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except TerrainError as exc:
            logger.warning("Terrain insight unavailable: %s", exc)
            if str(exc).startswith("Missing regional LOLA"):
                raise HTTPException(
                    503, "Download the terrain with lunascout-science fetch-data."
                ) from exc
            raise HTTPException(422, str(exc)) from exc

    return router


def _optional(grid, name: str) -> list[float | None] | None:
    return _nullable(grid[name]) if name in grid.files else None


def _nullable(array: np.ndarray) -> list[float | None]:
    values = array.astype(object)
    values[~np.isfinite(array)] = None
    return values.ravel().tolist()
