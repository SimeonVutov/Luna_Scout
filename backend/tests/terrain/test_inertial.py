"""Moon-fixed <-> inertial transforms. Needs the SPICE kernels (python scripts/fetch_data.py)."""
import numpy as np
import spiceypy as spice

from lunascout.terrain.constants import MOON_RADIUS_M as R
from lunascout.terrain.frames import (inertial_to_me, latlon_h_to_xyz, load_kernels, me_to_inertial,
                              rotation_inertial_to_me, site_state_inertial, state_inertial_to_me,
                              time_grid)


def _et():
    return time_grid("2028-01-01T00:00:00", "2028-01-29T00:00:00", 2 * 86400)


def test_rotations_are_proper_and_invertible():
    Rm = rotation_inertial_to_me(_et())
    assert np.allclose(Rm @ np.transpose(Rm, (0, 2, 1)), np.eye(3), atol=1e-12)
    assert np.allclose(np.linalg.det(Rm), 1.0)
    p = np.array([1.8e6, -2.0e5, 3.0e5])
    assert np.allclose(inertial_to_me(me_to_inertial(p, _et()), _et()), p, atol=1e-6)


def test_moon_me_is_the_de421_aligned_frame():
    """MOON_ME must be the alias of MOON_ME_DE440_ME421 (the frame matching the DEM)."""
    load_kernels()
    for t in _et():
        assert np.allclose(spice.pxform("MOON_ME", "MOON_ME_DE440_ME421", float(t)), np.eye(3), atol=1e-15)


def test_moon_spin_axis_and_rotation_rate():
    """+Z of MOON_ME is the spin axis: it stays ~1.5 deg from the ecliptic pole and ~6.7 deg
    from Earth's equator pole, and the Moon turns once per sidereal month."""
    et = _et()
    Rm = rotation_inertial_to_me(et)
    z_inertial = Rm[:, 2, :]  # MOON_ME +Z expressed in J2000
    tilt_to_j2000_pole = np.degrees(np.arccos(z_inertial[:, 2]))
    assert np.all((tilt_to_j2000_pole > 0) & (tilt_to_j2000_pole < 30))
    x_inertial = Rm[:, 0, :]
    turn = np.degrees(np.arccos(np.clip(np.einsum("ij,ij->i", x_inertial[:-1], x_inertial[1:]), -1, 1)))
    assert np.allclose(turn, 360 / 27.321661 * 2, atol=1.0)  # ~26.35 deg per 2 days


def test_site_velocity_is_moon_rotation():
    """A fixed site moves in the inertial frame at omega x r; converting back gives zero velocity."""
    et = _et()
    s = site_state_inertial(0.0, 45.0, 0.0, et)  # equator
    speed = np.linalg.norm(s[:, 3:], axis=1)
    expected = 2 * np.pi / (27.321661 * 86400) * R  # sidereal rotation, ~4.62 m/s
    assert np.allclose(speed, expected, rtol=2e-3)
    back = state_inertial_to_me(s, et)
    assert np.abs(back[:, 3:]).max() < 1e-9
    assert np.allclose(back[:, :3], latlon_h_to_xyz(0.0, 45.0, 0.0), atol=1e-6)
