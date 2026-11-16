"""Check the local SPICE positions against JPL Horizons, for the monthly spot-check.

The application computes every position with SPICE. This module asks Horizons for the same
Moon-centred Sun and Earth positions at a few epochs and reports the largest difference, so a
change on either side (a new JPL ephemeris, a damaged kernel file) is noticed. Horizons asks
automated clients to identify themselves: the contact comes from LUNASCOUT_HORIZONS_CONTACT.
"""

import csv
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np

from ..simulation.frames import FloatArray
from .states import BATCH_SIZE, Correction, EphemerisError, positions_j2000_km

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
HORIZONS_VERSIONS = {"1.2", "1.3"}
J2000_JD = 2451545.0
SECONDS_PER_DAY = 86400.0
# A difference above this is reported as a warning. 1 km is under 0.0001% of the Sun's disk
# and under 0.01% of Earth's as seen from the Moon.
WARNING_THRESHOLD_M = 1000.0


@dataclass(frozen=True)
class CheckResult:
    epochs: int
    sun_max_m: float
    earth_max_m: float
    horizons_source: str

    @property
    def within_threshold(self) -> bool:
        return max(self.sun_max_m, self.earth_max_m) <= WARNING_THRESHOLD_M


def compare_with_horizons(
    times: tuple[datetime, ...], *, data_dir: Path, contact: str, correction: Correction = "LT+S"
) -> CheckResult:
    """Largest Sun and Earth position differences between SPICE and Horizons at `times`."""
    sun_km, earth_km, epochs = positions_j2000_km(times, data_dir=data_dir, correction=correction)
    days = J2000_JD + epochs / SECONDS_PER_DAY

    horizons_sun, sun_source = _horizons_positions("10", days, correction, contact)
    horizons_earth, earth_source = _horizons_positions("399", days, correction, contact)

    # Position difference: d = ‖r_SPICE − r_Horizons‖ × 1000
    #   d - Difference in metres; r - Moon-centred position in kilometres, J2000/ICRF axes.
    #   Both are inertial, so the lunar rotation applied later cannot change d.
    sun_difference = np.linalg.norm(sun_km - horizons_sun, axis=1) * 1000.0
    earth_difference = np.linalg.norm(earth_km - horizons_earth, axis=1) * 1000.0
    return CheckResult(
        epochs=len(times),
        sun_max_m=float(sun_difference.max()),
        earth_max_m=float(earth_difference.max()),
        horizons_source=", ".join(sorted({sun_source, earth_source})),
    )


def _horizons_positions(
    target: str, julian_days: FloatArray, correction: Correction, contact: str
) -> tuple[FloatArray, str]:
    """Moon-centred ICRF positions of one body in kilometres, and the ephemeris Horizons used."""
    positions = []
    source = ""
    for start in range(0, len(julian_days), BATCH_SIZE):
        days = julian_days[start : start + BATCH_SIZE]
        query = urlencode(
            {
                "format": "json",
                "COMMAND": target,
                "CENTER": "500@301",
                "MAKE_EPHEM": "YES",
                "OBJ_DATA": "NO",
                "EPHEM_TYPE": "VECTORS",
                "REF_SYSTEM": "ICRF",
                "REF_PLANE": "FRAME",
                "OUT_UNITS": "KM-S",
                "VEC_TABLE": "2",
                "VEC_CORR": correction,
                "CSV_FORMAT": "YES",
                "TIME_TYPE": "TDB",
                "TLIST_TYPE": "JD",
                "TLIST": " ".join(f"{day:.11f}" for day in days),
            }
        )
        table, source = _parse_table(_fetch(query, contact), target, days)
        positions.append(table)
    return np.concatenate(positions), source


def _fetch(query: str, contact: str) -> bytes:
    if not contact or not contact.isascii() or any(not char.isprintable() for char in contact):
        raise EphemerisError("Set LUNASCOUT_HORIZONS_CONTACT to a project email or URL.")

    request = Request(
        f"{HORIZONS_URL}?{query}",
        headers={"User-Agent": f"LunaScout/0.1.0 ({contact})", "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=30) as reply:
            return reply.read()
    except HTTPError as exc:
        exc.close()
        raise EphemerisError(f"Horizons returned HTTP {exc.code}.") from exc
    except (URLError, OSError) as exc:
        raise EphemerisError("Could not reach JPL Horizons.") from exc


def _parse_table(body: bytes, target: str, days: FloatArray) -> tuple[FloatArray, str]:
    try:
        payload = json.loads(body)
        version = payload["signature"]["version"]
        if version not in HORIZONS_VERSIONS:
            raise EphemerisError(f"Unsupported Horizons API version: {version}.")
        if "error" in payload:
            raise EphemerisError(f"Horizons rejected the query: {payload['error']}")
        header, table = payload["result"].split("$$SOE", 1)
        rows, _ = table.split("$$EOE", 1)
    except (KeyError, TypeError, ValueError) as exc:
        raise EphemerisError("Horizons did not return a valid vector table.") from exc

    source = re.search(rf"^Target body name: .*\({target}\)\s+\{{source: ([^}}]+)\}}", header, re.MULTILINE)
    if (
        source is None
        or not re.search(r"^Center body name: Moon \(301\)", header, re.MULTILINE)
        or "Reference frame : ICRF" not in header
        or "Output units    : KM-S" not in header
    ):
        raise EphemerisError("Horizons returned an unexpected target, origin, frame or units.")

    try:
        data = np.array([[float(row[0]), *map(float, row[2:5])] for row in csv.reader(rows.strip().splitlines())])
    except (csv.Error, IndexError, ValueError) as exc:
        raise EphemerisError("Horizons returned an invalid position or epoch.") from exc
    if data.shape != (len(days), 4) or not np.allclose(data[:, 0], days, rtol=0, atol=5e-9):
        raise EphemerisError("Horizons returned missing or misaligned states.")
    return data[:, 1:4], source[1]
