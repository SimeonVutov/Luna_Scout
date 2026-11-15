"""Per-point results of a finished run: longest day and night, time shares and the best spots."""

import logging
import tempfile
from pathlib import Path
from threading import Lock
from typing import Annotated

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi import Path as PathParameter
from pydantic import BaseModel

from ..jobs.scheduler import RunQueue, RunStatus
from ..simulation.frames import FloatArray, SiteFootprint, site_directions
from ..simulation.site_map import (
    EARTH_GOOD_SHARE,
    SUN_GOOD_SHARE,
    Extremes,
    SiteMap,
    SiteMapBuilder,
    SiteSummary,
    summarize_site_map,
)

logger = logging.getLogger(__name__)
RunId = Annotated[str, PathParameter(pattern=r"^[a-f0-9]{64}$")]
_SAVED_NAME = "site_map.npz"
# The grid arrays a snapshot is read for; the rest of each saved snapshot is left alone.
_SNAPSHOT_ARRAYS = (
    "visible_sun_fraction_lower", "visible_sun_fraction_upper", "earth_visible_fraction_lower",
)


class ExtremesPayload(BaseModel):
    typical_hours: float
    best_hours: float
    worst_hours: float
    truncated: bool


class SiteSummaryPayload(BaseModel):
    longest_day: ExtremesPayload
    longest_dark: ExtremesPayload
    area_good_for_sun: float
    # Null for runs whose snapshots were saved before Earth line of sight per point existed.
    area_good_for_earth: float | None
    area_good_for_both: float | None


class SiteMapPayload(BaseModel):
    """Row-major arrays like a snapshot grid: north increases by row and east by column."""

    offsets_m: list[float]
    inside_site: list[bool]
    sunlit_share: list[float | None]
    earth_share: list[float | None]
    longest_day_hours: list[float | None]
    longest_dark_hours: list[float | None]
    period_hours: float
    # What counts as a good spot, so the interface can say so.
    sun_good_share: float
    earth_good_share: float
    summary: SiteSummaryPayload


def site_map_router(queue: RunQueue) -> APIRouter:
    router = APIRouter(prefix="/api")
    lock = Lock()

    @router.get("/runs/{run_id}/site-map")
    def run_site_map(run_id: RunId) -> SiteMapPayload:
        """Longest day, longest night, time shares and good spots for every point of a finished run."""
        status = queue.status(run_id)
        if status is None:
            raise HTTPException(404, "Run not found")
        if status.stage != "complete":
            raise HTTPException(409, "The simulation has not finished.")

        # One build at a time: a build reads every saved snapshot, and the result is then cached.
        with lock:
            saved = _load_or_build(queue, run_id, status)
        return saved

    return router


def _load_or_build(queue: RunQueue, run_id: str, status: RunStatus) -> SiteMapPayload:
    path = queue.directory / run_id / _SAVED_NAME
    if path.is_file():
        try:
            with np.load(path, allow_pickle=False) as saved:
                return _payload(_site_map_from(saved), saved["offsets_m"], saved["inside_site"], saved["weights"])
        except (OSError, ValueError, KeyError):
            logger.warning("Ignoring an unreadable site map at %s", path)

    site_map, offsets, inside = _build(queue, run_id, status)
    weights = _area_weights(status.plan.site, offsets, inside)
    _save(path, site_map, offsets, inside, weights)
    return _payload(site_map, offsets, inside, weights)


def _build(queue: RunQueue, run_id: str, status: RunStatus) -> tuple[SiteMap, FloatArray, np.ndarray]:
    plan = status.plan
    builder = SiteMapBuilder(frame_hours=plan.snapshot_minutes / 60)
    offsets = inside = None

    for index in range(plan.frame_count):
        frame_path = queue.frame_path(run_id, index * plan.stride)
        try:
            with np.load(frame_path, allow_pickle=False) as frame:
                arrays = {name: frame[name] for name in _SNAPSHOT_ARRAYS if name in frame.files}
                if offsets is None:
                    offsets, inside = frame["offsets_m"], frame["inside_site"]
        except (OSError, ValueError, KeyError) as exc:
            raise HTTPException(409, "Some snapshots of this run are not available.") from exc
        builder.add(arrays)

    assert offsets is not None and inside is not None
    return builder.result(), offsets, inside


def _area_weights(site: SiteFootprint, offsets: FloatArray, inside: np.ndarray) -> FloatArray:
    """Each point's spherical area weight on the grid, NaN outside the site."""
    east_m, north_m = np.meshgrid(offsets, offsets)
    _, weights = site_directions(site, east_m[inside], north_m[inside])

    grid = np.full(inside.shape, np.nan)
    grid[inside] = weights
    return grid


def _save(path: Path, site_map: SiteMap, offsets: FloatArray, inside: np.ndarray, weights: FloatArray) -> None:
    # Written to a temporary file first, so a reader never sees a half-written map.
    with tempfile.TemporaryDirectory(dir=path.parent) as staging:
        staged = Path(staging) / path.name
        np.savez_compressed(
            staged, offsets_m=offsets, inside_site=inside, weights=weights,
            sunlit_share=site_map.sunlit_share, earth_share=site_map.earth_share,
            longest_day_hours=site_map.longest_day_hours, longest_dark_hours=site_map.longest_dark_hours,
            day_truncated=site_map.day_truncated, dark_truncated=site_map.dark_truncated,
            period_hours=np.array(site_map.period_hours),
        )
        staged.replace(path)


def _site_map_from(saved: np.lib.npyio.NpzFile) -> SiteMap:
    return SiteMap(
        sunlit_share=saved["sunlit_share"], earth_share=saved["earth_share"],
        longest_day_hours=saved["longest_day_hours"], longest_dark_hours=saved["longest_dark_hours"],
        day_truncated=saved["day_truncated"], dark_truncated=saved["dark_truncated"],
        period_hours=float(saved["period_hours"]),
    )


def _payload(site_map: SiteMap, offsets: FloatArray, inside: np.ndarray, weights: FloatArray) -> SiteMapPayload:
    return SiteMapPayload(
        offsets_m=offsets.tolist(),
        inside_site=inside.ravel().tolist(),
        sunlit_share=_nullable(site_map.sunlit_share),
        earth_share=_nullable(site_map.earth_share),
        longest_day_hours=_nullable(site_map.longest_day_hours),
        longest_dark_hours=_nullable(site_map.longest_dark_hours),
        period_hours=site_map.period_hours,
        sun_good_share=SUN_GOOD_SHARE,
        earth_good_share=EARTH_GOOD_SHARE,
        summary=_summary_payload(summarize_site_map(site_map, weights)),
    )


def _summary_payload(summary: SiteSummary) -> SiteSummaryPayload:
    return SiteSummaryPayload(
        longest_day=_extremes_payload(summary.longest_day),
        longest_dark=_extremes_payload(summary.longest_dark),
        area_good_for_sun=summary.area_good_for_sun,
        area_good_for_earth=summary.area_good_for_earth,
        area_good_for_both=summary.area_good_for_both,
    )


def _extremes_payload(extremes: Extremes) -> ExtremesPayload:
    return ExtremesPayload(
        typical_hours=extremes.typical_hours, best_hours=extremes.best_hours,
        worst_hours=extremes.worst_hours, truncated=extremes.truncated,
    )


def _nullable(array: np.ndarray) -> list[float | None]:
    values = array.astype(object)
    values[~np.isfinite(array)] = None
    return values.ravel().tolist()
