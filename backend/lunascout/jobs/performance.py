"""How long each kind of simulation work takes on this server, learned from the work itself.

The worker records how long every stage of every run took: loading a site's terrain, tracing
the first snapshot directly, building terrain horizons, computing snapshots and finding sunrise
and sunset times. Each is modelled as a fixed cost plus a cost per unit of work (per grid point,
per point built, per day), fitted to the most recent observations. The precomputed reference
sites provide plenty of them.

Observations are kept per CPU count, so a server resized from 8 cores to 2 starts again instead
of promising 8-core times. Until a size has its own observations, the model is scaled from
another size, or from typical values.
"""

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from typing import Literal

Kind = Literal["terrain", "direct", "horizon", "sample", "windows"]
KINDS: tuple[Kind, ...] = ("terrain", "direct", "horizon", "sample", "windows")
Basis = Literal["measured", "scaled", "typical"]
# The stages every new site needs; the model counts as measured once all have been timed.
_MAIN_KINDS: tuple[Kind, ...] = ("terrain", "horizon", "sample", "windows")

# Observations kept per kind and CPU count; older ones are dropped, so the model follows changes.
_KEPT = 40
# Typical costs measured on an 8-core server: (fixed seconds, seconds per unit). Units: terrain -
# per load; direct - per grid point; horizon - per point built; sample - per grid point and
# sample; windows - per day of the run.
_TYPICAL_8_CORES: dict[Kind, tuple[float, float]] = {
    "terrain": (4.0, 0.0),
    "direct": (0.5, 0.004),
    "horizon": (1.0, 0.1),
    "sample": (0.003, 3.1e-5),
    "windows": (0.2, 0.15),
}
# How many cores each kind of work keeps busy: horizon building uses them all, sample tracing
# about two and a half, the rest one. Used to scale costs between server sizes.
_CORES_USED: dict[Kind, float] = {"terrain": 1.0, "direct": 8.0, "horizon": 64.0, "sample": 2.5, "windows": 1.0}

_lock = Lock()


@dataclass(frozen=True)
class Cost:
    fixed_s: float
    per_unit_s: float

    def seconds(self, units: float) -> float:
        # Stage duration: t = a + b·n
        #   t - Estimated seconds; a (fixed_s) - fixed cost; b (per_unit_s) - cost per unit;
        #   n (units) - points, samples×points or days, depending on the kind of work.
        return self.fixed_s + self.per_unit_s * units


@dataclass(frozen=True)
class Model:
    costs: dict[Kind, Cost]
    basis: Basis


def performance_file(data_dir: Path) -> Path:
    return data_dir / "cache" / "performance.json"


def record(data_dir: Path, kind: Kind, units: float, seconds: float, cpus: int | None = None) -> None:
    """Add one observation of `kind` work: `units` of work took `seconds`."""
    if seconds <= 0 or units < 0:
        return
    path = performance_file(data_dir)
    key = str(cpus or os.cpu_count() or 1)
    with _lock:
        content = _read(path)
        series = content.setdefault(key, {}).setdefault(kind, [])
        series.append([float(units), float(seconds)])
        del series[:-_KEPT]
        _write(path, content)


def load_model(data_dir: Path, cpus: int | None = None) -> Model:
    """The cost model for this server size: measured here, scaled from another size, or typical."""
    path = performance_file(data_dir)
    try:
        modified = path.stat().st_mtime_ns
    except OSError:
        modified = 0
    return _cached_model(path, modified, cpus or os.cpu_count() or 1)


@lru_cache(maxsize=8)
def _cached_model(path: Path, _modified_ns: int, cpus: int) -> Model:
    content = _read(path)
    own = content.get(str(cpus), {})
    if any(own.get(kind) for kind in KINDS):
        # "Measured" only once every main stage has been timed here; until then, partly typical.
        timed = all(own.get(kind) for kind in _MAIN_KINDS)
        return Model({kind: _fit(own.get(kind), _scaled_typical(kind, cpus)) for kind in KINDS}, "measured" if timed else "typical")

    others = [(int(size), series) for size, series in content.items() if size.isdigit() and series]
    if others:
        size, series = max(others, key=lambda item: sum(len(values) for values in item[1].values()))
        costs = {kind: _scale(_fit(series.get(kind), _scaled_typical(kind, size)), kind, size, cpus) for kind in KINDS}
        return Model(costs, "scaled")
    return Model({kind: _scaled_typical(kind, cpus) for kind in KINDS}, "typical")


def _fit(observations: list[list[float]] | None, prior: Cost) -> Cost:
    """Least-squares line through (units, seconds); the prior's fixed cost when units barely vary."""
    if not observations:
        return prior
    units = [item[0] for item in observations]
    seconds = [item[1] for item in observations]
    count = len(units)
    mean_units = sum(units) / count
    mean_seconds = sum(seconds) / count
    spread = sum((value - mean_units) ** 2 for value in units)

    if count >= 3 and spread > 1e-9 * max(1.0, mean_units**2):
        # Least squares: b = Σ(nᵢ − n̄)(tᵢ − t̄) / Σ(nᵢ − n̄)²; a = t̄ − b·n̄
        #   nᵢ, tᵢ - Units of work and seconds of observation i; n̄, t̄ - their means.
        slope = sum((u - mean_units) * (s - mean_seconds) for u, s in zip(units, seconds, strict=True)) / spread
        fixed = mean_seconds - slope * mean_units
        if slope >= 0 and fixed >= 0:
            return Cost(fixed, slope)

    # Too little spread to separate the two: keep the prior's fixed cost and fit the rest.
    if mean_units <= 0:
        return Cost(mean_seconds, prior.per_unit_s)
    return Cost(min(prior.fixed_s, mean_seconds), max(0.0, mean_seconds - prior.fixed_s) / mean_units)


def _scaled_typical(kind: Kind, cpus: int) -> Cost:
    fixed, per_unit = _TYPICAL_8_CORES[kind]
    return _scale(Cost(fixed, per_unit), kind, 8, cpus)


def _scale(cost: Cost, kind: Kind, from_cpus: int, to_cpus: int) -> Cost:
    # Core scaling: t_to = t_from × min(c_from, u) / min(c_to, u)
    #   c - CPU counts of the two servers; u (_CORES_USED) - cores this kind of work can keep busy.
    #   Assumption: equally fast cores; the measured model replaces this once runs are timed here.
    factor = min(from_cpus, _CORES_USED[kind]) / min(to_cpus, _CORES_USED[kind])
    return Cost(cost.fixed_s * factor, cost.per_unit_s * factor)


def _read(path: Path) -> dict:
    try:
        content = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return content if isinstance(content, dict) else {}


def _write(path: Path, content: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as staging:
        json.dump(content, staging)
    os.replace(staging.name, path)
