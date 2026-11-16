"""Sun and Earth positions seen from the Moon, computed locally with NASA NAIF SPICE.

The positions come from JPL's DE440 planetary ephemeris (NAIF kernel `de440s.bsp`) and are
rotated into the Moon-fixed frame of the terrain with NAIF's lunar orientation kernels. Nothing
is fetched at run time, so any date from 1849 to 2150 is available instantly.

JPL Horizons serves the same ephemeris family (it reports DE441). Over 2026–2028 the two agree
to within 35 m for the Sun and 5 m for Earth, about 0.00005 and 0.0025 arcseconds as seen from
the Moon, which changes no result. `lunascout-science check-ephemeris` repeats that comparison.
"""

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from threading import Lock
from typing import Literal

import numpy as np
import spiceypy as spice
from spiceypy.utils.exceptions import SpiceyError

from ..simulation.frames import LUNAR_FRAME, FloatArray

# Leap seconds, the lunar frame definition, lunar orientation, and the planetary ephemeris.
KERNEL_NAMES = (
    "naif0012.tls",
    "moon_de440_250416.tf",
    "moon_pa_de440_200625.bpc",
    "de440s.bsp",
)
EPHEMERIS_SOURCE = "JPL DE440 (NASA NAIF de440s.bsp)"
# Samples are grouped in batches of this size, so runs and the 3D view share cached batches.
BATCH_SIZE = 32

Correction = Literal["NONE", "LT+S"]

# The SPICE kernel pool is shared by the whole process, and the API serves requests on threads.
_spice_lock = Lock()


class EphemerisError(RuntimeError):
    """SPICE could not provide the requested state."""


@dataclass(frozen=True)
class EphemerisSample:
    """Sun and Earth positions in lunar Cartesian metres at one UTC instant."""

    at_utc: datetime
    et_tdb_seconds: float
    sun_m: FloatArray
    earth_m: FloatArray
    frame: str = LUNAR_FRAME


@dataclass(frozen=True)
class Ephemerides:
    """State series and provenance for a common Moon-fixed frame."""

    samples: tuple[EphemerisSample, ...]
    frame: str
    correction: Correction
    source: str
    kernels_sha256: dict[str, str]


def kernel_paths(data_dir: Path) -> tuple[Path, ...]:
    return tuple(data_dir / "raw" / "spice" / name for name in KERNEL_NAMES)


def load_ephemerides(
    start_utc: datetime,
    end_utc: datetime,
    *,
    data_dir: Path,
    step: timedelta = timedelta(hours=1),
    correction: Correction = "NONE",
) -> Ephemerides:
    """Positions over a regularly sampled, half-open UTC interval `[start, end)`."""
    start = _as_utc(start_utc)
    end = _as_utc(end_utc)
    if end <= start or step <= timedelta(0):
        raise ValueError("Expected a positive step and an end after the start.")

    sample_count = (end - start - timedelta(microseconds=1)) // step + 1
    times = tuple(start + i * step for i in range(sample_count))
    return load_ephemerides_at(times, data_dir=data_dir, correction=correction)


def load_ephemerides_at(
    times_utc: tuple[datetime, ...],
    *,
    data_dir: Path,
    correction: Correction = "NONE",
) -> Ephemerides:
    """Sun and Earth positions at increasing UTC epochs.

    `LT+S` applies reception light time and stellar aberration at the Moon's centre, the
    correction an observer on the Moon sees. A ray origin still needs to be subtracted to
    account for surface parallax.
    """
    times = tuple(_as_utc(time) for time in times_utc)
    if not times or any(a >= b for a, b in zip(times, times[1:])):
        raise ValueError("Ephemeris epochs must be nonempty and strictly increasing.")
    if correction not in ("NONE", "LT+S"):
        raise ValueError("The correction must be NONE or LT+S.")

    paths = kernel_paths(data_dir)
    sun_km, earth_km, epochs, rotations = _compute(times, paths, correction)

    # Frame rotation and unit conversion: r_MF = 1000 Q r_J2000
    #   r_MF (sun_m/earth_m) - Moon-fixed body positions, in metres.
    #   Q (rotations) - J2000-to-lunar rotation matrices, epoch × XYZ × XYZ.
    #   r_J2000 (sun_km/earth_km) - Moon-centred positions in kilometres; J2000 is ICRF-aligned.
    #   1000 - Exact metres per kilometre.
    sun_m = np.einsum("nij,nj->ni", rotations, sun_km) * 1000.0
    earth_m = np.einsum("nij,nj->ni", rotations, earth_km) * 1000.0

    return Ephemerides(
        samples=tuple(
            EphemerisSample(time, float(epoch), sun, earth)
            for time, epoch, sun, earth in zip(times, epochs, sun_m, earth_m, strict=True)
        ),
        frame=LUNAR_FRAME,
        correction=correction,
        source=EPHEMERIS_SOURCE,
        kernels_sha256={path.name: file_sha256(path) for path in paths},
    )


def positions_j2000_km(
    times_utc: tuple[datetime, ...], *, data_dir: Path, correction: Correction = "LT+S"
) -> tuple[FloatArray, FloatArray, FloatArray]:
    """Moon-centred Sun and Earth positions on J2000 (ICRF) axes in kilometres, and the TDB epochs.

    The form JPL Horizons reports, so the two can be compared directly.
    """
    times = tuple(_as_utc(time) for time in times_utc)
    sun_km, earth_km, epochs, _ = _compute(times, kernel_paths(data_dir), correction)
    return sun_km, earth_km, epochs


def _compute(
    times: tuple[datetime, ...], paths: tuple[Path, ...], correction: Correction
) -> tuple[FloatArray, FloatArray, FloatArray, FloatArray]:
    """Sun and Earth on J2000 axes in km, TDB epochs, and J2000-to-lunar rotations."""
    missing = [path.name for path in paths if not path.is_file()]
    if missing:
        raise EphemerisError(
            f"Missing SPICE kernels ({', '.join(missing)}). Run lunascout-science fetch-data."
        )

    count = len(times)
    epochs = np.empty(count)
    sun_km = np.empty((count, 3))
    earth_km = np.empty((count, 3))
    rotations = np.empty((count, 3, 3))
    try:
        # The kernel pool is restored when the lock is released, so no state leaks between calls.
        with _spice_lock, spice.KernelPool([str(path) for path in paths]):
            for row, time in enumerate(times):
                epoch = spice.str2et(time.strftime("%Y-%m-%d %H:%M:%S.%f UTC"))
                epochs[row] = epoch
                rotations[row] = spice.pxform("J2000", LUNAR_FRAME, epoch)
                sun_km[row] = spice.spkpos("SUN", epoch, "J2000", correction, "MOON")[0]
                earth_km[row] = spice.spkpos("EARTH", epoch, "J2000", correction, "MOON")[0]
    except SpiceyError as exc:
        raise EphemerisError("SPICE could not compute the Sun and Earth for these times.") from exc
    return sun_km, earth_km, epochs, rotations


def _as_utc(time: datetime) -> datetime:
    if time.utcoffset() is None:
        raise ValueError("Ephemeris timestamps need a UTC offset.")
    return time.astimezone(UTC)


def file_sha256(path: Path) -> str:
    """Checksum of a file, computed once per file version."""
    details = path.stat()
    return _checksum(path, details.st_size, details.st_mtime_ns)


@lru_cache(maxsize=64)
def _checksum(path: Path, _size: int, _modified_ns: int) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()
