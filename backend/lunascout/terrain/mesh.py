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
    x, y, z = origin_m
    dx, dy, dz = direction
    origin_radius_sq = x * x + y * y + z * z
    along_ray = x * dx + y * dy + z * dz
    if not 0 < origin_radius_sq < OUTER_RADIUS_M**2 or not np.isfinite(along_ray):
        return UNKNOWN

    closest_sq = origin_radius_sq - along_ray**2

    # A ray reaching the guaranteed solid interior is blocked even across DEM gaps.
    if along_ray < 0 and closest_sq <= INNER_RADIUS_M**2:
        return BLOCKED

    exit_distance = -along_ray + sqrt(OUTER_RADIUS_M**2 - closest_sq)
    start_depth = -z
    end_depth = -z - exit_distance * dz
    if min(start_depth, end_depth) <= 0:
        return UNKNOWN

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
        for level in range(levels - 1, -1, -1):
            if intervals[level, 0] <= midpoint <= intervals[level, 1]:
                left, bottom, spacing = geometry[level]
                section_status = _trace_grid(
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

        if section_status == BLOCKED:
            return BLOCKED
        if section_status == UNKNOWN:
            status = UNKNOWN

    return status


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
) -> int:
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

                if not np.isfinite(gap_at_zero):
                    status = UNKNOWN
                elif (
                    max(
                        gap_at_zero + start * gap_slope,
                        gap_at_zero + triangle_end * gap_slope,
                    )
                    > _DEPTH_TOLERANCE
                ):
                    # Larger reciprocal depth is closer to the projection centre.
                    return BLOCKED
                start = triangle_end

        if cell_end >= stop:
            return status
        if next_east == cell_end:
            column += step_east
            next_east = _next_grid_crossing(column, step_east, east, delta_east)
        if next_north == cell_end:
            row += step_north
            next_north = _next_grid_crossing(row, step_north, north, delta_north)

    # Clipping and grid crossing use different coordinate scales. Only a numerical
    # residue at the last edge can lie beyond the visited cells.
    return status if stop - start <= 1e-12 else UNKNOWN


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
