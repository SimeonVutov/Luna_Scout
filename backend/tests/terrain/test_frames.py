import numpy as np
import pytest

from lunascout.terrain.constants import MOON_RADIUS_M as R
from lunascout.terrain.frames import (az_el, az_el_to_vector, enu_basis, latlon_h_to_xyz, latlon_to_map,
                              look_angles, map_scale_factor, map_to_latlon,
                              xyz_to_latlon_h)


def test_stereo_matches_pyproj():
    pyproj = pytest.importorskip("pyproj")
    t = pyproj.Transformer.from_proj(f"+proj=stere +lat_0=-90 +lon_0=0 +R={R} +units=m",
                                     f"+proj=longlat +R={R}", always_xy=True)
    rng = np.random.default_rng(0)
    x, y = rng.uniform(-304e3, 304e3, (2, 1000))
    lon_p, lat_p = t.transform(x, y)
    lat, lon = map_to_latlon(x, y)
    assert np.allclose(lat, lat_p, atol=1e-10)
    assert np.allclose(((lon - lon_p + 180) % 360) - 180, 0, atol=1e-9)


def test_roundtrips():
    rng = np.random.default_rng(1)
    lat = rng.uniform(-89.999, -75, 500)
    lon = rng.uniform(-180, 180, 500)
    x, y = latlon_to_map(lat, lon)
    lat2, lon2 = map_to_latlon(x, y)
    assert np.allclose(lat, lat2, atol=1e-10) and np.allclose(lon, lon2, atol=1e-8)
    h = rng.uniform(-8000, 8000, 500)
    la, lo, hh = xyz_to_latlon_h(latlon_h_to_xyz(lat, lon, h))
    assert np.allclose(la, lat, atol=1e-10) and np.allclose(lo, lon, atol=1e-8) and np.allclose(hh, h, atol=1e-6)


def test_known_points():
    # pole: straight down the -Z axis
    assert np.allclose(latlon_h_to_xyz(-90, 0, 1000), [0, 0, -(R + 1000)], atol=1e-6)
    # 80S on the 90E meridian -> +x on the map, +Y in 3D
    x, y = latlon_to_map(-80, 90)
    assert abs(y) < 1e-6 and abs(x - 2 * R * np.tan(np.radians(5))) < 1e-6


def test_enu_and_azel():
    lat, lon = -89.5, 40.0
    B = enu_basis(lat, lon)
    assert np.allclose(B @ B.T, np.eye(3), atol=1e-12)
    east, north, up = B
    assert np.isclose(az_el(north, lat, lon)[0], 0) and np.isclose(az_el(east, lat, lon)[0], 90)
    assert np.isclose(az_el(up, lat, lon)[1], 90)
    # moving "north" increases latitude; moving "east" increases longitude
    p = latlon_h_to_xyz(lat, lon, 0)
    assert xyz_to_latlon_h(p + 1000 * north)[0] > lat
    assert xyz_to_latlon_h(p + 1000 * east)[1] > lon


def test_az_el_vector_roundtrip_and_look_angles():
    lat, lon = -88.2, -131.0
    az = np.array([0.0, 45.0, 180.0, 300.0])
    el = np.array([0.0, 10.0, -3.0, 89.0])
    d = az_el_to_vector(az, el, lat, lon)
    az2, el2 = az_el(d, lat, lon)
    assert np.allclose(az2, az, atol=1e-9) and np.allclose(el2, el, atol=1e-9)
    site = latlon_h_to_xyz(lat, lon, 500.0)
    a, e, r = look_angles(site, site + 12_345.0 * d, lat, lon)
    assert np.allclose(a, az, atol=1e-7) and np.allclose(e, el, atol=1e-7) and np.allclose(r, 12_345.0)


def test_map_scale_factor():
    assert map_scale_factor(-90) == 1.0
    assert np.isclose(map_scale_factor(-80), 1.00765, atol=1e-5)
    # numerical check: 1 m on the ground along a meridian at 80 S is `k` metres on the map
    x1, y1 = latlon_to_map(-80, 30)
    x2, y2 = latlon_to_map(-80 + np.degrees(1.0 / R), 30)
    assert np.isclose(np.hypot(x2 - x1, y2 - y1), map_scale_factor(-80), atol=1e-6)
