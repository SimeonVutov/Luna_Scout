"""Sample a bounded terrain patch for the browser's local 3D view."""

from dataclasses import dataclass
from math import sqrt
from pathlib import Path
from typing import Literal

import numpy as np

from ..simulation.frames import MOON_RADIUS_M, SiteFootprint, site_directions
from .model import TerrainError, prepare_terrain

_PREVIEW_WIDTH = 161
PreviewScale = Literal["site", "region"]


@dataclass(frozen=True)
class TerrainPreview:
    offsets_m: list[float]
    heights_m: list[float | None]
    center_height_m: float | None
    sources: list[str]
    dem_spacings_m: list[float]


def sample_preview(data_dir: Path, site: SiteFootprint, scale: PreviewScale) -> TerrainPreview:
    """Return radial elevations in a square around a site, north by east."""
    half_extent_m = 16_000 if scale == "region" else min(12_000, max(3_000, site.radius_m * 1.6))
    # Margin keeps crop seams outside the rendered square.
    crop = SiteFootprint(site.latitude_deg, site.longitude_deg, sqrt(2) * half_extent_m + 480)
    terrain = prepare_terrain(data_dir, crop, trace_horizon=False)
    offsets = np.linspace(-half_extent_m, half_extent_m, _PREVIEW_WIDTH)
    east, north = np.meshgrid(offsets, offsets)
    directions, _ = site_directions(site, east.ravel(), north.ravel())

    heights: list[float | None] = []
    spacings: set[float] = set()
    for direction in directions:
        sample = terrain.surface_at(direction)
        if sample is None:
            heights.append(None)
        else:
            heights.append(float(np.linalg.norm(sample.position_m) - MOON_RADIUS_M))
            spacings.add(sample.dem_spacing_m)
    if not spacings:
        raise TerrainError("No elevation data covers this terrain window.")

    return TerrainPreview(
        offsets_m=offsets.tolist(),
        heights_m=heights,
        center_height_m=heights[len(heights) // 2],
        sources=[source.filename for source in terrain.sources],
        dem_spacings_m=sorted(spacings),
    )
