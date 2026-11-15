"""Fetch Moon-centered JPL states and rotate them into the lunar terrain frame."""

import csv
import hashlib
import json
import logging
import os
import re
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http.client import HTTPException
from pathlib import Path
from threading import Lock
from time import sleep
from typing import Literal, cast
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import spiceypy as spice
from spiceypy.utils.exceptions import SpiceyError

from ..simulation.frames import LUNAR_FRAME, FloatArray

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
HORIZONS_VERSIONS = {"1.2", "1.3"}
KERNEL_NAMES = (
    "naif0012.tls",
    "moon_de440_250416.tf",
    "moon_pa_de440_200625.bpc",
)
J2000_JD = 2451545.0
SECONDS_PER_DAY = 86400.0
# Keep explicit TLIST URLs small enough for gateways in front of Horizons.
BATCH_SIZE = 32
RETRYABLE_HTTP_CODES = {408, 429, 500, 502, 503, 504}

Correction = Literal["NONE", "LT+S"]

logger = logging.getLogger(__name__)
_spice_lock = Lock()
_request_lock = Lock()


class EphemerisError(RuntimeError):
    """Horizons or SPICE could not provide a validated state."""


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
    horizons_api_versions: tuple[str, ...]
    ephemeris_sources: tuple[str, ...]
    response_sha256: tuple[str, ...]
    kernels_sha256: dict[str, str]


@dataclass(frozen=True)
class _VectorTable:
    positions_km: FloatArray
    api_version: str
    ephemeris_source: str
    sha256: str


def load_ephemerides(
    start_utc: datetime,
    end_utc: datetime,
    *,
    data_dir: Path,
    step: timedelta = timedelta(hours=1),
    correction: Correction = "NONE",
    contact: str | None = None,
) -> Ephemerides:
    """Load a regularly sampled, half-open UTC interval `[start, end)`."""
    start = _as_utc(start_utc)
    end = _as_utc(end_utc)
    if end <= start or step <= timedelta(0):
        raise ValueError("Expected a positive step and an end after the start.")

    sample_count = (end - start - timedelta(microseconds=1)) // step + 1
    times = tuple(start + i * step for i in range(sample_count))
    return load_ephemerides_at(times, data_dir=data_dir, correction=correction, contact=contact)


def load_ephemerides_at(
    times_utc: tuple[datetime, ...],
    *,
    data_dir: Path,
    correction: Correction = "NONE",
    contact: str | None = None,
) -> Ephemerides:
    """Load the Sun and Earth at increasing UTC epochs, reusing saved JPL replies.

    `LT+S` applies reception light time and aberration at the Moon's centre.
    A ray origin still needs to be subtracted to account for surface parallax.
    """
    times = tuple(_as_utc(time) for time in times_utc)
    if not times or any(a >= b for a, b in zip(times, times[1:])):
        raise ValueError("Ephemeris epochs must be nonempty and strictly increasing.")
    if correction not in ("NONE", "LT+S"):
        raise ValueError("Horizons correction must be NONE or LT+S.")

    kernel_paths = tuple(data_dir / "raw" / "spice" / name for name in KERNEL_NAMES)
    missing = [str(path) for path in kernel_paths if not path.is_file()]
    if missing:
        raise EphemerisError(f"Missing SPICE kernel files: {', '.join(missing)}")

    epochs, rotations = _epoch_and_rotation(times, kernel_paths)
    julian_days = J2000_JD + epochs / SECONDS_PER_DAY
    if np.any(np.diff(julian_days) <= 1e-8):
        raise ValueError("Requested epochs are too close for Horizons Julian-day output.")

    cache_path = data_dir / "cache" / "horizons.sqlite3"
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    contact = contact or os.environ.get("LUNASCOUT_HORIZONS_CONTACT")

    try:
        with closing(sqlite3.connect(cache_path, timeout=120)) as cache:
            cache.execute(
                "CREATE TABLE IF NOT EXISTS vectors (query TEXT PRIMARY KEY, body BLOB NOT NULL)"
            )
            sun_tables = _read_target(cache, "10", julian_days, correction, contact)
            earth_tables = _read_target(cache, "399", julian_days, correction, contact)
    except sqlite3.Error as exc:
        raise EphemerisError(f"Could not use the Horizons cache at {cache_path}.") from exc

    # Frame rotation and unit conversion: r_MF = 1000 Q r_ICRF
    #   r_MF (sun_m/earth_m) - Moon-fixed body positions, in metres.
    #   Q (rotations) - ICRF-to-lunar rotation matrices, epoch × XYZ × XYZ.
    #   r_ICRF (_positions tables) - Moon-centered ICRF positions, in kilometres.
    #   1000 - Exact metres per kilometre.
    sun_m = np.einsum("nij,nj->ni", rotations, _positions(sun_tables)) * 1000.0
    earth_m = np.einsum("nij,nj->ni", rotations, _positions(earth_tables)) * 1000.0
    tables = (*sun_tables, *earth_tables)

    return Ephemerides(
        samples=tuple(
            EphemerisSample(time, float(epoch), sun, earth)
            for time, epoch, sun, earth in zip(times, epochs, sun_m, earth_m, strict=True)
        ),
        frame=LUNAR_FRAME,
        correction=correction,
        horizons_api_versions=tuple(sorted({table.api_version for table in tables})),
        ephemeris_sources=tuple(sorted({table.ephemeris_source for table in tables})),
        response_sha256=tuple(table.sha256 for table in tables),
        kernels_sha256={path.name: _file_sha256(path) for path in kernel_paths},
    )


def _as_utc(time: datetime) -> datetime:
    if time.utcoffset() is None:
        raise ValueError("Ephemeris timestamps need a UTC offset.")
    return time.astimezone(UTC)


def _epoch_and_rotation(
    times: tuple[datetime, ...], kernels: tuple[Path, ...]
) -> tuple[FloatArray, FloatArray]:
    # The SPICE kernel pool is process-wide. Restore it before releasing the lock.
    try:
        with _spice_lock, spice.KernelPool([str(path) for path in kernels]):
            epochs = np.array(
                [spice.str2et(time.strftime("%Y-%m-%d %H:%M:%S.%f UTC")) for time in times]
            )
            rotations = np.array(
                [spice.pxform("J2000", LUNAR_FRAME, float(epoch)) for epoch in epochs]
            )
    except SpiceyError as exc:
        raise EphemerisError("SPICE could not resolve the requested times or lunar frame.") from exc

    return epochs, rotations


def _read_target(
    cache: sqlite3.Connection,
    target: str,
    julian_days: FloatArray,
    correction: Correction,
    contact: str | None,
) -> list[_VectorTable]:
    tables = []
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

        # Hold the writer lock until a reply is validated. Competing workers sharing
        # this data directory cannot send concurrent requests or fetch the same batch.
        with cache:
            cache.execute("BEGIN IMMEDIATE")
            row = cache.execute("SELECT body FROM vectors WHERE query = ?", (query,)).fetchone()
            if row is None:
                with _request_lock:
                    body = _fetch(query, contact)
            else:
                body = row[0]
            table = _parse_table(body, target, days, correction)
            if row is None:
                cache.execute("INSERT INTO vectors VALUES (?, ?)", (query, body))
        tables.append(table)

    return tables


def _fetch(query: str, contact: str | None) -> bytes:
    if not contact or not contact.isascii() or any(not char.isprintable() for char in contact):
        raise EphemerisError(
            "Set LUNASCOUT_HORIZONS_CONTACT to a project email or URL for live JPL requests."
        )

    request = Request(
        f"{HORIZONS_URL}?{query}",
        headers={"User-Agent": f"LunaScout/0.1.0 ({contact})", "Accept": "application/json"},
    )
    for attempt in range(2):
        try:
            with urlopen(request, timeout=25) as reply:
                return reply.read()
        except HTTPError as exc:
            exc.close()
            if attempt or exc.code not in RETRYABLE_HTTP_CODES:
                raise EphemerisError(f"Horizons returned HTTP {exc.code}.") from exc

            retry_after = exc.headers.get("Retry-After")
            if retry_after and (not retry_after.isdecimal() or int(retry_after) > 15):
                raise EphemerisError(
                    "Horizons is rate limited. Retry after the indicated delay."
                ) from exc
            delay = max(2, int(retry_after or 0))
            logger.warning("Horizons returned HTTP %s. Retrying in %s seconds.", exc.code, delay)
        except (OSError, HTTPException) as exc:
            if attempt:
                raise EphemerisError("Could not reach JPL Horizons.") from exc
            delay = 2
            logger.warning("Horizons connection failed. Retrying in %s seconds.", delay)
        sleep(delay)

    raise EphemerisError("Horizons request exhausted its retries.")


def _parse_table(
    body: bytes, target: str, days: FloatArray, correction: Correction
) -> _VectorTable:
    try:
        payload = json.loads(body)
        signature = payload["signature"]
        version = signature["version"]
        if version not in HORIZONS_VERSIONS:
            raise EphemerisError(f"Unsupported Horizons API version: {version}.")
        if "error" in payload:
            raise EphemerisError(f"Horizons rejected the query: {payload['error']}")
        header, table = payload["result"].split("$$SOE", 1)
        rows, _ = table.split("$$EOE", 1)
    except (KeyError, TypeError, ValueError) as exc:
        raise EphemerisError("Horizons did not return a valid vector table.") from exc

    expected_output = "GEOMETRIC cartesian states" if correction == "NONE" else "LT+S CORRECTED"
    source = re.search(
        rf"^Target body name: .*\({target}\)\s+\{{source: ([^}}]+)\}}", header, re.MULTILINE
    )
    if (
        source is None
        or not re.search(r"^Center body name: Moon \(301\)", header, re.MULTILINE)
        or not re.search(r"^Center-site name: BODY CENTER", header, re.MULTILINE)
        or "Reference frame : ICRF" not in header
        or "Output units    : KM-S" not in header
        or "JDTDB" not in header
        or expected_output not in header
    ):
        raise EphemerisError("Horizons returned unexpected target, origin, frame or units.")

    try:
        data = np.array(
            [
                [float(row[0]), *map(float, row[2:5])]
                for row in csv.reader(rows.strip().splitlines(), strict=True)
            ]
        )
    except (csv.Error, IndexError, ValueError) as exc:
        raise EphemerisError("Horizons returned an invalid position or epoch.") from exc
    if (
        data.shape != (len(days), 4)
        or not np.isfinite(data).all()
        or not np.allclose(data[:, 0], days, rtol=0, atol=5e-9)
    ):
        raise EphemerisError("Horizons returned missing, nonfinite or misaligned states.")

    return _VectorTable(
        positions_km=data[:, 1:4],
        api_version=cast(str, version),
        ephemeris_source=source[1],
        sha256=hashlib.sha256(body).hexdigest(),
    )


def _positions(tables: list[_VectorTable]) -> FloatArray:
    return np.concatenate([table.positions_km for table in tables])


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()
