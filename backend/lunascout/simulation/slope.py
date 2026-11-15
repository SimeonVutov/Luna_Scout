"""Ground slope at the reporting grid points, from the same terrain the rays are traced against."""

import numpy as np
from numpy.typing import NDArray

from ..terrain.model import Terrain
from .frames import MOON_RADIUS_M, FloatArray, SiteFootprint, site_directions


def grid_slopes(
    site: SiteFootprint,
    terrain: Terrain,
    offsets_m: FloatArray,
    inside: NDArray[np.bool_],
) -> FloatArray:
    """Slope in degrees at each reporting point, NaN outside the circle or on unknown ground.

    `offsets_m` is the shared east/north axis of the reporting grid and `inside` its circle
    mask, both from `prepare_site`. The slope is measured over a baseline of twice the grid
    spacing, so it is a smoothed slope, gentler than the terrain model's native 5 m posting
    would give. Neighbours just outside the circle are sampled so edge points have a slope too.
    """
    slopes = np.full(inside.shape, np.nan)
    if len(offsets_m) < 3:
        return slopes

    spacing_m = float(offsets_m[1] - offsets_m[0])
    half_width = (len(offsets_m) - 1) // 2
    extended_offsets = np.arange(-(half_width + 1), half_width + 2) * spacing_m
    east_m, north_m = np.meshgrid(extended_offsets, extended_offsets)

    # A point needs its four direct neighbours, so sample the circle grown by one cell.
    inside_extended = np.zeros(east_m.shape, dtype=bool)
    inside_extended[1:-1, 1:-1] = inside
    needed = inside_extended.copy()
    needed[1:, :] |= inside_extended[:-1, :]
    needed[:-1, :] |= inside_extended[1:, :]
    needed[:, 1:] |= inside_extended[:, :-1]
    needed[:, :-1] |= inside_extended[:, 1:]

    directions, _ = site_directions(site, east_m[needed], north_m[needed])
    heights_m = np.full(east_m.shape, np.nan)
    for (row, column), direction in zip(np.argwhere(needed), directions, strict=True):
        ground = terrain.surface_at(direction)
        if ground is not None:
            heights_m[row, column] = np.linalg.norm(ground.position_m) - MOON_RADIUS_M

    # Central-difference slope: θ = atan(√((∂h/∂E)² + (∂h/∂N)²))
    #   θ - Ground slope from local horizontal, converted to degrees.
    #   ∂h/∂E ≈ (h(E + s) − h(E − s))/(2s) - East gradient of terrain height, dimensionless.
    #   ∂h/∂N ≈ (h(N + s) − h(N − s))/(2s) - North gradient of terrain height, dimensionless.
    #   h - Radial terrain height above the 1,737,400 m datum, in metres.
    #   s (spacing_m) - Grid spacing in metres; the baseline between neighbours is 2s.
    #   Assumption: Over a baseline of tens of metres the Moon's curvature is negligible.
    east_gradient = (heights_m[1:-1, 2:] - heights_m[1:-1, :-2]) / (2 * spacing_m)
    north_gradient = (heights_m[2:, 1:-1] - heights_m[:-2, 1:-1]) / (2 * spacing_m)
    slopes = np.degrees(np.arctan(np.hypot(east_gradient, north_gradient)))
    slopes[~inside] = np.nan
    return slopes
