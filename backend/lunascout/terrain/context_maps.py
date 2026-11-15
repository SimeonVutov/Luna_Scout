"""NASA long-term context maps sampled over a landing site.

These are Goddard (PGDA) maps of the south polar region: the average share of time a point
is lit and the average share of time Earth is in view, both over an 18.6-year lunar cycle,
the places that never see the Sun (permanent shadow), and how much sky the terrain leaves
open. They describe the place in general. The simulation describes the chosen dates.

Every file is in the south-polar stereographic projection used by the elevation grids.
"""

from dataclasses import dataclass
from math import pi
from pathlib import Path

import numpy as np
import rasterio
from numpy.typing import NDArray

from ..simulation.frames import MOON_RADIUS_M, FloatArray

ILLUMINATION_URL = "https://pgda.gsfc.nasa.gov/data/MoonIllumination"

# Files from finest to coarsest, with the posting in metres. Only the finest and the 240 m
# products are downloaded; the finest covers the pole out to 85°S, the 240 m ones to 65°S.
CONTEXT_FILES: dict[str, tuple[tuple[str, float], ...]] = {
    "average_sunlight": (("AVGVISIB_85S_060M_201608.TIF", 60.0), ("AVGVISIB_65S_240M_201608.TIF", 240.0)),
    "average_earth": (("AVGVISIB_85S_060M_201608_EARTH.TIF", 60.0), ("AVGVISIB_65S_240M_201608_EARTH.TIF", 240.0)),
    "permanent_shadow": (("LPSR_85S_060M_201608.TIF", 60.0), ("LPSR_65S_240M_201608.TIF", 240.0)),
    "sky_openness": (("SKYV_65S_240M.TIF", 240.0),),
}
CONTEXT_FILE_NAMES = tuple(name for files in CONTEXT_FILES.values() for name, _ in files)
HEMISPHERE_SR = 2 * pi

FloatGrid = NDArray[np.float64]


@dataclass(frozen=True)
class ContextSample:
    """One map sampled at a set of ground points; NaN where the map has no data."""

    values: FloatArray
    posting_m: float | None


def polar_xy_m(radial_up: FloatArray) -> tuple[FloatArray, FloatArray]:
    """South-polar stereographic coordinates of unit Moon-fixed directions.

    Forward stereographic: x = 2R·u_y/(1 − u_z); y = 2R·u_x/(1 − u_z)
      x, y - Projected east and north coordinates, in metres.
      R (MOON_RADIUS_M) - Spherical datum radius, in metres.
      u (radial_up) - Unit radial direction, Moon-fixed XYZ.
      Assumption: southern points, so u_z < 1.
    """
    scale = 2 * MOON_RADIUS_M / (1 - radial_up[..., 2])
    return radial_up[..., 1] * scale, radial_up[..., 0] * scale


def sample_context_map(
    data_dir: Path, key: str, x_m: FloatArray, y_m: FloatArray
) -> ContextSample:
    """Sample one context map at projected points, using the finest file that covers them all."""
    terrain_dir = data_dir / "raw" / "context"
    for name, posting_m in CONTEXT_FILES[key]:
        path = terrain_dir / name
        if not path.is_file():
            continue
        sampled = _read_points(path, x_m, y_m)
        if sampled is not None:
            return ContextSample(_convert(key, sampled), posting_m)
    return ContextSample(np.full(x_m.shape, np.nan), None)


def _read_points(path: Path, x_m: FloatArray, y_m: FloatArray) -> FloatGrid | None:
    """Raw scaled values at the points, or None when the file does not cover all of them."""
    with rasterio.open(path) as raster:
        rows, columns = rasterio.transform.rowcol(raster.transform, x_m, y_m)
        rows = np.asarray(rows, dtype=np.int64)
        columns = np.asarray(columns, dtype=np.int64)
        if (
            columns.min() < 0 or rows.min() < 0
            or columns.max() >= raster.width or rows.max() >= raster.height
        ):
            return None

        window = rasterio.windows.Window(
            columns.min(), rows.min(), columns.max() - columns.min() + 1, rows.max() - rows.min() + 1
        )
        raw = raster.read(1, window=window)[rows - rows.min(), columns - columns.min()]
        # Stored value to physical value: v = s·n + o
        #   v - Physical value; n - stored integer; s, o - the file's scale and offset.
        values = raw.astype(np.float64) * raster.scales[0] + raster.offsets[0]
        values[raw == raster.nodata] = np.nan
        return values


def _convert(key: str, values: FloatGrid) -> FloatGrid:
    """Turn a file's physical values into a fraction between 0 and 1."""
    if key == "sky_openness":
        # Open-sky fraction: f = Ω/2π
        #   f - Share of the sky hemisphere the terrain leaves open (1 on flat ground).
        #   Ω - Solid angle of unobstructed sky, in steradians; 2π sr is a full hemisphere.
        return np.clip(values / HEMISPHERE_SR, 0.0, 1.0)
    return np.clip(values, 0.0, 1.0)
