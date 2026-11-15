"""Terrain insight for a site: data detail, slope and skyline, computed on request and cached."""

from collections import OrderedDict
from pathlib import Path
from threading import Lock

import numpy as np
from pydantic import BaseModel

from ..simulation.engine import SimulationSettings, prepare_site
from ..simulation.frames import SiteFootprint
from ..simulation.insight import SKYLINE_BINS, TerrainSummary, skyline_degrees, summarize_terrain
from ..terrain.model import prepare_terrain

_CACHED_INSIGHTS = 24


class TerrainSummaryPayload(BaseModel):
    known_area_fraction: float
    # Keys are postings in metres, such as "5", "80" and "240".
    detail_area_fractions: dict[str, float]
    centre_detail_m: float | None
    centre_height_m: float | None
    height_min_m: float | None
    height_max_m: float | None
    slope_mean_deg: float | None
    slope_p95_deg: float | None
    slope_max_deg: float | None
    # Keys are slope limits in degrees: "5", "10" and "15".
    gentle_area_fractions: dict[str, float]
    slope_baseline_m: float


class SlopeGridPayload(BaseModel):
    """Row-major arrays like a snapshot grid: north increases by row and east by column."""

    offsets_m: list[float]
    inside_site: list[bool]
    slope_deg: list[float | None]


class SiteInsight(BaseModel):
    summary: TerrainSummaryPayload
    slope_grid: SlopeGridPayload
    skyline_azimuth_step_deg: float
    collector_height_m: float
    mast_height_m: float
    # Terrain horizon elevation above the level plane, one value per azimuth bin
    # (bin k is centred at (k + ½) × step, clockwise from north). Null where terrain is missing.
    collector_skyline_deg: list[float | None] | None
    mast_skyline_deg: list[float | None] | None


class InsightService:
    """Compute and remember insights. One computation at a time keeps terrain memory bounded."""

    def __init__(self, data_dir: Path) -> None:
        self._data_dir = data_dir
        self._lock = Lock()
        self._cache: OrderedDict[tuple[SiteFootprint, SimulationSettings], SiteInsight] = OrderedDict()

    def insight(self, site: SiteFootprint, settings: SimulationSettings) -> SiteInsight:
        key = (site, settings)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]

            insight = self._compute(site, settings)
            self._cache[key] = insight
            while len(self._cache) > _CACHED_INSIGHTS:
                self._cache.popitem(last=False)
            return insight

    def _compute(self, site: SiteFootprint, settings: SimulationSettings) -> SiteInsight:
        terrain = prepare_terrain(self._data_dir, site)
        prepared = prepare_site(site, terrain, settings)
        summary = summarize_terrain(prepared)

        collector = skyline_degrees(terrain, prepared.center_collector_m, prepared.axes)
        mast = skyline_degrees(terrain, prepared.mast_origin_m, prepared.axes)
        return SiteInsight(
            summary=_summary_payload(summary),
            slope_grid=SlopeGridPayload(
                offsets_m=prepared.offsets_m.tolist(),
                inside_site=prepared.inside.ravel().tolist(),
                slope_deg=_nullable(prepared.slope_deg),
            ),
            skyline_azimuth_step_deg=360 / SKYLINE_BINS,
            collector_height_m=settings.collector_height_m,
            mast_height_m=settings.mast_height_m,
            collector_skyline_deg=None if collector is None else _nullable(np.round(collector, 3)),
            mast_skyline_deg=None if mast is None else _nullable(np.round(mast, 3)),
        )


def _summary_payload(summary: TerrainSummary) -> TerrainSummaryPayload:
    return TerrainSummaryPayload(
        known_area_fraction=summary.known_area_fraction,
        detail_area_fractions={f"{posting:g}": share for posting, share in summary.detail_area_fractions.items()},
        centre_detail_m=summary.centre_detail_m,
        centre_height_m=summary.centre_height_m,
        height_min_m=summary.height_min_m,
        height_max_m=summary.height_max_m,
        slope_mean_deg=summary.slope_mean_deg,
        slope_p95_deg=summary.slope_p95_deg,
        slope_max_deg=summary.slope_max_deg,
        gentle_area_fractions={f"{limit:g}": share for limit, share in summary.gentle_area_fractions.items()},
        slope_baseline_m=summary.slope_baseline_m,
    )


def _nullable(array: np.ndarray) -> list[float | None]:
    values = array.astype(object)
    values[~np.isfinite(array)] = None
    return values.ravel().tolist()
