"""SPICE kernel loading and time conversion (UTC <-> TDB).

Kernels are listed in backend/manifests/spice_kernels.json and fetched by scripts/fetch_data.py.
"""
import numpy as np
import spiceypy as spice

from ..constants import SPICE_DIR, SPICE_KERNELS

_loaded = False


def load_kernels():
    """Load the project's SPICE kernels once per process."""
    global _loaded
    if _loaded:
        return
    for name in SPICE_KERNELS:
        p = SPICE_DIR / name
        if not p.exists():
            raise FileNotFoundError(f"{p} missing. Run: python scripts/fetch_data.py")
        spice.furnsh(str(p))
    _loaded = True


def utc_to_et(utc) -> np.ndarray:
    """UTC ISO string(s), e.g. '2028-01-12T04:00:00' -> ephemeris time (TDB seconds past J2000)."""
    load_kernels()
    if isinstance(utc, str):
        utc = [utc]
    return np.array([spice.str2et(u) for u in utc])


def et_to_utc(et, precision=0) -> list[str]:
    """Ephemeris time(s) -> UTC ISO strings."""
    load_kernels()
    return [spice.et2utc(float(t), "ISOC", precision) for t in np.atleast_1d(et)]


def time_grid(start_utc: str, stop_utc: str, step_s: float) -> np.ndarray:
    """Evenly spaced ephemeris times (TDB seconds) from start to stop inclusive."""
    et0, et1 = utc_to_et([start_utc, stop_utc])
    return np.arange(et0, et1 + 0.5 * step_s, step_s)


def as_et(times) -> np.ndarray:
    """Accept UTC string(s) or ephemeris-time number(s); return an array of ephemeris times."""
    if isinstance(times, str) or (np.ndim(times) and isinstance(np.asarray(times).flat[0], str)):
        return utc_to_et(times)
    return np.atleast_1d(np.asarray(times, float))
