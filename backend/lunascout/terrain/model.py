"""Load south-polar LOLA elevations as aligned lunar terrain surfaces."""

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass, field
from math import acos, ceil, cos, floor, radians, sqrt
from pathlib import Path

import numpy as np
import rasterio
from numba import njit
from numpy.typing import NDArray
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds

from ..simulation.frames import (
    LUNAR_FRAME,
    MOON_RADIUS_M,
    FloatArray,
    SiteFootprint,
    local_axes,
    to_polar_gnomonic,
)
from . import mesh

REGIONAL_DEM_NAMES = ("LDEM_60S_240MPP_ADJ.TIF", "LDEM_80S_80MPP_ADJ.TIF")
# NASA Goddard's 5 m LOLA grids for the ten candidate south-pole landing sites
# named in https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/README (Barker et al. 2021).
LOCAL_DEM_SITES = (
    "Site01",  # Connecting Ridge
    "Site04",  # Shackleton Rim
    "Site06",  # Nobile Rim 1
    "Site07",  # Peak near Shackleton
    "Site11",  # de Gerlache Rim
    "Site20",  # Leibnitz Beta Plateau
    "Site23",  # Malapert Massif
    "Haworth",
    "Shoemaker",
    "DM2",  # Nobile Rim 2
)
LOCAL_DEM_NAMES = tuple(f"{site}_final_adj_5mpp_surf.tif" for site in LOCAL_DEM_SITES)
_GNOMONIC_CRS = CRS.from_proj4(
    f"+proj=gnom +lat_0=-90 +lon_0=0 +R={MOON_RADIUS_M} +units=m +no_defs"
)
_REGIONAL_DETAIL_RANGE_M = 120_000
# 5 m tiles are loaded only within this distance of the site. Farther away the
# 80 m grid's posting subtends < 0.08° (vs the 0.53° solar disk), while keeping
# every nearby 5 m tile would hold more than 1 GB of grids in memory per site.
_LOCAL_DETAIL_RANGE_M = 60_000
_SEAM_ALIGNMENT_M = 240
_MAX_TERRAIN_GRID_NODES = 100_000_000


class TerrainError(RuntimeError):
    """Elevation data could not be aligned or read."""


@dataclass(frozen=True)
class TerrainSource:
    """Identify the exact input file and the bounds of its prepared grid."""

    filename: str
    sha256: str
    spacing_m: float
    bounds_m: tuple[float, float, float, float]


@dataclass(frozen=True)
class SurfaceSample:
    """Ground point and the outward normal of its mesh triangle."""

    position_m: FloatArray
    normal: FloatArray
    dem_spacing_m: float


@dataclass(frozen=True)
class Terrain:
    """South-polar triangular terrain, ordered from coarsest to finest coverage."""

    sources: tuple[TerrainSource, ...]
    _depths: tuple[FloatArray, ...] = field(repr=False)
    _geometry: FloatArray = field(repr=False)
    frame: str = LUNAR_FRAME

    def surface_at(self, radial_up: FloatArray) -> SurfaceSample | None:
        """Intersect a unit radial direction with terrain, or report missing data."""
        if radial_up[2] >= 0:
            return None

        east_m, north_m = to_polar_gnomonic(radial_up)
        for index in range(len(self._depths) - 1, -1, -1):
            depths = self._depths[index]
            left, bottom, spacing = self._geometry[index]
            rows, columns = depths.shape
            # Grid coordinates: ξ = (E − L)/s; η = (N − B)/s
            #   ξ, η (grid_east, grid_north) - Dimensionless grid coordinates.
            #   E, N (east_m, north_m) - Projected location, in metres.
            #   L, B (left, bottom) - Grid southwest origin, in metres.
            #   s (spacing) - Grid posting, in metres.
            grid_east = (east_m - left) / spacing
            grid_north = (north_m - bottom) / spacing
            if not (0 <= grid_east <= columns - 1 and 0 <= grid_north <= rows - 1):
                continue

            column = min(floor(grid_east), columns - 2)
            row = min(floor(grid_north), rows - 2)
            east_fraction = grid_east - column
            north_fraction = grid_north - row
            base_inverse_depth, east_depth_slope, north_depth_slope = mesh.triangle_plane(
                depths, column, row, east_fraction + north_fraction > 1
            )
            # Affine triangle depth: D = D₀ + D_E f_E + D_N f_N
            #   D (inverse_depth) - Reciprocal negative-Z depth, in m⁻¹.
            #   D₀ (base_inverse_depth) - Extrapolated southwest depth, in m⁻¹.
            #   D_E, D_N (east_depth_slope, north_depth_slope) - Depth change per cell, in m⁻¹.
            #   f_E, f_N (east_fraction, north_fraction) - Dimensionless cell coordinates.
            inverse_depth = (
                base_inverse_depth
                + east_depth_slope * east_fraction
                + north_depth_slope * north_fraction
            )
            if not np.isfinite(inverse_depth):
                return None

            # Radial intersection: x = u/(−u_z D)
            #   x (position) - Terrain position, Moon-fixed metres.
            #   u (radial_up) - Unit radial direction, dimensionless.
            #   D (inverse_depth) - Reciprocal negative-Z depth, in m⁻¹.
            position = radial_up / (-radial_up[2] * inverse_depth)

            # Triangle plane normal: c = D₀ − D_E(L/s + j) − D_N(B/s + k)
            #   a = (D_N R/s, D_E R/s, −c); n = a/‖a‖
            #   c (intercept) - Inverse-depth intercept at projected origin, in m⁻¹.
            #   D₀ (base_inverse_depth) - Southwest-extrapolated depth, in m⁻¹.
            #   D_E, D_N (east_depth_slope, north_depth_slope) - Depth changes per cell, in m⁻¹.
            #   L, B (left, bottom), s (spacing) - Grid origin and posting, in metres.
            #   j, k (column, row) - Dimensionless southwest cell indices.
            #   R (MOON_RADIUS_M) - Lunar datum radius, in metres.
            #   a (normal before normalization) - Plane coefficients, in m⁻¹.
            #   n (normal) - Outward unit Moon-fixed surface normal.
            #   Multiplying the affine depth equation by −Z gives this 3D plane.
            intercept = (
                base_inverse_depth
                - east_depth_slope * (left / spacing + column)
                - north_depth_slope * (bottom / spacing + row)
            )
            normal = np.array(
                [
                    north_depth_slope * MOON_RADIUS_M / spacing,
                    east_depth_slope * MOON_RADIUS_M / spacing,
                    -intercept,
                ]
            )
            normal /= np.linalg.norm(normal)
            return SurfaceSample(position, normal, float(spacing))

        return None

    def visibility(self, origin_m: FloatArray, direction: FloatArray) -> int:
        """Trace a unit ray from within the terrain shell. Return a mesh status."""
        return mesh.trace(origin_m, direction, self._depths, self._geometry)

    def trace_rays(self, origins_m: FloatArray, directions: FloatArray) -> NDArray[np.int8]:
        """Trace an array of unit directions (points, rays, XYZ) from shared origins."""
        return mesh.trace_rays(origins_m, directions, self._depths, self._geometry)


def prepare_terrain(
    data_dir: Path,
    site: SiteFootprint,
    *,
    local_dems: Sequence[Path] | None = None,
    trace_horizon: bool = True,
) -> Terrain:
    """Prepare a terrain window extending far enough to contain distant occluders.

    The NASA regional DEMs go under `raw/terrain`. Optional local DEMs may use
    the same south-polar stereographic CRS and radial metres above 1,737,400 m.
    If supplied, they replace the default local set. Input grid spacing must
    divide 240 m so the reprojected grids can share aligned edges.
    A terrain preview can restrict reads to the supplied footprint by setting
    `trace_horizon=False`.
    """
    terrain_dir = data_dir / "raw" / "terrain"
    regional = tuple(terrain_dir / name for name in REGIONAL_DEM_NAMES)
    missing = [str(path) for path in regional if not path.is_file()]
    if missing:
        raise TerrainError(f"Missing regional LOLA DEMs: {', '.join(missing)}")

    local = (
        tuple(path for name in LOCAL_DEM_NAMES if (path := terrain_dir / name).is_file())
        if local_dems is None
        else tuple(local_dems)
    )
    _, _, up = local_axes(site.latitude_deg, site.longitude_deg)
    centre = to_polar_gnomonic(up)
    # A ray missing the inner shell sweeps at most two tangent arcs before
    # leaving the outer shell. All higher terrain would violate the envelope.
    horizon_angle = 2 * acos(mesh.INNER_RADIUS_M / mesh.OUTER_RADIUS_M) if trace_horizon else 0.0
    full_bounds = _site_bounds(site, centre, horizon_angle)
    middle_angle = _REGIONAL_DETAIL_RANGE_M / MOON_RADIUS_M if trace_horizon else 0.0
    middle_bounds = _site_bounds(site, centre, middle_angle)
    local_angle = _LOCAL_DETAIL_RANGE_M / MOON_RADIUS_M if trace_horizon else 0.0
    local_bounds = _site_bounds(site, centre, local_angle)

    sources: list[TerrainSource] = []
    depths: list[FloatArray] = []
    geometry: list[tuple[float, float, float]] = []
    inputs = [(regional[0], full_bounds), (regional[1], middle_bounds)]
    inputs.extend((path, local_bounds) for path in local)

    try:
        # Load tied resolutions in filename order. Thus input order never changes
        # which local mosaic owns the overlapping part of a site.
        inputs.sort(key=lambda item: (-_native_spacing(item[0]), item[0].name))
        for path, bounds in inputs:
            loaded = _load_grid(path, bounds)
            if loaded is None:
                continue

            grid, source = loaded
            left, bottom, _, _ = source.bounds_m
            spacing = source.spacing_m
            for parent, parent_geometry in zip(depths, geometry, strict=True):
                _stitch_edges(grid, left, bottom, spacing, parent, *parent_geometry)

            depths.append(grid)
            geometry.append((left, bottom, spacing))
            sources.append(source)
    except (OSError, rasterio.errors.RasterioError) as exc:
        raise TerrainError("Could not prepare the requested LOLA terrain.") from exc

    if not depths:
        raise TerrainError("The selected site has no elevation grids in range.")

    return Terrain(tuple(sources), tuple(depths), np.array(geometry))


def _site_bounds(
    site: SiteFootprint, centre: FloatArray, extra_angle: float
) -> tuple[float, float, float, float]:
    angular_radius = site.radius_m / MOON_RADIUS_M + extra_angle
    max_colatitude = radians(90 + site.latitude_deg) + angular_radius
    if max_colatitude >= np.pi / 2:
        return -np.inf, -np.inf, np.inf, np.inf

    # The radial scale of the gnomonic projection is secant squared.
    distance = MOON_RADIUS_M * angular_radius / cos(max_colatitude) ** 2
    east, north = centre
    return east - distance, north - distance, east + distance, north + distance


def _native_spacing(path: Path) -> float:
    with rasterio.open(path) as raster:
        return raster.res[0]


def _load_grid(
    path: Path, bounds: tuple[float, float, float, float]
) -> tuple[FloatArray, TerrainSource] | None:
    with rasterio.open(path) as raster:
        spacing = _validate_dem(raster, path)
        west, south, east, north = transform_bounds(raster.crs, _GNOMONIC_CRS, *raster.bounds)
        left = ceil(max(west, bounds[0]) / _SEAM_ALIGNMENT_M) * _SEAM_ALIGNMENT_M
        bottom = ceil(max(south, bounds[1]) / _SEAM_ALIGNMENT_M) * _SEAM_ALIGNMENT_M
        right = floor(min(east, bounds[2]) / _SEAM_ALIGNMENT_M) * _SEAM_ALIGNMENT_M
        top = floor(min(north, bounds[3]) / _SEAM_ALIGNMENT_M) * _SEAM_ALIGNMENT_M
        if right <= left or top <= bottom:
            return None

        rows = round((top - bottom) / spacing) + 1
        columns = round((right - left) / spacing) + 1
        if rows * columns > _MAX_TERRAIN_GRID_NODES:
            raise TerrainError(f"{path.name} is too large to align in memory. Crop this DEM first.")
        elevations = np.empty((rows, columns), dtype=np.float32)
        reproject(
            source=rasterio.band(raster, 1),
            destination=elevations,
            dst_crs=_GNOMONIC_CRS,
            dst_transform=from_origin(left - spacing / 2, top + spacing / 2, spacing, spacing),
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
            num_threads=2,
        )

    depths = np.ascontiguousarray(elevations[::-1], dtype=np.float64)
    valid_count = _convert_to_inverse_depth(depths, left, bottom, spacing)
    if valid_count == 0:
        return None
    if valid_count < 0:
        raise TerrainError(f"{path.name} contains elevations outside the supported lunar bounds.")

    with path.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    return depths, TerrainSource(path.name, checksum, spacing, (left, bottom, right, top))


def _validate_dem(raster: rasterio.io.DatasetReader, path: Path) -> float:
    crs = raster.crs.to_dict() if raster.crs else {}
    radius = crs.get("R", crs.get("a"))
    spacing, row_spacing = raster.res
    transform = raster.transform
    if (
        crs.get("proj") != "stere"
        or crs.get("lat_0") != -90
        or crs.get("lat_ts", -90) != -90
        or crs.get("lon_0", 0) != 0
        or crs.get("x_0", 0) != 0
        or crs.get("y_0", 0) != 0
        or radius != MOON_RADIUS_M
        or crs.get("b", radius) != radius
        or crs.get("units") != "m"
    ):
        raise TerrainError(
            f"{path.name} needs the lunar south-polar stereographic CRS with radius {MOON_RADIUS_M:g} m."
        )

    if (
        spacing != row_spacing
        or spacing <= 0
        or _SEAM_ALIGNMENT_M % spacing != 0
        or transform.a <= 0
        or transform.e >= 0
        or transform.b != 0
        or transform.d != 0
        or raster.count != 1
        or raster.scales[0] != 1
        or raster.offsets[0] != 0
    ):
        raise TerrainError(f"{path.name} needs a north-up elevation grid in unscaled metres.")

    return spacing


@njit
def _convert_to_inverse_depth(
    depths: FloatArray, left: float, bottom: float, spacing: float
) -> int:
    valid_count = 0
    for row in range(depths.shape[0]):
        north = (bottom + row * spacing) / MOON_RADIUS_M
        for column in range(depths.shape[1]):
            height = depths[row, column]
            if np.isnan(height):
                continue
            radius = MOON_RADIUS_M + height
            if not mesh.INNER_RADIUS_M < radius < mesh.OUTER_RADIUS_M:
                return -1
            east = (left + column * spacing) / MOON_RADIUS_M
            depths[row, column] = sqrt(1 + east**2 + north**2) / radius
            valid_count += 1
    return valid_count


@njit
def _stitch_edges(
    grid: FloatArray,
    left: float,
    bottom: float,
    spacing: float,
    parent: FloatArray,
    parent_left: float,
    parent_bottom: float,
    parent_spacing: float,
) -> None:
    # Matching depths along shared edges prevents a fake vertical occluder where
    # the fine and coarse elevation products meet. Keep missing nodes as gaps.
    rows, columns = grid.shape
    east_origin = (left - parent_left) / parent_spacing
    north_origin = (bottom - parent_bottom) / parent_spacing
    scale = spacing / parent_spacing
    for row in range(rows):
        north = north_origin + row * scale
        for column in (0, columns - 1):
            depth = mesh.interpolate_depth(parent, east_origin + column * scale, north)
            if np.isfinite(depth) and np.isfinite(grid[row, column]):
                grid[row, column] = depth

    for column in range(1, columns - 1):
        east = east_origin + column * scale
        for row in (0, rows - 1):
            depth = mesh.interpolate_depth(parent, east, north_origin + row * scale)
            if np.isfinite(depth) and np.isfinite(grid[row, column]):
                grid[row, column] = depth
