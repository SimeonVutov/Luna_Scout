"""Ray intersections with a triangulated elevation grid on the lunar sphere."""

from math import floor, inf, sqrt

import numpy as np
from numba import njit, prange
from numpy.typing import NDArray

from ..simulation.frames import MOON_RADIUS_M, FloatArray

# Radial envelope of the supported south-polar LOLA terrain (60°S–90°S).
# The LDEM_60S_240MPP_ADJ grid spans −9.12 km to +7.02 km about 1,737,400 m;
# a ~0.4 km margin keeps every DEM node inside. A tighter shell lets grazing rays
# exit sooner (~21% faster per snapshot, identical results on Shackleton and
# Connecting Ridge) and shrinks the far-field horizon window.
INNER_RADIUS_M = MOON_RADIUS_M - 9_500
OUTER_RADIUS_M = MOON_RADIUS_M + 7_500

CLEAR = 0
BLOCKED = 1
UNKNOWN = 2

# Inverse-depth tolerance at the lunar radius is about 0.03 mm.
_DEPTH_TOLERANCE = 1e-17


@njit(inline="always")
def triangle_plane(
    depths: FloatArray, column: int, row: int, upper: bool
) -> tuple[float, float, float]:
    """Return inverse depth and its two slopes at the cell's southwest node."""
    southeast = depths[row, column + 1]
    northwest = depths[row + 1, column]

    if upper:
        northeast = depths[row + 1, column + 1]
        east_slope = northeast - northwest
        north_slope = northeast - southeast
        return northeast - east_slope - north_slope, east_slope, north_slope

    southwest = depths[row, column]
    return southwest, southeast - southwest, northwest - southwest


@njit
def interpolate_depth(depths: FloatArray, grid_east: float, grid_north: float) -> float:
    """Evaluate the piecewise triangular surface in grid-cell coordinates."""
    rows, columns = depths.shape
    if not (0 <= grid_east <= columns - 1 and 0 <= grid_north <= rows - 1):
        return np.nan

    column = min(floor(grid_east), columns - 2)
    row = min(floor(grid_north), rows - 2)
    east_fraction = grid_east - column
    north_fraction = grid_north - row
    base, dx, dy = triangle_plane(depths, column, row, east_fraction + north_fraction > 1)
    return base + dx * east_fraction + dy * north_fraction


@njit
def trace(
    origin_m: FloatArray,
    direction: FloatArray,
    depths: tuple[FloatArray, ...],
    geometry: FloatArray,
) -> int:
    """Trace a unit ray through the lunar terrain shell from an elevated origin."""
    status, _ = _trace_ray(origin_m, direction, depths, geometry, False)
    return status


@njit
def trace_to_hit(
    origin_m: FloatArray,
    direction: FloatArray,
    depths: tuple[FloatArray, ...],
    geometry: FloatArray,
) -> tuple[int, float]:
    """Trace a unit ray and return its status and the distance to the first terrain hit.

    The distance is in metres along the ray and NaN unless terrain was hit. A ray
    that dives into the solid interior across missing terrain is blocked with an
    unknown (NaN) hit distance.
    """
    return _trace_ray(origin_m, direction, depths, geometry, True)


@njit
def _trace_ray(
    origin_m: FloatArray,
    direction: FloatArray,
    depths: tuple[FloatArray, ...],
    geometry: FloatArray,
    locate_hit: bool,
) -> tuple[int, float]:
    x, y, z = origin_m
    dx, dy, dz = direction
    origin_radius_sq = x * x + y * y + z * z
    along_ray = x * dx + y * dy + z * dz
    if not 0 < origin_radius_sq < OUTER_RADIUS_M**2 or not np.isfinite(along_ray):
        return UNKNOWN, np.nan

    closest_sq = origin_radius_sq - along_ray**2
    reaches_interior = along_ray < 0 and closest_sq <= INNER_RADIUS_M**2

    # A ray reaching the guaranteed solid interior is blocked even across DEM gaps.
    # Locating the hit still needs the terrain traversal up to the interior.
    if reaches_interior and not locate_hit:
        return BLOCKED, np.nan

    # Ray–sphere distances: s_out = −q + √(R_out² − b²); s_in = −q − √(R_in² − b²)
    #   s_out (exit_distance) - Distance at which the ray leaves the outer terrain shell, in metres.
    #   s_in - Distance at which the ray enters the solid inner shell, in metres.
    #   q (along_ray) - Projection of the origin onto the unit ray, in metres.
    #   b² (closest_sq) - Squared closest approach of the ray line to the Moon's centre, in m².
    #   R_out, R_in (OUTER_RADIUS_M, INNER_RADIUS_M) - Terrain envelope radii, in metres.
    #   Assumption: All terrain lies between R_in and R_out, so a ray entering the inner
    #   shell has already met terrain, and one leaving the outer shell cannot meet it again.
    if reaches_interior:
        exit_distance = -along_ray - sqrt(INNER_RADIUS_M**2 - closest_sq)
    else:
        exit_distance = -along_ray + sqrt(OUTER_RADIUS_M**2 - closest_sq)

    start_depth = -z
    end_depth = -z - exit_distance * dz
    if min(start_depth, end_depth) <= 0:
        return (BLOCKED if reaches_interior else UNKNOWN), np.nan

    east = MOON_RADIUS_M * y / start_depth
    north = MOON_RADIUS_M * x / start_depth
    delta_east = MOON_RADIUS_M * (y + exit_distance * dy) / end_depth - east
    delta_north = MOON_RADIUS_M * (x + exit_distance * dx) / end_depth - north

    # Central projection sends the ray to a straight line. Its reciprocal depth
    # and each triangle's reciprocal depth vary linearly along that line.
    inverse_depth = 1 / start_depth
    delta_depth = 1 / end_depth - inverse_depth
    levels = len(depths)
    intervals = np.empty((levels, 2))
    stops = np.empty(2 * levels + 2)
    stops[0], stops[1] = 0.0, 1.0
    for level in range(levels):
        left, bottom, spacing = geometry[level]
        rows, columns = depths[level].shape
        begin, finish = _clip_axis(east, delta_east, left, left + spacing * (columns - 1))
        low, high = _clip_axis(north, delta_north, bottom, bottom + spacing * (rows - 1))
        begin, finish = max(begin, low), min(finish, high)
        intervals[level, 0], intervals[level, 1] = begin, finish
        stops[2 + 2 * level] = begin if begin < finish else 0.0
        stops[3 + 2 * level] = finish if begin < finish else 0.0

    stops.sort()
    status = CLEAR
    for index in range(1, len(stops)):
        start, stop = stops[index - 1], stops[index]
        if stop <= start:
            continue

        # When layers overlap, let the highest-resolution grid own that interval.
        midpoint = (start + stop) / 2
        section_status = UNKNOWN
        hit_fraction = np.nan
        for level in range(levels - 1, -1, -1):
            if intervals[level, 0] <= midpoint <= intervals[level, 1]:
                left, bottom, spacing = geometry[level]
                section_status, hit_fraction = _trace_grid(
                    depths[level],
                    (east - left) / spacing,
                    (north - bottom) / spacing,
                    delta_east / spacing,
                    delta_north / spacing,
                    inverse_depth,
                    delta_depth,
                    start,
                    stop,
                )
                break

        # Sections are visited in order along the ray, so the first blocking
        # section contains the first terrain hit.
        if section_status == BLOCKED:
            if not locate_hit:
                return BLOCKED, np.nan

            # Inverse gnomonic projection at the hit: D = D₀ + f ΔD; E = E₀ + f ΔE; N = N₀ + f ΔN
            #   x_hit = (N/(R D), E/(R D), −1/D)
            #   f (hit_fraction) - Dimensionless position of the hit along the projected ray.
            #   D₀, ΔD (inverse_depth, delta_depth) - Reciprocal −Z depth and its change, in m⁻¹.
            #   E₀, ΔE, N₀, ΔN (east, delta_east, north, delta_north) - Projected coordinates, in metres.
            #   R (MOON_RADIUS_M) - Projection radius, in metres.
            #   x_hit - Moon-fixed hit position; its distance from the origin is returned.
            hit_inverse_depth = inverse_depth + hit_fraction * delta_depth
            hit_east = east + hit_fraction * delta_east
            hit_north = north + hit_fraction * delta_north
            hit_x = hit_north / (MOON_RADIUS_M * hit_inverse_depth)
            hit_y = hit_east / (MOON_RADIUS_M * hit_inverse_depth)
            hit_z = -1 / hit_inverse_depth
            hit_distance = sqrt((hit_x - x) ** 2 + (hit_y - y) ** 2 + (hit_z - z) ** 2)
            return BLOCKED, hit_distance

        if section_status == UNKNOWN:
            status = UNKNOWN

    if reaches_interior:
        return BLOCKED, np.nan
    return status, np.nan


@njit(parallel=True)
def trace_rays(
    origins_m: FloatArray,
    directions: FloatArray,
    depths: tuple[FloatArray, ...],
    geometry: FloatArray,
) -> NDArray[np.int8]:
    """Trace a set of directions per origin using one shared terrain surface."""
    result = np.empty(directions.shape[:2], dtype=np.int8)
    for index in prange(len(origins_m)):
        for ray in range(directions.shape[1]):
            result[index, ray] = trace(origins_m[index], directions[index, ray], depths, geometry)
    return result


@njit(parallel=True)
def trace_rays_to_hits(
    origins_m: FloatArray,
    directions: FloatArray,
    depths: tuple[FloatArray, ...],
    geometry: FloatArray,
) -> tuple[NDArray[np.int8], FloatArray]:
    """Trace rays like `trace_rays`, also returning each first-hit distance in metres."""
    statuses = np.empty(directions.shape[:2], dtype=np.int8)
    hit_distances_m = np.empty(directions.shape[:2])
    for index in prange(len(origins_m)):
        for ray in range(directions.shape[1]):
            statuses[index, ray], hit_distances_m[index, ray] = trace_to_hit(
                origins_m[index], directions[index, ray], depths, geometry
            )
    return statuses, hit_distances_m


@njit(inline="always")
def _clip_axis(origin: float, delta: float, lower: float, upper: float) -> tuple[float, float]:
    if delta == 0:
        return (0.0, 1.0) if lower <= origin <= upper else (1.0, 0.0)

    first = (lower - origin) / delta
    last = (upper - origin) / delta
    return max(0.0, min(first, last)), min(1.0, max(first, last))


@njit
def _trace_grid(
    depths: FloatArray,
    east: float,
    north: float,
    delta_east: float,
    delta_north: float,
    inverse_depth: float,
    delta_depth: float,
    start: float,
    stop: float,
) -> tuple[int, float]:
    """Traverse one grid between projected-ray fractions `start` and `stop`.

    Returns the section status and, when blocked, the ray fraction of the first
    terrain contact (NaN otherwise).
    """
    rows, columns = depths.shape
    step_east = 1 if delta_east > 0 else -1
    step_north = 1 if delta_north > 0 else -1
    column = _entry_cell(east + start * delta_east, step_east, columns - 2)
    row = _entry_cell(north + start * delta_north, step_north, rows - 2)

    next_east = _next_grid_crossing(column, step_east, east, delta_east)
    next_north = _next_grid_crossing(row, step_north, north, delta_north)
    status = CLEAR

    while start < stop and 0 <= column < columns - 1 and 0 <= row < rows - 1:
        cell_end = min(next_east, next_north, stop)
        if cell_end > start:
            # Split at the shared diagonal so the line is checked in each triangle.
            offset_east = east - column
            offset_north = north - row
            slope = delta_east + delta_north
            diagonal = (1 - offset_east - offset_north) / slope if slope else inf
            split = min(diagonal, cell_end) if diagonal > start else cell_end

            for triangle_end in (split, cell_end):
                if triangle_end <= start:
                    continue
                triangle_midpoint = (start + triangle_end) / 2
                upper = offset_east + offset_north + triangle_midpoint * slope > 1
                base, dx, dy = triangle_plane(depths, column, row, upper)
                gap_at_zero = inverse_depth - base - dx * offset_east - dy * offset_north
                gap_slope = delta_depth - dx * delta_east - dy * delta_north

                gap_at_start = gap_at_zero + start * gap_slope
                gap_at_end = gap_at_zero + triangle_end * gap_slope
                if not np.isfinite(gap_at_zero):
                    status = UNKNOWN
                elif max(gap_at_start, gap_at_end) > _DEPTH_TOLERANCE:
                    # Larger reciprocal depth is closer to the projection centre.
                    return BLOCKED, _first_contact(start, gap_at_start, gap_slope)
                start = triangle_end

        if cell_end >= stop:
            return status, np.nan
        if next_east == cell_end:
            column += step_east
            next_east = _next_grid_crossing(column, step_east, east, delta_east)
        if next_north == cell_end:
            row += step_north
            next_north = _next_grid_crossing(row, step_north, north, delta_north)

    # Clipping and grid crossing use different coordinate scales. Only a numerical
    # residue at the last edge can lie beyond the visited cells.
    return (status if stop - start <= 1e-12 else UNKNOWN), np.nan


@njit(inline="always")
def _first_contact(start: float, gap_at_start: float, gap_slope: float) -> float:
    """Ray fraction where the ray first meets a planar triangle it ends up below."""
    if gap_at_start >= 0 or gap_slope <= 0:
        return start

    # Linear gap root: g(f) = g_s + (f − f_s) g′ = 0  ⇒  f = f_s − g_s/g′
    #   g (gap) - Ray minus terrain reciprocal depth; positive means the ray is below the surface, in m⁻¹.
    #   f_s (start), g_s (gap_at_start) - Segment start fraction and gap there.
    #   g′ (gap_slope) - Gap change per unit ray fraction, positive because the ray goes below.
    #   Assumption: Reciprocal depth is affine along the projected ray within one triangle.
    return start - gap_at_start / gap_slope


@njit(inline="always")
def _entry_cell(coordinate: float, step: int, last: int) -> int:
    index = floor(coordinate)
    if step < 0 and coordinate == index:
        index -= 1
    return max(0, min(index, last))


@njit(inline="always")
def _next_grid_crossing(cell: int, step: int, origin: float, delta: float) -> float:
    if delta == 0:
        return inf
    edge = cell + (1 if step > 0 else 0)
    return (edge - origin) / delta
