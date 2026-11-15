"""NASA long-term context maps for a site, as a grid for drawing and as summary numbers."""

import logging
from collections import OrderedDict
from pathlib import Path
from threading import Lock

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..simulation.engine import SimulationSettings, grid_half_width
from ..simulation.frames import FloatArray, SiteFootprint, site_directions
from ..terrain.context_maps import CONTEXT_FILES, polar_xy_m, sample_context_map
from .models import SiteSpec

logger = logging.getLogger(__name__)
_CACHED_SITES = 24


class ContextSummary(BaseModel):
    """Area-weighted means over the site. Null where a map has no data there."""

    average_sunlight: float | None
    average_earth: float | None
    # Share of the site that never sees the Sun.
    permanent_shadow_share: float | None
    sky_openness: float | None
    # Posting in metres of the file each value came from; null where there was none.
    posting_m: dict[str, float | None]


class SiteContext(BaseModel):
    """Row-major arrays like a snapshot grid: north increases by row and east by column."""

    offsets_m: list[float]
    inside_site: list[bool]
    average_sunlight: list[float | None]
    average_earth: list[float | None]
    permanent_shadow: list[float | None]
    sky_openness: list[float | None]
    summary: ContextSummary


def context_router(data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api")
    lock = Lock()
    cache: OrderedDict[tuple[SiteFootprint, float], SiteContext] = OrderedDict()

    @router.post("/terrain/context")
    def terrain_context(spec: SiteSpec, grid_spacing_m: float = Query(20, gt=0)) -> SiteContext:
        """NASA's long-term illumination, Earth visibility, shadow and sky maps over a site."""
        try:
            site = SiteFootprint(spec.latitude_deg, spec.longitude_deg, spec.radius_m)
            key = (site, grid_spacing_m)
            with lock:
                if key in cache:
                    cache.move_to_end(key)
                    return cache[key]

            if not (data_dir / "raw" / "context").is_dir():
                raise HTTPException(503, "Download the NASA maps with lunascout-science fetch-data.")
            result = _compute(data_dir, site, grid_spacing_m)
            with lock:
                cache[key] = result
                while len(cache) > _CACHED_SITES:
                    cache.popitem(last=False)
            return result
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    return router


def _compute(data_dir: Path, site: SiteFootprint, grid_spacing_m: float) -> SiteContext:
    # The same reporting grid the simulation uses, so these maps line up with its results.
    half_width = grid_half_width(site, SimulationSettings(grid_spacing_m=grid_spacing_m))
    offsets = np.arange(-half_width, half_width + 1, dtype=np.float64) * grid_spacing_m
    east_m, north_m = np.meshgrid(offsets, offsets)
    inside = np.hypot(east_m, north_m) <= site.radius_m
    directions, weights = site_directions(site, east_m[inside], north_m[inside])
    x_m, y_m = polar_xy_m(directions)

    grids: dict[str, FloatArray] = {}
    postings: dict[str, float | None] = {}
    for key in CONTEXT_FILES:
        sample = sample_context_map(data_dir, key, x_m, y_m)
        grid = np.full(inside.shape, np.nan)
        grid[inside] = sample.values
        grids[key] = grid
        postings[key] = sample.posting_m

    def mean(key: str) -> float | None:
        values = grids[key][inside]
        known = np.isfinite(values)
        if not known.any():
            return None
        # Area-weighted mean: v̄ = Σᵢ wᵢvᵢ/Σᵢ wᵢ, over points where the map has data
        #   vᵢ - Map value at point i; wᵢ (weights) - Spherical area weight of the point.
        return float(np.average(values[known], weights=weights[known]))

    return SiteContext(
        offsets_m=offsets.tolist(),
        inside_site=inside.ravel().tolist(),
        average_sunlight=_nullable(grids["average_sunlight"]),
        average_earth=_nullable(grids["average_earth"]),
        permanent_shadow=_nullable(grids["permanent_shadow"]),
        sky_openness=_nullable(grids["sky_openness"]),
        summary=ContextSummary(
            average_sunlight=mean("average_sunlight"),
            average_earth=mean("average_earth"),
            permanent_shadow_share=mean("permanent_shadow"),
            sky_openness=mean("sky_openness"),
            posting_m=postings,
        ),
    )


def _nullable(array: np.ndarray) -> list[float | None]:
    values = array.astype(object)
    values[~np.isfinite(array)] = None
    return values.ravel().tolist()
