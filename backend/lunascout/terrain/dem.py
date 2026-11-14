"""Read heights from the LOLA south-pole DEM at arbitrary map positions and spacings.

Works with the local file (after scripts/fetch_data.py) or streams straight from NASA's
server, because the file is a cloud-optimized GeoTIFF (only the needed tiles are fetched).
"""
import math
import os

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window

from .constants import DEM_LOCAL, DEM_NATIVE_SPACING_M, DEM_URL, MOON_RADIUS_M
from .frames.bodyfixed import latlon_h_to_xyz, map_h_to_xyz
from .frames.projection import latlon_to_map

_EXPECTED_CRS = {"proj": "stere", "lat_0": -90, "lon_0": 0, "R": MOON_RADIUS_M}


def default_source() -> str:
    """Local file if present, otherwise the NASA URL (streamed)."""
    return str(DEM_LOCAL) if DEM_LOCAL.exists() else DEM_URL


class DEM:
    """Height lookups on the south polar stereographic LOLA grid.

    heights_on_grid(...) returns heights at grid NODES (x0 + i*s, y0 - j*s).
    For spacings coarser than 20 m the DEM is first averaged down to that spacing
    (anti-aliasing), then bilinearly interpolated at the nodes.
    """

    def __init__(self, source: str | None = None):
        self.source = source or default_source()
        path = self.source
        if path.startswith("http"):
            path = "/vsicurl/" + path
            os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
        self.ds = rasterio.open(path)
        self._check()
        t = self.ds.transform
        self.left, self.top, self.res = t.c, t.f, t.a

    def _check(self):
        crs = self.ds.crs.to_dict()
        for k, v in _EXPECTED_CRS.items():
            got = crs.get(k)
            if got is None or (isinstance(v, float) and abs(got - v) > 1e-6) or (not isinstance(v, float) and got != v):
                raise ValueError(f"DEM CRS mismatch on {k}: expected {v}, got {got}")
        t = self.ds.transform
        if abs(t.a - DEM_NATIVE_SPACING_M) > 1e-9 or abs(t.e + DEM_NATIVE_SPACING_M) > 1e-9 or t.b or t.d:
            raise ValueError(f"Unexpected DEM transform {t}")

    def close(self):
        self.ds.close()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def heights_on_grid(self, x0, y0, spacing, nx, ny, resampling=Resampling.average):
        """Heights (ny, nx) at nodes x = x0 + i*spacing, y = y0 - j*spacing. NaN outside coverage."""
        f = max(1, int(round(spacing / self.res)))
        r = self.res * f  # resolution we read at
        x1, y1 = x0 + (nx - 1) * spacing, y0 - (ny - 1) * spacing
        # native pixel window covering the nodes plus one read-pixel margin, width divisible by f
        c0 = math.floor((x0 - self.left) / self.res) - f
        r0 = math.floor((self.top - y0) / self.res) - f
        c1 = math.ceil((x1 - self.left) / self.res) + f
        r1 = math.ceil((self.top - y1) / self.res) + f
        c1 += (-(c1 - c0)) % f
        r1 += (-(r1 - r0)) % f
        out_shape = ((r1 - r0) // f, (c1 - c0) // f)
        a = self.ds.read(
            1,
            window=Window(c0, r0, c1 - c0, r1 - r0),
            out_shape=out_shape,
            resampling=resampling,
            boundless=True,
            fill_value=np.nan,
        ).astype(np.float64)
        # centres of the read pixels
        ax_left = self.left + c0 * self.res + r / 2
        ax_top = self.top - r0 * self.res - r / 2
        xs = x0 + np.arange(nx) * spacing
        ys = y0 - np.arange(ny) * spacing
        return _bilinear(a, (xs - ax_left) / r, (ax_top - ys) / r)

    def height_at(self, x, y):
        """Height at a single map position (bilinear on the native 20 m grid)."""
        return float(self.heights_on_grid(x, y, self.res, 1, 1)[0, 0])

    def height_at_latlon(self, lat, lon):
        """Terrain height (m above the sphere) at a single lat/lon."""
        x, y = latlon_to_map(lat, lon)
        return self.height_at(float(x), float(y))

    def surface_xyz(self, lat, lon, above_m=0.0):
        """MOON_ME position (m) of the terrain surface at lat/lon, optionally raised by
        `above_m` along local up (mast / antenna / camera height)."""
        return latlon_h_to_xyz(lat, lon, self.height_at_latlon(lat, lon) + above_m)

    def surface_normal(self, lat, lon, baseline_m=None):
        """Outward unit normal of the terrain at lat/lon in MOON_ME, from central differences
        of true 3D surface points `baseline_m` apart on the map (default: one DEM square)."""
        b = baseline_m or self.res
        x, y = (float(v) for v in latlon_to_map(lat, lon))
        p = [map_h_to_xyz(px, py, self.height_at(px, py))
             for px, py in ((x + b, y), (x - b, y), (x, y + b), (x, y - b))]
        n = np.cross(p[0] - p[1], p[2] - p[3])
        n /= np.linalg.norm(n)
        centre = map_h_to_xyz(x, y, 0.0)
        return n if n @ centre > 0 else -n

    def in_coverage(self, lat, lon):
        """True where the DEM has data for lat/lon (arrays accepted)."""
        x, y = latlon_to_map(lat, lon)
        b = self.ds.bounds
        return (x >= b.left) & (x <= b.right) & (y >= b.bottom) & (y <= b.top)


def _bilinear(a, cols, rows):
    """Bilinear sample of array a at fractional column positions `cols` (nx,) and row positions `rows` (ny,)."""
    c0 = np.floor(cols).astype(int)
    r0 = np.floor(rows).astype(int)
    fc = cols - c0
    fr = rows - r0
    c0 = np.clip(c0, 0, a.shape[1] - 2)
    r0 = np.clip(r0, 0, a.shape[0] - 2)
    A = a[np.ix_(r0, c0)]
    B = a[np.ix_(r0, c0 + 1)]
    C = a[np.ix_(r0 + 1, c0)]
    D = a[np.ix_(r0 + 1, c0 + 1)]
    fc = fc[None, :]
    fr = fr[:, None]
    return (A * (1 - fc) + B * fc) * (1 - fr) + (C * (1 - fc) + D * fc) * fr
