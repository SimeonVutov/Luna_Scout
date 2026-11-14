"""Build a 3D terrain mesh around a point, with detail that decreases with distance.

Layout ("geometry clipmap"): nested square rings centred on the point.
  level 0: 20 m spacing,   covers +-(n/2)*20 m      (n=256 -> +-2.56 km)
  level 1: 40 m spacing,   covers +-5.12 km, minus the level-0 square
  level k: 20*2^k spacing, covers +-2.56*2^k km, minus the level k-1 square
Every level has the same number of squares, so total size stays small (~66k vertices
per level) while the far field reaches hundreds of km (distant terrain still matters at the pole).

Rings are built in the DEM's polar stereographic map, then every vertex is converted to
true 3D MOON_ME coordinates (curvature included). Ring boundaries are stitched so the
surface is watertight (no cracks between rings).
"""
from dataclasses import dataclass, field

import numpy as np

from .constants import DEM_NATIVE_SPACING_M, MOON_FRAME
from .dem import DEM
from .frames.bodyfixed import enu_basis, latlon_h_to_xyz, map_h_to_xyz
from .frames.projection import latlon_to_map, map_to_latlon


@dataclass
class TerrainMesh:
    """Triangle mesh in MOON_ME metres.

    vertices:  (N, 3) float64, absolute MOON_ME XYZ in metres
    triangles: (M, 3) int32 vertex indices, counter-clockwise seen from above (normals point up/out)
    level:     (N,) int8 detail level of each vertex (0 = finest)
    origin:    (3,) float64 MOON_ME XYZ of the requested point on the surface
    enu:       (3, 3) rows = local east, north, up unit vectors at the point
    """
    vertices: np.ndarray
    triangles: np.ndarray
    level: np.ndarray
    origin: np.ndarray
    enu: np.ndarray
    meta: dict = field(default_factory=dict)

    def local_enu(self) -> np.ndarray:
        """Vertices relative to origin, in local East/North/Up metres (float64)."""
        return (self.vertices - self.origin) @ self.enu.T

    def vertex_normals(self) -> np.ndarray:
        v, t = self.vertices, self.triangles
        fn = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])
        n = np.zeros_like(v)
        for k in range(3):
            np.add.at(n, t[:, k], fn)
        n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-300
        return n


def build_terrain(lat, lon, *, n=256, max_distance_m=300_000.0, levels=None,
                  dem: DEM | None = None, base_spacing_m=DEM_NATIVE_SPACING_M) -> TerrainMesh:
    """Terrain mesh centred on (lat, lon) [deg, east-positive].

    n:               squares per side of each ring (multiple of 4). Level-0 half-width = n/2 * 20 m.
    max_distance_m:  add rings until the outermost half-width reaches this distance.
    levels:          explicit number of rings (overrides max_distance_m).
    """
    if n % 4 or n < 8:
        raise ValueError("n must be a multiple of 4 and >= 8")
    own = dem is None
    dem = dem or DEM()
    try:
        cx, cy = (float(v) for v in latlon_to_map(lat, lon))
        if levels is None:
            levels = 1
            while (n / 2) * base_spacing_m * 2 ** (levels - 1) < max_distance_m:
                levels += 1

        grids = []  # per level: dict with x0, y0, s, xyz (n+1, n+1, 3)
        for k in range(levels):
            s = base_spacing_m * 2 ** k
            half = (n / 2) * s
            # centre snapped to multiples of 2s so this ring's edges fall on the next ring's nodes
            gx = round(cx / (2 * s)) * 2 * s
            gy = round(cy / (2 * s)) * 2 * s
            x0, y0 = gx - half, gy + half
            h = dem.heights_on_grid(x0, y0, s, n + 1, n + 1)
            xs = x0 + np.arange(n + 1) * s
            ys = y0 - np.arange(n + 1) * s
            X, Y = np.meshgrid(xs, ys)
            grids.append({"x0": x0, "y0": y0, "s": s, "h": h, "xyz": map_h_to_xyz(X, Y, h)})

        # stitch: ring k's inner hole boundary shares nodes with ring k-1's outer boundary
        for k in range(1, levels):
            _stitch(fine=grids[k - 1], coarse=grids[k], n=n)

        verts, tris, lev = [], [], []
        offset = 0
        for k, g in enumerate(grids):
            hole = None
            if k > 0:
                f = grids[k - 1]
                i0 = int(round((f["x0"] - g["x0"]) / g["s"]))
                j0 = int(round((g["y0"] - f["y0"]) / g["s"]))
                hole = (j0, i0, n // 2)
            t = _grid_triangles(n, hole) + offset
            v = g["xyz"].reshape(-1, 3)
            bad = ~np.isfinite(v).all(axis=1)
            if bad.any():
                t = t[~bad[t - offset].any(axis=1)]
            verts.append(v)
            tris.append(t)
            lev.append(np.full(len(v), k, np.int8))
            offset += len(v)

        V = np.concatenate(verts)
        T = np.concatenate(tris).astype(np.int32)
        L = np.concatenate(lev)
        # drop vertices not used by any triangle (outside coverage / under holes)
        used = np.zeros(len(V), bool)
        used[T.ravel()] = True
        remap = np.cumsum(used) - 1
        V, L, T = V[used], L[used], remap[T].astype(np.int32)

        enu = enu_basis(lat, lon)
        # orient triangles so normals point away from the Moon's centre
        fn = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]])
        if np.einsum("ij,ij->i", fn, V[T[:, 0]]).mean() < 0:
            T = T[:, [0, 2, 1]]

        h0 = dem.height_at(cx, cy)
        origin = latlon_h_to_xyz(lat, lon, h0)
        lat_c, lon_c = map_to_latlon(cx, cy)
        coverage = [float(np.isfinite(g["h"]).mean()) for g in grids]
        meta = {
            "frame": MOON_FRAME,
            "units": "m",
            "center_lat_deg": float(lat_c), "center_lon_deg": float(lon_c),
            "center_height_m": h0,
            "dem_source": dem.source,
            "squares_per_ring": n,
            "levels": levels,
            "spacing_m": [g["s"] for g in grids],
            "half_width_m": [(n / 2) * g["s"] for g in grids],
            "coverage_fraction": coverage,
        }
        return TerrainMesh(V, T, L, origin, enu, meta)
    finally:
        if own:
            dem.close()


def _stitch(fine, coarse, n):
    """Make the fine ring's outer edge and the coarse ring's hole edge identical in 3D."""
    s_c = coarse["s"]
    i0 = int(round((fine["x0"] - coarse["x0"]) / s_c))
    j0 = int(round((coarse["y0"] - fine["y0"]) / s_c))
    F, C = fine["xyz"], coarse["xyz"]
    m = n // 2
    even = np.arange(0, n + 1, 2)
    # 1) coarse hole-edge nodes take the fine ring's values (same map positions)
    C[j0, i0:i0 + m + 1] = F[0, even]
    C[j0 + m, i0:i0 + m + 1] = F[n, even]
    C[j0:j0 + m + 1, i0] = F[even, 0]
    C[j0:j0 + m + 1, i0 + m] = F[even, n]
    # 2) fine edge nodes between them lie exactly on the coarse edge (3D midpoint)
    odd = np.arange(1, n, 2)
    F[0, odd] = 0.5 * (F[0, odd - 1] + F[0, odd + 1])
    F[n, odd] = 0.5 * (F[n, odd - 1] + F[n, odd + 1])
    F[odd, 0] = 0.5 * (F[odd - 1, 0] + F[odd + 1, 0])
    F[odd, n] = 0.5 * (F[odd - 1, n] + F[odd + 1, n])


def _grid_triangles(n, hole=None):
    """Two triangles per square of an (n+1)x(n+1) node grid, skipping squares inside `hole`
    = (row0, col0, size) in squares."""
    j, i = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
    keep = np.ones((n, n), bool)
    if hole is not None:
        j0, i0, m = hole
        keep[j0:j0 + m, i0:i0 + m] = False
    j, i = j[keep], i[keep]
    a = j * (n + 1) + i
    b = a + 1
    c = a + (n + 1)
    d = c + 1
    return np.concatenate([np.stack([a, c, b], 1), np.stack([b, c, d], 1)])
