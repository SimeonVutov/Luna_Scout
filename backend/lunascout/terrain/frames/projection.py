"""DEM map coordinates <-> latitude/longitude.

Map (x, y): south polar stereographic on the 1737.4 km sphere, metres, true scale at the pole,
+y toward 0 deg E (Earth-facing side), +x toward 90 deg E. This is the native grid of the
LOLA south-pole DEM (see lunascout/terrain/CONVENTIONS.md).
"""
import numpy as np

from ..constants import MOON_RADIUS_M as R


def map_to_latlon(x, y):
    """Map metres -> (lat, lon) degrees. lon in (-180, 180], east-positive."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    rho = np.hypot(x, y)
    lat = -90.0 + np.degrees(2.0 * np.arctan(rho / (2.0 * R)))
    lon = np.degrees(np.arctan2(x, y))
    return lat, lon


def latlon_to_map(lat, lon):
    """(lat, lon) degrees -> map metres. Valid for the southern hemisphere."""
    lat, lon = np.radians(np.asarray(lat, float)), np.radians(np.asarray(lon, float))
    rho = 2.0 * R * np.tan((np.pi / 2 + lat) / 2.0)
    return rho * np.sin(lon), rho * np.cos(lon)


def map_scale_factor(lat):
    """Map distance / ground distance at latitude `lat` (1.0 at the pole, 1.0077 at 80 S)."""
    return 2.0 / (1.0 + np.sin(np.abs(np.radians(np.asarray(lat, float)))))
