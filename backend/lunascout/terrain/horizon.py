"""Precomputed terrain horizons that replace most per-timestamp terrain traces.

For every receiver the horizon map stores the highest terrain elevation angle in
720 azimuth directions, measured on the same triangulated LOLA surface that the
ray tracer uses. Terrain does not move, so each receiver's horizon is built once and
reused for every timestamp and date range. Receivers are saved per site centre, so a
smaller site at the same centre reuses the receivers of a larger one.

A ray is clear when it rises above the horizon at its azimuth and blocked when it
passes below. Rays within a small margin of the interpolated horizon, and rays in
directions where missing terrain could hide a higher ridge, are traced exactly.
This follows the horizon-profile approach used for NASA's LOLA polar illumination
maps (Mazarico et al. 2011, Icarus 211, 1066–1081).

Limitation: between two sampled azimuths the horizon is interpolated, so a ridge
narrower than one bin (0.5°) that pokes more than the margin above the interpolated
line could be missed. Comparisons with direct ray tracing are in the tests and the
README.
"""

import hashlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from math import radians
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from numpy.typing import NDArray

from ..simulation.frames import FloatArray
from . import mesh
from .model import Terrain

AZIMUTH_COUNT = 720
EXACT_TRACE_MARGIN_RAD = radians(0.05)
# Change when the profile kernel or its inputs change, so stale caches are ignored.
HORIZON_REVISION = 2
# Receivers built between saves of a growing map: about a tenth of the build, so progress moves in
# about ten steps, but at least 16 and at most 256 at a time.
_CHUNK_STEPS = 10
_MIN_CHUNK = 16
_MAX_CHUNK = 256

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class HorizonMap:
    """Terrain horizon per receiver. All arrays share the receiver axis.

    `elevation_rad[i, k]` is the horizon elevation above receiver i's level plane
    at azimuth (k + ½)·360°/K, clockwise from that receiver's `north`.
    `complete[i, k]` is False where missing terrain lay along the profile.
    `east`, `north` and `up` are unit vectors with shape (receivers, 3).
    """

    elevation_rad: FloatArray
    complete: NDArray[np.bool_]
    east: FloatArray
    north: FloatArray
    up: FloatArray


def receiver_axes(origins_m: FloatArray) -> tuple[FloatArray, FloatArray, FloatArray]:
    """Unit east, north and radial-up vectors at each receiver origin.

    Exactly at the pole the east direction is undefined; +Y is used there. Any
    orthonormal frame works because the same axes are stored with the map.
    """
    # Local axes: u = x/‖x‖; e = (ẑ × u)/‖ẑ × u‖; n = u × e
    #   x (origins_m) - Receiver positions, Moon-fixed metres.
    #   u, e, n (up, east, north) - Unit radial vertical, east and north vectors.
    #   ẑ - Unit Moon-fixed +Z (north spin) axis.
    up = origins_m / np.linalg.norm(origins_m, axis=1)[:, None]
    east = np.cross([0.0, 0.0, 1.0], up)
    east_length = np.linalg.norm(east, axis=1)
    at_pole = east_length < 1e-12
    east[at_pole] = [0.0, 1.0, 0.0]
    east_length[at_pole] = 1.0
    east /= east_length[:, None]
    north = np.cross(up, east)
    return east, north, up


def build_horizons(terrain: Terrain, origins_m: FloatArray) -> HorizonMap:
    """Compute the exact horizon of the triangulated terrain for each receiver."""
    east, north, up = receiver_axes(origins_m)
    elevation_rad, complete = terrain.horizon_profiles(
        np.ascontiguousarray(origins_m), (east, north, up), AZIMUTH_COUNT
    )
    return HorizonMap(elevation_rad, complete, east, north, up)


def site_label(latitude_deg: float, longitude_deg: float) -> str:
    """The text stored in a cached map so it can be found again when its site is deleted.

    Every site at one centre shares a map, whatever its radius.
    """
    return f"{latitude_deg:.9f},{longitude_deg:.9f}"


def purge_horizons(cache_dir: Path, label: str) -> int:
    """Delete the cached horizon maps built for one site centre; returns how many files were removed."""
    removed = 0
    for path in cache_dir.glob("*.npz"):
        try:
            with np.load(path, allow_pickle=False) as saved:
                matches = "site_label" in saved.files and str(saved["site_label"]) == label
        except (OSError, ValueError):
            continue
        if matches:
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def saved_point_count(cache_dir: Path, label: str) -> int:
    """How many points of a site centre already have a horizon saved. Reads each map once per change."""
    total = 0
    for path in cache_dir.glob("*.npz"):
        try:
            details = path.stat()
        except OSError:
            continue
        saved_label, count = _map_summary(path, details.st_mtime_ns, details.st_size)
        if saved_label == label:
            total += count
    return total


@lru_cache(maxsize=256)
def _map_summary(path: Path, _modified_ns: int, _size: int) -> tuple[str, int]:
    try:
        with np.load(path, allow_pickle=False) as saved:
            return str(saved["site_label"]), int(saved["origins_m"].shape[0])
    except (OSError, ValueError, KeyError):
        return "", 0


def prune_outdated_horizons(cache_dir: Path) -> int:
    """Delete maps saved by an older version of the method; returns how many files were removed."""
    removed = 0
    for path in cache_dir.glob("*.npz"):
        try:
            with np.load(path, allow_pickle=False) as saved:
                current = "revision" in saved.files and int(saved["revision"]) == HORIZON_REVISION
        except (OSError, ValueError):
            current = False
        if not current:
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def read_cached_horizons(
    terrain: Terrain, origins_m: FloatArray, cache_dir: Path
) -> HorizonMap | None:
    """The saved horizons for these receivers, or None unless every receiver is saved."""
    stored = _read_cache(cache_dir / f"{_cache_key(terrain)}.npz")
    if stored is None:
        return None
    rows = _rows_for(stored, origins_m)
    return None if rows is None else _subset(stored.horizons, rows)


def load_or_build_horizons(
    terrain: Terrain,
    origins_m: FloatArray,
    cache_dir: Path,
    label: str = "",
    progress: Callable[[int, int], None] | None = None,
) -> HorizonMap:
    """The horizons of these receivers, building and saving only the ones not yet saved.

    Receivers are built in chunks and the map is saved after each one, so an interrupted build
    keeps its progress. `progress(done, total)` is called before the first chunk and after each
    one; an exception it raises stops the build, with the finished chunks saved. `label` names the site centre in the
    saved file so the map can be deleted with its site.
    """
    path = cache_dir / f"{_cache_key(terrain)}.npz"
    stored = _read_cache(path)
    known = set(stored.index) if stored else set()
    missing = [row for row, key in enumerate(_row_keys(origins_m)) if key not in known]

    size = min(_MAX_CHUNK, max(_MIN_CHUNK, -(-len(missing) // _CHUNK_STEPS)))
    if progress and missing:
        progress(0, len(missing))
    for done in range(0, len(missing), size):
        chunk = np.array(missing[done : done + size])
        built = build_horizons(terrain, origins_m[chunk])
        stored = _merge(stored, origins_m[chunk], built)
        _write_cache(path, stored, label)
        if progress:
            progress(min(done + size, len(missing)), len(missing))

    if stored is None:
        raise ValueError("A horizon map needs at least one receiver.")
    rows = _rows_for(stored, origins_m)
    if rows is None:
        raise RuntimeError("The saved horizon map is missing receivers that were just built.")
    return _subset(stored.horizons, rows)


def ray_visibility(
    terrain: Terrain,
    horizons: HorizonMap,
    receivers: slice,
    origins_m: FloatArray,
    directions: FloatArray,
) -> NDArray[np.int8]:
    """Classify rays with the horizon map and trace only the ambiguous ones.

    `origins_m` (receivers, 3) and unit `directions` (receivers, rays, 3) belong
    to the rows `receivers` of the map. Returns mesh statuses like
    `Terrain.trace_rays`.
    """
    east = horizons.east[receivers]
    north = horizons.north[receivers]
    up = horizons.up[receivers]
    horizon_rad = horizons.elevation_rad[receivers]
    complete = horizons.complete[receivers]

    # Local sky angles: A = atan2(ω·e, ω·n) mod 2π; el = atan2(ω·u, √((ω·e)² + (ω·n)²))
    #   A (azimuth) - Ray azimuth clockwise from the receiver's north, in radians.
    #   el (elevation) - Ray elevation above the receiver's level plane, in radians.
    #   ω (directions) - Unit ray directions; e, n, u - receiver axes.
    #   Arrays have receiver × ray axes; axes have receiver × XYZ axes.
    east_part = np.einsum("ni,nri->nr", east, directions)
    north_part = np.einsum("ni,nri->nr", north, directions)
    up_part = np.einsum("ni,nri->nr", up, directions)
    azimuth = np.mod(np.arctan2(east_part, north_part), 2 * np.pi)
    elevation = np.arctan2(up_part, np.hypot(east_part, north_part))

    # Horizon interpolation between bin centres Aₖ = (k + ½)ΔA:
    #   p = A/ΔA − ½; k₀ = ⌊p⌋; w = p − k₀; H = (1 − w) Hₖ₀ + w Hₖ₀₊₁  (indices mod K)
    #   ΔA - Bin width 2π/K, in radians; K (AZIMUTH_COUNT) - bins per receiver.
    #   Hₖ (horizon_rad) - Horizon elevation at bin centre k, in radians.
    #   w (weight) - Dimensionless interpolation weight of the upper neighbour.
    position = azimuth / (2 * np.pi) * AZIMUTH_COUNT - 0.5
    lower_bin = np.floor(position).astype(np.int64)
    weight = position - lower_bin
    lower_bin %= AZIMUTH_COUNT
    upper_bin = (lower_bin + 1) % AZIMUTH_COUNT
    rows = np.arange(len(horizon_rad))[:, None]
    interpolated_horizon = (1 - weight) * horizon_rad[rows, lower_bin] + weight * horizon_rad[
        rows, upper_bin
    ]
    profiles_complete = complete[rows, lower_bin] & complete[rows, upper_bin]

    margin = elevation - interpolated_horizon
    statuses = np.where(margin > 0, mesh.CLEAR, mesh.BLOCKED).astype(np.int8)

    needs_trace = (np.abs(margin) < EXACT_TRACE_MARGIN_RAD) | ~profiles_complete
    receiver_index, ray_index = np.nonzero(needs_trace)
    if len(receiver_index):
        exact = terrain.trace_rays(
            np.ascontiguousarray(origins_m[receiver_index]),
            np.ascontiguousarray(directions[receiver_index, ray_index][:, None, :]),
        )
        statuses[receiver_index, ray_index] = exact[:, 0]

    return statuses


@dataclass(frozen=True)
class _StoredMap:
    """A saved map: receiver positions, their horizons, and a lookup from position to row."""

    origins_m: FloatArray
    horizons: HorizonMap
    index: dict[bytes, int]


def _cache_key(terrain: Terrain) -> str:
    """Hash every input that changes a receiver's horizon except the receiver itself.

    Terrain is prepared for the largest site at a centre, so this is one key per site centre.
    """
    digest = hashlib.sha256()
    digest.update(
        f"rev={HORIZON_REVISION};bins={AZIMUTH_COUNT};"
        f"shell={mesh.INNER_RADIUS_M},{mesh.OUTER_RADIUS_M};".encode()
    )
    for source in terrain.sources:
        digest.update(f"{source.sha256};{source.spacing_m};{source.bounds_m};".encode())
    return digest.hexdigest()


def _row_keys(origins_m: FloatArray) -> list[bytes]:
    """Exact bytes of each receiver position, so a receiver is matched only by an identical one."""
    rows = np.ascontiguousarray(origins_m, dtype=np.float64)
    return [row.tobytes() for row in rows]


def _rows_for(stored: _StoredMap, origins_m: FloatArray) -> NDArray[np.int64] | None:
    try:
        return np.array([stored.index[key] for key in _row_keys(origins_m)], dtype=np.int64)
    except KeyError:
        return None


def _subset(horizons: HorizonMap, rows: NDArray[np.int64]) -> HorizonMap:
    return HorizonMap(*(np.ascontiguousarray(getattr(horizons, name)[rows]) for name in HorizonMap.__dataclass_fields__))


def _merge(stored: _StoredMap | None, origins_m: FloatArray, built: HorizonMap) -> _StoredMap:
    if stored is None:
        origins, horizons = np.asarray(origins_m, dtype=np.float64), built
    else:
        origins = np.concatenate([stored.origins_m, origins_m])
        horizons = HorizonMap(*(
            np.concatenate([getattr(stored.horizons, name), getattr(built, name)])
            for name in HorizonMap.__dataclass_fields__
        ))
    return _StoredMap(origins, horizons, {key: row for row, key in enumerate(_row_keys(origins))})


def _read_cache(path: Path) -> _StoredMap | None:
    if not path.is_file():
        return None

    try:
        with np.load(path, allow_pickle=False) as saved:
            if int(saved["revision"]) != HORIZON_REVISION:
                return None
            origins = saved["origins_m"]
            horizons = HorizonMap(**{name: saved[name] for name in HorizonMap.__dataclass_fields__})
    except (OSError, ValueError, KeyError):
        logger.warning("Ignoring an unreadable horizon cache at %s", path)
        return None

    if horizons.elevation_rad.shape != (len(origins), AZIMUTH_COUNT):
        logger.warning("Ignoring a horizon cache with an unexpected shape at %s", path)
        return None
    return _StoredMap(origins, horizons, {key: row for row, key in enumerate(_row_keys(origins))})


def _write_cache(path: Path, stored: _StoredMap, label: str) -> None:
    """Save without compression: the map is rewritten after every chunk, and speed matters more."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=path.parent) as staging:
        staged_path = Path(staging) / path.name
        np.savez(
            staged_path,
            revision=np.array(HORIZON_REVISION),
            site_label=np.array(label),
            origins_m=stored.origins_m,
            **vars(stored.horizons),
        )
        staged_path.replace(path)
