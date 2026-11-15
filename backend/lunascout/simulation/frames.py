"""Coordinate conventions shared by ephemerides, terrain, and ray tracing."""

from dataclasses import dataclass
from math import cos, isfinite, radians, sin

import numpy as np
from numpy.typing import NDArray

FloatArray = NDArray[np.float64]
MOON_RADIUS_M = 1_737_400.0
LUNAR_FRAME = "MOON_ME_DE440_ME421"


@dataclass(frozen=True)
class SiteFootprint:
    """Circular site on the south polar Moon, using east-positive longitude."""

    latitude_deg: float
    longitude_deg: float
    radius_m: float

    def __post_init__(self) -> None:
        if not -90 <= self.latitude_deg <= -60:
            raise ValueError("LOLA polar terrain supports site centres from 90°S to 60°S.")
        if not -180 <= self.longitude_deg <= 180:
            raise ValueError("Longitude must be between -180° and 180°.")
        if not isfinite(self.radius_m) or not 0 < self.radius_m < MOON_RADIUS_M:
            raise ValueError("Site radius must be positive and smaller than the lunar radius.")


def local_axes(
    latitude_deg: float, longitude_deg: float
) -> tuple[FloatArray, FloatArray, FloatArray]:
    """Return unit east, north and radial-up vectors for east-positive longitude."""
    latitude = radians(latitude_deg)
    longitude = radians(longitude_deg)
    # Spherical east/north/up basis:
    #   e = (−sin λ, cos λ, 0)
    #   u = (cos φ cos λ, cos φ sin λ, sin φ); n = u × e
    #   φ (latitude) - Spherical latitude, in radians.
    #   λ (longitude) - East-positive longitude, in radians.
    #   e, n, u (east, north, up) - Unit axes in lunar Moon-fixed XYZ.
    #   Assumption: At a pole the supplied longitude defines tangent orientation.
    east = np.array([-sin(longitude), cos(longitude), 0.0])
    up = np.array([cos(latitude) * cos(longitude), cos(latitude) * sin(longitude), sin(latitude)])
    north = np.cross(up, east)
    return east, north, up


def site_directions(
    site: SiteFootprint, east_m: FloatArray, north_m: FloatArray
) -> tuple[FloatArray, FloatArray]:
    """Map local offsets to lunar unit vectors and return the spherical area area_weights."""
    east, north, up = local_axes(site.latitude_deg, site.longitude_deg)

    # Spherical exponential map and area Jacobian:
    #   θ = √(E² + N²)/R; t = E e + N n; w = sin θ/θ
    #   u = cos θ u₀ + w t/R
    #   E, N (east_m, north_m) - Local reporting offsets, in metres.
    #   R (MOON_RADIUS_M) - Spherical datum radius, in metres.
    #   θ (distance_angle_rad) - Dimensionless geodesic distance angle.
    #   t (tangent_offset_m) - Tangent displacement in Moon-fixed metres.
    #   e, n, u₀ (east, north, up) - Unit center basis vectors.
    #   w (area_weights) - Dimensionless spherical area Jacobian, 1 at θ = 0.
    #   u (radial_directions) - Unit radial direction per reporting point.
    #   NumPy sinc takes π-scaled arguments and handles θ = 0 continuously.
    distance_angle_rad = np.hypot(east_m, north_m) / MOON_RADIUS_M
    tangent_offset_m = east_m[..., None] * east + north_m[..., None] * north
    area_weights = np.sinc(distance_angle_rad / np.pi)
    radial_directions = np.cos(distance_angle_rad)[..., None] * up + area_weights[..., None] * tangent_offset_m / MOON_RADIUS_M
    return radial_directions, area_weights


def to_polar_gnomonic(position_m: FloatArray) -> FloatArray:
    """Project southern lunar Cartesian positions onto the south-polar plane.

    At longitude zero, moving away from the pole increases projected northing.
    The last input axis holds the three Cartesian components.
    """
    # South-polar gnomonic projection: E = −R Y/Z; N = −R X/Z
    #   E, N - Projected east/north coordinates, in metres.
    #   R (MOON_RADIUS_M) - Spherical datum radius, in metres.
    #   X, Y, Z (position_m) - Moon-fixed Cartesian components, common units.
    #   Assumption: Southern inputs have Z < 0; the equator is singular.
    return -MOON_RADIUS_M * position_m[..., [1, 0]] / position_m[..., 2, None]
