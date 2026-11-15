"""The individual Sun and Earth rays at the site centre, for display in the 3D view.

These are the same rays the simulation traces: the Sun's disk seen from the collector and
Earth's disk seen from the mast, each sampled with equal-solid-angle directions.
"""

from dataclasses import dataclass
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from ..ephemeris.horizons import EphemerisSample
from ..terrain import mesh
from ..terrain.model import Terrain
from .engine import EARTH_DISK_SAMPLES, Bounds, CentreInstruments, PreparedSite
from .frames import FloatArray
from .radiation import EARTH_MEAN_RADIUS_M, SUN_RADIUS_M, disk_directions


@dataclass(frozen=True)
class RayFan:
    """Rays from one instrument to sample points on a body's apparent disk.

    `directions` has shape (rays, 3). `hit_distances_m` is NaN for rays that are clear,
    unresolved, or blocked by the solid interior across missing terrain.
    """

    origin_m: FloatArray
    body_m: FloatArray
    directions: FloatArray
    statuses: NDArray[np.int8]
    hit_distances_m: FloatArray
    visible_fraction: Bounds


def centre_ray_fans(
    terrain: Terrain,
    instruments: CentreInstruments,
    ephemeris: EphemerisSample,
    solar_disk_samples: int,
) -> tuple[RayFan, RayFan]:
    """Trace the Sun's disk from the collector and Earth's disk from the mast.

    Only terrain is considered. A solar eclipse by Earth, which the simulation also
    accounts for, is not shown in these rays.
    """
    sun = _trace_fan(
        terrain, instruments.collector_origin_m, ephemeris.sun_m, SUN_RADIUS_M, solar_disk_samples
    )
    earth = _trace_fan(
        terrain, instruments.mast_origin_m, ephemeris.earth_m, EARTH_MEAN_RADIUS_M, EARTH_DISK_SAMPLES
    )
    return sun, earth


def _trace_fan(
    terrain: Terrain,
    origin_m: FloatArray,
    body_m: FloatArray,
    body_radius_m: float,
    sample_count: int,
) -> RayFan:
    # Observer translation: v = r − x
    #   v (body_vector_m) - Instrument-to-body-centre vector, Moon-fixed metres.
    #   r (body_m) - Moon-centred body position; x (origin_m) - instrument position, in metres.
    body_vector_m = body_m - origin_m
    disk = disk_directions(body_vector_m[None, :], body_radius_m, sample_count)
    statuses, hit_distances_m = terrain.trace_hits(origin_m[None, :], disk.directions)

    # Equal-weight disk visibility: f₋ = Σⱼ[clearⱼ]/N; f₊ = Σⱼ[not blockedⱼ]/N
    #   f₋, f₊ - Dimensionless visible-disk bounds; unresolved rays count only in f₊.
    #   N (sample_count) - Equal-solid-angle rays across the body's apparent disk.
    visible_fraction = Bounds(
        float(np.mean(statuses[0] == mesh.CLEAR)),
        float(np.mean(statuses[0] != mesh.BLOCKED)),
    )
    return RayFan(
        origin_m=origin_m,
        body_m=body_m,
        directions=disk.directions[0],
        statuses=statuses[0],
        hit_distances_m=hit_distances_m[0],
        visible_fraction=visible_fraction,
    )


# Points shown across a site. The Sun rays are the simulation's own rays from these grid points.
SHOWN_POINTS = 40


def site_ray_arrays(
    prepared: PreparedSite, ephemeris: EphemerisSample, solar_disk_samples: int, max_points: int = SHOWN_POINTS
) -> dict[str, FloatArray]:
    """Trace the Sun and Earth disks from a regular subset of the site's reporting points.

    The simulation traces the Sun's disk from every reporting point of the grid; the Sun rays
    here are exactly those rays for every k-th point in both directions, with the smallest k
    that leaves at most `max_points` points. The simulation reports Earth only at the centre
    mast, so the Earth rays are an illustration: the same disk rays from each point at mast
    height. Only what cannot be recomputed cheaply is returned (origins, statuses and hit
    distances); `fans_from_arrays` rebuilds the directions.
    """
    origins = _shown_origins(prepared, max_points)
    if not len(origins):
        return {}

    settings = prepared.settings
    # Instrument height change: x' = x + Δh·u
    #   x - Receiver origin at collector height; Δh - mast height minus collector height, in metres.
    #   u (receiver_up) - Unit local radial vertical at the receiver.
    lift_m = settings.mast_height_m - settings.collector_height_m
    mast_origins = origins["origins"] + lift_m * origins["up"]

    arrays: dict[str, FloatArray] = {}
    for name, body_m, radius_m, samples, from_m in (
        ("sun", ephemeris.sun_m, SUN_RADIUS_M, solar_disk_samples, origins["origins"]),
        ("earth", ephemeris.earth_m, EARTH_MEAN_RADIUS_M, EARTH_DISK_SAMPLES, mast_origins),
    ):
        disk = disk_directions(body_m[None, :] - from_m, radius_m, samples)
        statuses, hit_distances_m = prepared.terrain.trace_hits(
            np.ascontiguousarray(from_m), np.ascontiguousarray(disk.directions)
        )
        arrays[f"ray_{name}_origins"] = from_m
        arrays[f"ray_{name}_status"] = statuses
        arrays[f"ray_{name}_hit_m"] = hit_distances_m.astype(np.float32)
    return arrays


def fans_from_arrays(
    arrays: dict[str, FloatArray], body: Literal["sun", "earth"], body_m: FloatArray
) -> list[RayFan]:
    """Rebuild each point's `RayFan` from saved origins, statuses and hit distances."""
    origins = arrays[f"ray_{body}_origins"]
    statuses = arrays[f"ray_{body}_status"]
    hits = arrays[f"ray_{body}_hit_m"]
    radius_m = SUN_RADIUS_M if body == "sun" else EARTH_MEAN_RADIUS_M

    disk = disk_directions(body_m[None, :] - origins, radius_m, statuses.shape[1])
    return [
        RayFan(
            origin_m=origins[index],
            body_m=body_m,
            directions=disk.directions[index],
            statuses=statuses[index],
            hit_distances_m=hits[index].astype(np.float64),
            visible_fraction=Bounds(
                float(np.mean(statuses[index] == mesh.CLEAR)),
                float(np.mean(statuses[index] != mesh.BLOCKED)),
            ),
        )
        for index in range(len(origins))
    ]


def _shown_origins(prepared: PreparedSite, max_points: int) -> dict[str, FloatArray]:
    rows, columns = np.nonzero(np.isfinite(prepared.heights_m))
    if not len(rows):
        return {}

    # Subset spacing: the smallest integer k whose k-spaced lattice has at most N points.
    #   k - Grid cells between shown points, in both directions; N (max_points) - upper limit.
    stride = 1
    while np.count_nonzero((rows % stride == 0) & (columns % stride == 0)) > max_points:
        stride += 1
    chosen = np.nonzero((rows % stride == 0) & (columns % stride == 0))[0]
    return {"origins": prepared.solar_origins_m[chosen], "up": prepared.receiver_up[chosen]}
