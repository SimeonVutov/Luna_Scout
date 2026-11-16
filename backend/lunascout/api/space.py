"""Data for the 3D view: elevation tiles, Sun and Earth positions, and the centre rays."""

import asyncio
import logging
import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Annotated

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi import Path as PathParameter
from pydantic import AwareDatetime, BaseModel, Field

from ..jobs.scheduler import RunQueue
from ..ephemeris.states import EphemerisError, EphemerisSample, load_ephemerides_at
from ..jobs.plan import ephemeris_batch
from ..simulation.engine import (
    Bounds,
    PreparedSite,
    SimulationSettings,
    Visibility,
    place_centre_instruments,
    prepare_site,
)
from ..simulation.frames import SiteFootprint
from ..simulation.rays import RayFan, centre_ray_fans, fans_from_arrays, site_ray_arrays
from ..terrain import mesh
from ..terrain.model import Terrain, TerrainError, prepare_terrain
from ..terrain.tiles import MAX_TILE_LEVEL, load_tile
from .models import SiteSpec

logger = logging.getLogger(__name__)

Vector = tuple[float, float, float]
_STATUS_LABEL: dict[int, Visibility] = {
    mesh.CLEAR: "clear",
    mesh.BLOCKED: "blocked",
    mesh.UNKNOWN: "unknown",
}
# A site's terrain takes a few hundred megabytes; a few recent sites stay loaded so switching back is instant.
_TERRAINS_IN_MEMORY = 3
_PREPARED_SITES_IN_MEMORY = 2
_EPHEMERIS_BATCHES_IN_MEMORY = 16


class SkySample(BaseModel):
    """Moon-centred positions in the Moon-fixed terrain frame, in metres."""

    at_utc: datetime
    sun_m: Vector
    earth_m: Vector


class SkyBatch(BaseModel):
    """Consecutive samples of a time range, starting at sample `first_index`."""

    first_index: int
    frame: str
    samples: list[SkySample]


class RaysSpec(BaseModel):
    """A site, the sample of a time range to show, and the instrument settings."""

    site: SiteSpec
    start_utc: AwareDatetime
    end_utc: AwareDatetime
    integration_minutes: int = Field(gt=0)
    index: int = Field(ge=0)
    solar_disk_samples: int = Field(default=37, gt=0, le=400)
    mast_height_m: float = Field(default=2, ge=0)
    collector_height_m: float = Field(default=2, ge=0)
    # Also return Sun rays from a subset of the site's reporting points, as the simulation traces.
    whole_site: bool = False
    grid_spacing_m: float = Field(default=20, gt=0)
    max_points: int = Field(default=40, ge=1, le=120)


class RayFanPayload(BaseModel):
    """Rays from one instrument toward a body's disk. Lists share the ray order."""

    origin_m: Vector
    body_m: Vector
    directions: list[Vector]
    statuses: list[Visibility]
    # Distance to the terrain that blocks the ray; null when clear or not resolved.
    hit_distances_m: list[float | None]
    visible_fraction: Bounds


class SiteRays(BaseModel):
    at_utc: datetime
    # The Sun's disk seen from the collector, and Earth's disk seen from the mast.
    sun: RayFanPayload
    earth: RayFanPayload
    # Sun fans from a subset of the site's reporting points; empty unless `whole_site`.
    sun_points: list[RayFanPayload] = []
    # Earth fans from the same points at mast height; an illustration, as the simulation
    # reports Earth only at the centre mast.
    earth_points: list[RayFanPayload] = []


class RunRays(BaseModel):
    """Rays from a subset of the site's points toward the Sun and Earth for one snapshot."""

    at_utc: datetime
    sun_points: list[RayFanPayload]
    earth_points: list[RayFanPayload]


class _SkyService:
    """Keep recent Sun and Earth batches and site terrain, and reuse them between requests."""

    def __init__(self, data_dir: Path) -> None:
        self._data_dir = data_dir
        self.lock = Lock()
        self._batches: OrderedDict[tuple[datetime, ...], tuple[EphemerisSample, ...]] = OrderedDict()
        self._terrains: OrderedDict[SiteFootprint, Terrain] = OrderedDict()
        self.prepared: OrderedDict[tuple[SiteFootprint, SimulationSettings], PreparedSite] = OrderedDict()

    def batch(
        self, start_utc: datetime, end_utc: datetime, integration_minutes: int, index: int
    ) -> tuple[int, tuple[EphemerisSample, ...]]:
        """The batch of positions that holds sample `index`, identical to the one a run uses."""
        first, epochs = ephemeris_batch(start_utc, end_utc, integration_minutes, index)
        with self.lock:
            samples = self._batches.get(epochs)
        if samples is None:
            samples = load_ephemerides_at(epochs, data_dir=self._data_dir, correction="LT+S").samples
            with self.lock:
                self._batches[epochs] = samples
                while len(self._batches) > _EPHEMERIS_BATCHES_IN_MEMORY:
                    self._batches.popitem(last=False)
        return first, samples

    def terrain(self, site: SiteFootprint) -> Terrain:
        # Preparing under the lock stops two requests from loading the same grids twice.
        with self.lock:
            terrain = self._terrains.get(site)
            if terrain is None:
                terrain = prepare_terrain(self._data_dir, site)
                self._terrains[site] = terrain
                while len(self._terrains) > _TERRAINS_IN_MEMORY:
                    self._terrains.popitem(last=False)
            return terrain


def _prepared_site(service: "_SkyService", site: SiteFootprint, settings: SimulationSettings) -> PreparedSite:
    """The site's reporting grid, remembered because placing thousands of receivers takes seconds."""
    key = (site, settings)
    with service.lock:
        if key in service.prepared:
            service.prepared.move_to_end(key)
            return service.prepared[key]

    prepared = prepare_site(site, service.terrain(site), settings)
    with service.lock:
        service.prepared[key] = prepared
        while len(service.prepared) > _PREPARED_SITES_IN_MEMORY:
            service.prepared.popitem(last=False)
    return prepared


def _tile_pool() -> ProcessPoolExecutor:
    """Processes that cut elevation tiles in parallel.

    Reading and resampling a tile holds the interpreter, so threads would build one tile at a
    time. Separate processes build several at once, leaving cores for the simulation worker.
    """
    workers = max(2, min(6, (os.cpu_count() or 4) // 2))
    return ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn"))


def space_router(data_dir: Path, queue: RunQueue) -> APIRouter:
    router = APIRouter(prefix="/api")
    service = _SkyService(data_dir)
    tiles = _tile_pool()

    @router.get("/terrain/tiles/{level}/{row}/{column}")
    async def elevation_tile(
        level: Annotated[int, PathParameter(ge=0, le=MAX_TILE_LEVEL)],
        row: Annotated[int, PathParameter(ge=0)],
        column: Annotated[int, PathParameter(ge=0)],
    ) -> Response:
        """LOLA heights of one south-polar tile as little-endian float32, north to south."""
        try:
            payload = await asyncio.get_running_loop().run_in_executor(
                tiles, load_tile, data_dir, level, row, column
            )
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        except TerrainError as exc:
            logger.warning("Elevation tile unavailable: %s", exc)
            raise HTTPException(503, "Download the terrain with lunascout-science fetch-data.") from exc
        # A tile never changes while the elevation files stay the same.
        return Response(payload, media_type="application/octet-stream", headers={"Cache-Control": "max-age=86400"})

    @router.get("/sky")
    def sky(
        start_utc: AwareDatetime,
        end_utc: AwareDatetime,
        integration_minutes: Annotated[int, Query(gt=0)],
        index: Annotated[int, Query(ge=0)],
    ) -> SkyBatch:
        """Sun and Earth positions for the batch of samples around sample `index`."""
        first, samples = _load_batch(service, start_utc, end_utc, integration_minutes, index)
        return SkyBatch(
            first_index=first,
            frame=samples[0].frame,
            samples=[
                SkySample(at_utc=sample.at_utc, sun_m=_vector(sample.sun_m), earth_m=_vector(sample.earth_m))
                for sample in samples
            ],
        )

    @router.get("/runs/{run_id}/rays/{index}")
    def run_rays(
        run_id: Annotated[str, PathParameter(pattern=r"^[a-f0-9]{64}$")],
        index: Annotated[int, PathParameter(ge=0)],
    ) -> RunRays:
        """The 3D view's rays for one published snapshot, saved by the worker with the frame."""
        entry = queue.frame(run_id, index)
        status = queue.status(run_id)
        if entry is None or status is None:
            raise HTTPException(404, "This snapshot is not ready.")

        _, path = entry
        try:
            with np.load(path, allow_pickle=False) as saved:
                arrays = {name: saved[name] for name in saved.files if name.startswith("ray_")}
        except (OSError, ValueError) as exc:
            raise HTTPException(500, "The saved snapshot could not be read.") from exc
        if not arrays:
            raise HTTPException(404, "This snapshot was saved without rays.")

        plan = status.plan
        sample_index = index * plan.stride
        first, samples = _load_batch(service, plan.start_utc, plan.end_utc, plan.integration_minutes, sample_index)
        ephemeris = samples[sample_index - first]
        return RunRays(
            at_utc=ephemeris.at_utc,
            sun_points=[_fan_payload(fan) for fan in fans_from_arrays(arrays, "sun", ephemeris.sun_m)],
            earth_points=[_fan_payload(fan) for fan in fans_from_arrays(arrays, "earth", ephemeris.earth_m)],
        )

    @router.post("/terrain/rays")
    def site_rays(spec: RaysSpec) -> SiteRays:
        """Trace the Sun and Earth disk rays at a site's centre for one sample time."""
        first, samples = _load_batch(
            service, spec.start_utc, spec.end_utc, spec.integration_minutes, spec.index
        )
        ephemeris = samples[spec.index - first]
        try:
            site = SiteFootprint(spec.site.latitude_deg, spec.site.longitude_deg, spec.site.radius_m)
            settings = SimulationSettings(
                solar_disk_samples=spec.solar_disk_samples,
                mast_height_m=spec.mast_height_m,
                collector_height_m=spec.collector_height_m,
                grid_spacing_m=spec.grid_spacing_m,
            )
            terrain = service.terrain(site)
            instruments = place_centre_instruments(site, terrain, settings)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except TerrainError as exc:
            logger.warning("Site rays unavailable: %s", exc)
            raise HTTPException(503, "Download the terrain with lunascout-science fetch-data.") from exc
        if instruments is None:
            raise HTTPException(422, "There is no elevation data at the centre of this site.")

        sun, earth = centre_ray_fans(terrain, instruments, ephemeris, spec.solar_disk_samples)
        points: list[RayFan] = []
        earth_points: list[RayFan] = []
        if spec.whole_site:
            try:
                prepared = _prepared_site(service, site, settings)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            arrays = site_ray_arrays(prepared, ephemeris, spec.solar_disk_samples, spec.max_points)
            if arrays:
                points = fans_from_arrays(arrays, "sun", ephemeris.sun_m)
                earth_points = fans_from_arrays(arrays, "earth", ephemeris.earth_m)
        return SiteRays(
            at_utc=ephemeris.at_utc,
            sun=_fan_payload(sun),
            earth=_fan_payload(earth),
            sun_points=[_fan_payload(fan) for fan in points],
            earth_points=[_fan_payload(fan) for fan in earth_points],
        )

    return router


def _load_batch(
    service: _SkyService, start_utc: datetime, end_utc: datetime, integration_minutes: int, index: int
) -> tuple[int, tuple[EphemerisSample, ...]]:
    if end_utc <= start_utc:
        raise HTTPException(422, "end_utc must be after start_utc")
    try:
        return service.batch(start_utc, end_utc, integration_minutes, index)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except EphemerisError as exc:
        logger.warning("Sun and Earth positions unavailable: %s", exc)
        raise HTTPException(503, str(exc)) from exc


def _vector(values: np.ndarray) -> Vector:
    return (float(values[0]), float(values[1]), float(values[2]))


def _fan_payload(fan: RayFan) -> RayFanPayload:
    return RayFanPayload(
        origin_m=_vector(fan.origin_m),
        body_m=_vector(fan.body_m),
        directions=[_vector(direction) for direction in fan.directions],
        statuses=[_STATUS_LABEL[int(status)] for status in fan.statuses],
        hit_distances_m=[
            float(distance) if np.isfinite(distance) else None for distance in fan.hit_distances_m
        ],
        visible_fraction=fan.visible_fraction,
    )
