"""The stages a run goes through, how far each is, and how long the rest should take.

A run passes up to four stages:

1. preparing - load the site's terrain and trace the first hour directly, so there is something
   to show while the rest is computed;
2. horizons - build the terrain horizon of every grid point not already saved for this site;
3. snapshots - compute every sample of the date range;
4. windows - find exact sunrise, sunset, Earthrise and Earthset times, and summarise.

The worker reports which stage a run is in and, once it knows, how many grid points and missing
horizon points the run has. Until then, both are estimated without loading any terrain.
"""

from dataclasses import dataclass, field
from typing import Literal

import numpy as np
from pydantic import BaseModel

from .performance import Basis, Model
from .plan import RunPlan

StageKey = Literal["preparing", "horizons", "snapshots", "windows"]
StageState = Literal["pending", "active", "done", "skipped"]
STAGE_ORDER: tuple[StageKey, ...] = ("preparing", "horizons", "snapshots", "windows")
# An active stage timed by the clock alone never shows as finished before the worker says so.
_CLOCK_LIMIT = 0.95


class StageProgress(BaseModel):
    key: StageKey
    state: StageState
    # Estimated seconds for the whole stage, and the share of it done.
    seconds: float
    fraction: float
    # Units of work, where they mean something: points for horizons, samples for snapshots.
    done_units: int | None = None
    total_units: int | None = None
    # Samples earlier runs had already computed, which cost nothing here.
    reused_units: int | None = None


class RunProgress(BaseModel):
    stages: list[StageProgress]
    # Seconds until the run should finish, including time shared with other visitors' runs.
    remaining_s: float
    basis: Basis
    # Other visitors' runs being computed at the same time, which share the worker.
    sharing_with: int = 0
    # Queued, and the worker has not started on it yet.
    waiting: bool = False


@dataclass
class ProgressState:
    """What the worker has reported about a run, stored as JSON with the run."""

    phase: StageKey | None = None
    phase_started_ns: int | None = None
    points: int | None = None
    horizon_missing: int | None = None
    horizon_done: int = 0
    finished: list[StageKey] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict) -> "ProgressState":
        known = {name: data[name] for name in cls.__dataclass_fields__ if name in data}
        return cls(**known)


def grid_point_count(plan: RunPlan) -> int:
    """Grid points inside the site, the same circle of points the simulation reports on."""
    spacing = plan.settings.grid_spacing_m
    half_width = int(plan.site.radius_m // spacing)
    offsets = np.arange(-half_width, half_width + 1) * spacing
    east, north = np.meshgrid(offsets, offsets)
    return int(np.count_nonzero(np.hypot(east, north) <= plan.site.radius_m))


def estimate(
    plan: RunPlan,
    *,
    completed_samples: int,
    reused_samples: int,
    state: ProgressState,
    model: Model,
    saved_horizon_points: int,
    now_ns: int,
) -> tuple[list[StageProgress], float]:
    """The run's stages and the seconds its own remaining work should take.

    `saved_horizon_points` is how many points of this site centre already have a horizon saved,
    used until the worker reports the exact number missing.
    """
    points = state.points or grid_point_count(plan)
    total_samples = plan.interval_count + 1
    missing = state.horizon_missing if state.horizon_missing is not None else max(0, points - saved_horizon_points)
    days = (plan.end_utc - plan.start_utc).total_seconds() / 86_400
    costs = model.costs

    def clock_fraction(key: StageKey, seconds: float) -> float:
        if state.phase != key or state.phase_started_ns is None or seconds <= 0:
            return 0.0
        return min(_CLOCK_LIMIT, (now_ns - state.phase_started_ns) / 1e9 / seconds)

    stages: list[StageProgress] = []

    # The first hour is traced directly when no horizon map exists yet, which costs more per point.
    first_sample = costs["direct"].seconds(points) if missing else costs["sample"].seconds(points)
    preparing_s = costs["terrain"].seconds(1) + first_sample
    stages.append(_stage("preparing", state, preparing_s, clock_fraction("preparing", preparing_s)))

    horizon_s = costs["horizon"].seconds(missing) if missing else 0.0
    horizon_fraction = state.horizon_done / missing if missing else 1.0
    stages.append(_stage("horizons", state, horizon_s, horizon_fraction, skipped=missing == 0,
                         done_units=state.horizon_done if missing else 0, total_units=missing))

    to_compute = max(0, total_samples - reused_samples)
    computed = min(to_compute, max(0, completed_samples - reused_samples))
    # Per-sample cost: t = a + b·P
    #   a, b - fixed and per-point cost of one sample on this server; P (points) - grid points.
    snapshot_s = to_compute * costs["sample"].seconds(points)
    stages.append(_stage(
        "snapshots", state, snapshot_s, computed / to_compute if to_compute else 1.0,
        skipped=to_compute == 0, done=completed_samples >= total_samples,
        done_units=computed, total_units=to_compute, reused_units=reused_samples,
    ))

    windows_s = costs["windows"].seconds(days)
    stages.append(_stage("windows", state, windows_s, clock_fraction("windows", windows_s)))

    remaining = sum(stage.seconds * (1 - stage.fraction) for stage in stages if stage.state in ("pending", "active"))
    return stages, remaining


def shared_remaining(own_s: float, others_s: list[float]) -> float:
    """Seconds until a run finishes when the worker takes turns between it and other runs.

    Round-robin sharing: T = r + Σⱼ min(rⱼ, r)
      T - Seconds until this run finishes; r (own_s) - its own remaining work, in seconds.
      rⱼ (others_s) - remaining work of each other run taking turns with it.
      Assumption: equal turns, and no new runs arrive meanwhile.
    """
    return own_s + sum(min(other, own_s) for other in others_s)


def _stage(
    key: StageKey,
    state: ProgressState,
    seconds: float,
    fraction: float,
    *,
    skipped: bool = False,
    done: bool = False,
    done_units: int | None = None,
    total_units: int | None = None,
    reused_units: int | None = None,
) -> StageProgress:
    finished = done or key in state.finished
    if skipped and key not in ("preparing", "windows"):
        stage_state: StageState = "skipped"
    elif finished:
        stage_state = "done"
    elif state.phase == key:
        stage_state = "active"
    else:
        stage_state = "pending"

    complete = stage_state in ("done", "skipped")
    return StageProgress(
        key=key,
        state=stage_state,
        seconds=round(max(seconds, 0.0), 2),
        fraction=1.0 if complete else round(min(max(fraction, 0.0), 1.0), 4),
        done_units=done_units,
        total_units=total_units,
        reused_units=reused_units,
    )
