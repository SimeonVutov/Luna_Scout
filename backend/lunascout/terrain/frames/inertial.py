"""Moon-fixed (MOON_ME) <-> inertial (J2000/ICRF) transformations.

This is how Sun, Earth and orbit data computed elsewhere (e.g. from JPL) is brought into
the terrain's frame. Use to_moon_me() for incoming vectors.

Ephemerides and orbits are given in a non-rotating frame; terrain lives in the rotating Moon-fixed
frame. These functions move positions, velocities and directions between the two, using
the DE440 lunar orientation (libration included).

Inertial frame here = SPICE "J2000" (aligned with ICRF to ~0.02 arcsec), Moon-centred,
metres and metres/second.
"""
import numpy as np
import spiceypy as spice

from ..constants import MOON_FRAME
from .bodyfixed import latlon_h_to_xyz
from .spice_kernels import as_et, load_kernels

INERTIAL_FRAME = "J2000"


def rotation_inertial_to_me(times) -> np.ndarray:
    """(T, 3, 3) matrices R with  v_me = R @ v_inertial  at each time (UTC strings or ET)."""
    load_kernels()
    return np.array([spice.pxform(INERTIAL_FRAME, MOON_FRAME, float(t)) for t in as_et(times)])


def rotation_me_to_inertial(times) -> np.ndarray:
    """(T, 3, 3) matrices with  v_inertial = R @ v_me."""
    return np.transpose(rotation_inertial_to_me(times), (0, 2, 1))


def inertial_to_me(pos_inertial, times) -> np.ndarray:
    """Moon-centred inertial position(s) (T, 3) or (3,) -> MOON_ME, one time per row."""
    R = rotation_inertial_to_me(times)
    p = np.atleast_2d(np.asarray(pos_inertial, float))
    return np.einsum("tij,tj->ti", R, np.broadcast_to(p, (len(R), 3)))


def me_to_inertial(pos_me, times) -> np.ndarray:
    """MOON_ME position(s) -> Moon-centred inertial, one time per row."""
    R = rotation_me_to_inertial(times)
    p = np.atleast_2d(np.asarray(pos_me, float))
    return np.einsum("tij,tj->ti", R, np.broadcast_to(p, (len(R), 3)))


def state_inertial_to_me(state_inertial, times) -> np.ndarray:
    """Position+velocity (T, 6) [m, m/s], Moon-centred inertial -> MOON_ME.
    Velocity includes the Moon's rotation (so a point fixed on the surface gets zero velocity)."""
    load_kernels()
    s = np.atleast_2d(np.asarray(state_inertial, float))
    et = as_et(times)
    out = np.empty((len(et), 6))
    for k, t in enumerate(et):
        out[k] = np.array(spice.sxform(INERTIAL_FRAME, MOON_FRAME, float(t))) @ s[min(k, len(s) - 1)]
    return out


def state_me_to_inertial(state_me, times) -> np.ndarray:
    """Position+velocity (T, 6) in MOON_ME -> Moon-centred inertial."""
    load_kernels()
    s = np.atleast_2d(np.asarray(state_me, float))
    et = as_et(times)
    out = np.empty((len(et), 6))
    for k, t in enumerate(et):
        out[k] = np.array(spice.sxform(MOON_FRAME, INERTIAL_FRAME, float(t))) @ s[min(k, len(s) - 1)]
    return out


_INERTIAL_ALIASES = {"J2000", "ICRF", "EME2000"}
_WRONG_MOON_FRAMES = {
    "IAU_MOON": "differs from the DEM's frame by up to ~155 m (truncated libration formula)",
    "MOON_PA": "is the principal-axes frame, ~875 m from the DEM's mean-Earth frame",
    "MOON_PA_DE440": "is the principal-axes frame, ~875 m from the DEM's mean-Earth frame",
    "MOON_PA_DE421": "is the principal-axes frame, ~875 m from the DEM's mean-Earth frame",
    "BODY EQUATOR": "(Horizons REF_PLANE=BODY EQUATOR) is not Moon-fixed in longitude",
}


def to_moon_me(vectors, from_frame: str, times) -> np.ndarray:
    """Bring externally supplied vectors (e.g. Sun/Earth/orbiter from JPL) into the terrain frame.

    vectors:    (3,) or (T, 3) positions or directions, any length unit (returned in the same unit)
    from_frame: "MOON_ME" (returned unchanged) or an inertial frame: "J2000" / "ICRF" / "EME2000".
                ICRF and J2000 differ by ~0.02 arcsec (frame bias), negligible here.
    times:      UTC string(s) or ephemeris times, one per vector row (or one for all).

    Moon-fixed frames that do NOT match the terrain are refused with an explanation.
    """
    f = from_frame.strip().upper()
    if f in ("MOON_ME", "MOON_ME_DE440_ME421"):
        return np.atleast_2d(np.asarray(vectors, float)).copy()
    if f in _WRONG_MOON_FRAMES:
        raise ValueError(f"{from_frame} {_WRONG_MOON_FRAMES[f]}. Supply vectors in J2000/ICRF or MOON_ME.")
    if f not in _INERTIAL_ALIASES:
        raise ValueError(f"Unsupported frame {from_frame!r}. Supply vectors in J2000/ICRF or MOON_ME.")
    return inertial_to_me(vectors, times)


def site_state_inertial(lat, lon, height_m, times) -> np.ndarray:
    """Position+velocity (T, 6) of a fixed surface site in the Moon-centred inertial frame.
    The site moves in this frame because the Moon rotates."""
    site = np.concatenate([latlon_h_to_xyz(lat, lon, height_m), np.zeros(3)])
    return state_me_to_inertial(site, times)
