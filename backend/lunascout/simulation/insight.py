"""Static facts about a site's terrain: data detail, slope statistics and the skyline.

Nothing here depends on time. The Sun and Earth move across the skyline; the terrain does not.
"""

from dataclasses import dataclass

import numpy as np

from ..terrain.model import Terrain
from .engine import PreparedSite
from .frames import FloatArray

# Slope limits reported as the share of the site at or below them, in degrees.
SLOPE_LIMITS_DEG = (5.0, 10.0, 15.0)
SKYLINE_BINS = 3600


@dataclass(frozen=True)
class TerrainSummary:
    """Terrain detail and slope over the reporting footprint.

    Fractions are of the footprint's area (spherical area weights). `detail_area_fractions`
    maps a source posting in metres to the share of known ground sampled from it.
    """

    known_area_fraction: float
    detail_area_fractions: dict[float, float]
    centre_detail_m: float | None
    centre_height_m: float | None
    height_min_m: float | None
    height_max_m: float | None
    slope_mean_deg: float | None
    slope_p95_deg: float | None
    slope_max_deg: float | None
    gentle_area_fractions: dict[float, float]
    slope_baseline_m: float


def summarize_terrain(prepared: PreparedSite) -> TerrainSummary:
    """Detail and slope statistics over the footprint of a prepared site."""
    inside = prepared.inside
    weights = prepared.weights
    total_weight = float(weights.sum())

    heights = prepared.heights_m[inside]
    postings = prepared.dem_spacing_m[inside]
    slopes = prepared.slope_deg[inside]
    known = np.isfinite(heights)

    # Share of the footprint's area by terrain source: F(d) = Σᵢ∈D wᵢ / W
    #   F(d) - Fraction of the footprint sampled from the source with posting d.
    #   D - Reporting points whose ground height came from that source.
    #   wᵢ (weights), W (total_weight) - Point weights and their total over the whole circle.
    detail_fractions = {
        float(posting): float(weights[known & (postings == posting)].sum() / total_weight)
        for posting in np.unique(postings[known])
    }

    midpoint = len(prepared.offsets_m) // 2
    centre_detail = prepared.dem_spacing_m[midpoint, midpoint]

    with_slope = np.isfinite(slopes)
    slope_weights = weights[with_slope]
    gentle = {
        limit: float(slope_weights[slopes[with_slope] <= limit].sum() / slope_weights.sum())
        for limit in SLOPE_LIMITS_DEG
    } if with_slope.any() else {}

    return TerrainSummary(
        known_area_fraction=float(weights[known].sum() / total_weight),
        detail_area_fractions=detail_fractions,
        centre_detail_m=float(centre_detail) if np.isfinite(centre_detail) else None,
        centre_height_m=prepared.center_height_m,
        height_min_m=float(heights[known].min()) if known.any() else None,
        height_max_m=float(heights[known].max()) if known.any() else None,
        slope_mean_deg=float(np.average(slopes[with_slope], weights=slope_weights)) if with_slope.any() else None,
        slope_p95_deg=_weighted_percentile(slopes[with_slope], slope_weights, 0.95) if with_slope.any() else None,
        slope_max_deg=float(slopes[with_slope].max()) if with_slope.any() else None,
        gentle_area_fractions=gentle,
        slope_baseline_m=float(2 * (prepared.offsets_m[1] - prepared.offsets_m[0])) if len(prepared.offsets_m) > 1 else 0.0,
    )


def skyline_degrees(
    terrain: Terrain,
    origin_m: FloatArray | None,
    axes: tuple[FloatArray, FloatArray, FloatArray],
) -> FloatArray | None:
    """Terrain horizon elevation in degrees for `SKYLINE_BINS` azimuths around a viewpoint.

    Azimuth bin k is (k + ½)·360°/SKYLINE_BINS clockwise from north, the convention of the
    Sun and Earth views. Bins where missing terrain could hide a higher ridge are NaN.
    """
    if origin_m is None:
        return None

    elevations_rad, complete = terrain.horizon_around(origin_m, axes, SKYLINE_BINS)
    elevations_deg = np.degrees(elevations_rad)
    elevations_deg[~complete] = np.nan
    return elevations_deg


def _weighted_percentile(values: FloatArray, weights: FloatArray, fraction: float) -> float:
    order = np.argsort(values)
    cumulative = np.cumsum(weights[order])
    cumulative /= cumulative[-1]
    return float(values[order][np.searchsorted(cumulative, fraction)])

