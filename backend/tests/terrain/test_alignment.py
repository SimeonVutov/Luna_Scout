"""Compatibility with Sun/Earth data from JPL.

The fixture holds real JPL Horizons output: Moon-centred Sun/Earth vectors in ICRF (the form
the Sun/Earth pipeline is expected to hand over) and Horizons' own azimuth/elevation seen
from a surface site. Converting the vectors with our frames must reproduce Horizons' angles.
This proves time handling, frame (MOON_ME vs Horizons' mean-Earth frame), site placement and
local east/north/up all line up. Regenerate with tests/terrain/fixtures/make_horizons_fixture.py.
"""
import json
from pathlib import Path

import numpy as np
import pytest

from lunascout.terrain.frames import az_el, latlon_h_to_xyz, to_moon_me

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "horizons_alignment.json").read_text())
SITE = FIXTURE["site"]


def _angle_arcsec(az1, el1, az2, el2):
    a1, e1, a2, e2 = map(np.radians, (az1, el1, az2, el2))
    v1 = np.stack([np.cos(e1) * np.sin(a1), np.cos(e1) * np.cos(a1), np.sin(e1)], -1)
    v2 = np.stack([np.cos(e2) * np.sin(a2), np.cos(e2) * np.cos(a2), np.sin(e2)], -1)
    return np.degrees(np.arctan2(np.linalg.norm(np.cross(v1, v2), axis=-1), np.einsum("ij,ij->i", v1, v2))) * 3600


@pytest.mark.parametrize("body", ["SUN", "EARTH"])
def test_jpl_vectors_line_up_with_jpl_sky_angles(body):
    b = FIXTURE["bodies"][body]
    vec_me = to_moon_me(np.array(b["vector_icrf_moon_centred_km_lt_s"]) * 1000.0, "ICRF", b["utc"])
    site = latlon_h_to_xyz(SITE["lat"], SITE["lon"], SITE["height_km"] * 1000.0)
    az, el = az_el(vec_me - site, SITE["lat"], SITE["lon"])
    err = _angle_arcsec(az, el, np.array(b["site_azimuth_deg"]), np.array(b["site_elevation_deg"]))
    # Measured: Sun ~0.0002, Earth ~0.05 arcsec. The Earth residual comes from Horizons applying
    # its light-time/aberration corrections from the Moon's centre in the vector table but from the
    # site in the observer table. A frame mix-up would be >= ~18 arcsec (IAU_MOON) and skipping the
    # rotation ~94 degrees, so 0.5 arcsec cleanly separates "aligned" from "misaligned".
    assert err.max() < 0.5, f"{body}: max {err.max():.4f} arcsec"


def test_wrong_moon_frames_are_refused():
    for bad in ("IAU_MOON", "MOON_PA", "BODY EQUATOR"):
        with pytest.raises(ValueError):
            to_moon_me([1.0, 0, 0], bad, "2028-01-10T00:00:00")
    with pytest.raises(ValueError):
        to_moon_me([1.0, 0, 0], "ECLIPJ2000_typo", "2028-01-10T00:00:00")


def test_moon_me_passthrough():
    v = np.array([[1.0, 2.0, 3.0]])
    assert np.array_equal(to_moon_me(v, "MOON_ME", "2028-01-10T00:00:00"), v)

