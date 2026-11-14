"""Moon-fixed 3D coordinates (MOON_ME) and local site directions.

- Latitude: planetocentric, degrees, south negative. Longitude: degrees EAST.
- XYZ: MOON_ME frame, metres, origin at the Moon's centre, +Z north pole,
  +X toward 0 deg E (mean Earth direction), +Y toward 90 deg E.
- Height h: metres above the 1737.4 km reference sphere (what the DEM stores).
- Local frame at a site: East / North / Up, with Up = radial direction.
"""
import numpy as np

from ..constants import MOON_RADIUS_M as R
from .projection import map_to_latlon


def up_vector(lat, lon):
    """Unit radial ("up") vector(s) in MOON_ME. Shape (..., 3)."""
    la, lo = np.radians(np.asarray(lat, float)), np.radians(np.asarray(lon, float))
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)


def latlon_h_to_xyz(lat, lon, h):
    """lat/lon degrees + height above the sphere (m) -> MOON_ME XYZ (m). Shape (..., 3)."""
    return (R + np.asarray(h, float))[..., None] * up_vector(lat, lon)


def map_h_to_xyz(x, y, h):
    """DEM map metres + DEM height (m) -> MOON_ME XYZ (m)."""
    lat, lon = map_to_latlon(x, y)
    return latlon_h_to_xyz(lat, lon, h)


def xyz_to_latlon_h(xyz):
    """MOON_ME XYZ (m) -> (lat deg, lon deg, height above sphere m).
    Also gives the sub-point and altitude of an orbiter given in MOON_ME."""
    xyz = np.asarray(xyz, float)
    r = np.linalg.norm(xyz, axis=-1)
    lat = np.degrees(np.arcsin(xyz[..., 2] / r))
    lon = np.degrees(np.arctan2(xyz[..., 1], xyz[..., 0]))
    return lat, lon, r - R


def enu_basis(lat, lon):
    """Local East/North/Up unit vectors at one lat/lon, as rows of a 3x3 matrix.

    enu_basis(lat, lon) @ v_me  ->  (east, north, up) components of a MOON_ME vector.
    At the exact pole east/north are undefined; the given lon then picks the meridian
    that "north" points along.
    """
    la, lo = np.radians(float(lat)), np.radians(float(lon))
    up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    north = np.cross(up, east)
    return np.vstack([east, north, up])


def az_el(vec_me, lat, lon):
    """Direction(s) in MOON_ME -> azimuth (deg from north toward east, [0, 360)) and elevation
    (deg above the reference sphere's horizontal plane at lat/lon). Terrain is NOT considered."""
    enu = np.asarray(vec_me, float) @ enu_basis(lat, lon).T
    e, n, u = enu[..., 0], enu[..., 1], enu[..., 2]
    az = np.degrees(np.arctan2(e, n)) % 360.0
    az = np.where(az >= 360.0, 0.0, az)  # -1e-17 % 360 == 360.0 in floating point
    el = np.degrees(np.arctan2(u, np.hypot(e, n)))
    return az, el


def az_el_to_vector(az, el, lat, lon):
    """Inverse of az_el: unit direction(s) in MOON_ME for azimuth/elevation at a site."""
    a, e = np.radians(np.asarray(az, float)), np.radians(np.asarray(el, float))
    enu = np.stack([np.cos(e) * np.sin(a), np.cos(e) * np.cos(a), np.sin(e)], axis=-1)
    return enu @ enu_basis(lat, lon)


def look_angles(site_xyz, target_xyz, lat, lon):
    """Azimuth, elevation (deg) and range (m) from a site to target position(s), all in MOON_ME.
    Use for orbiters, relays or any point whose Moon-fixed position is known."""
    v = np.asarray(target_xyz, float) - np.asarray(site_xyz, float)
    rng = np.linalg.norm(v, axis=-1)
    az, el = az_el(v, lat, lon)
    return az, el, rng
