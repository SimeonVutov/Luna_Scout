"""Sun and Earth visibility windows at the site-centre instruments, timed to the second.

The run's area metrics are sampled at the integration cadence (15 min by default).
Rise and set events at the centre are found separately: Sun and Earth positions
are interpolated between the JPL Horizons samples, visibility is scanned every
minute, and each change is refined by bisection to about one second. The scan can
still miss an event that starts and ends within one scan step.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

import numpy as np

from ..ephemeris.horizons import EphemerisSample
from ..terrain import mesh
from .engine import PreparedSite, Visibility
from .frames import FloatArray
from .radiation import direct_sunlight

SCAN_STEP = timedelta(minutes=1)
TIME_RESOLUTION = timedelta(seconds=1)

StateFunction = Callable[[Sequence[datetime]], list[Visibility]]


@dataclass(frozen=True)
class VisibilityWindow:
    """A half-open UTC interval with one visibility state."""

    start_utc: datetime
    end_utc: datetime
    visibility: Visibility


@dataclass(frozen=True)
class CentreWindows:
    """Windows for any part of the Sun at the centre collector and Earth's centre at the mast."""

    sun: list[VisibilityWindow]
    earth: list[VisibilityWindow]


def centre_windows(
    prepared: PreparedSite, samples: Sequence[EphemerisSample]
) -> CentreWindows | None:
    """Scan the run's interval for Sun and Earth visibility changes at the site centre.

    Returns None when the site centre has no known ground.
    """
    collector_m = prepared.center_collector_m
    mast_m = prepared.mast_origin_m
    if collector_m is None or mast_m is None or len(samples) < 2:
        return None

    track = EphemerisTrack.from_samples(samples)

    def sun_states(times: Sequence[datetime]) -> list[Visibility]:
        sun_m, earth_m = track.positions_at(times)
        return sun_visibility(prepared, collector_m, sun_m, earth_m)

    def earth_states(times: Sequence[datetime]) -> list[Visibility]:
        _, earth_m = track.positions_at(times)
        return earth_center_visibility(prepared, mast_m, earth_m)

    start, end = samples[0].at_utc, samples[-1].at_utc
    return CentreWindows(
        sun=visibility_windows(start, end, sun_states),
        earth=visibility_windows(start, end, earth_states),
    )


@dataclass(frozen=True)
class EphemerisTrack:
    """Sampled Moon-fixed Sun and Earth positions, interpolated between samples."""

    seconds: FloatArray
    sun_m: FloatArray
    earth_m: FloatArray

    @classmethod
    def from_samples(cls, samples: Sequence[EphemerisSample]) -> "EphemerisTrack":
        return cls(
            seconds=np.array([sample.at_utc.timestamp() for sample in samples]),
            sun_m=np.array([sample.sun_m for sample in samples]),
            earth_m=np.array([sample.earth_m for sample in samples]),
        )

    def positions_at(self, times: Sequence[datetime]) -> tuple[FloatArray, FloatArray]:
        """Sun and Earth positions with shape (times, 3), in Moon-fixed metres."""
        query_seconds = np.array([time.timestamp() for time in times])
        if query_seconds.min() < self.seconds[0] or query_seconds.max() > self.seconds[-1]:
            raise ValueError("Interpolation times must lie within the ephemeris samples.")

        # Linear interpolation of Moon-fixed positions: r(t) = r₀ + (r₁ − r₀)(t − t₀)/(t₁ − t₀)
        #   r - Body position, in Moon-fixed metres.
        #   t₀, t₁ - Bracketing Horizons sample times; t - query time, in seconds.
        #   Assumption: In the Moon-fixed frame the Sun turns about 13°/day, so over a 15-min
        #   step (θ ≈ 0.14°) the chord's direction error is about θ²/8 ≈ 7×10⁻⁷ rad, far
        #   below the 0.27° solar radius. Only directions from the observer are used.
        sun_m = np.column_stack(
            [np.interp(query_seconds, self.seconds, self.sun_m[:, axis]) for axis in range(3)]
        )
        earth_m = np.column_stack(
            [np.interp(query_seconds, self.seconds, self.earth_m[:, axis]) for axis in range(3)]
        )
        return sun_m, earth_m


def sun_visibility(
    prepared: PreparedSite, collector_m: FloatArray, sun_m: FloatArray, earth_m: FloatArray
) -> list[Visibility]:
    """Whether any part of the solar disk is visible from the collector at each time.

    Uses the same finite-disk rays, terrain and Earth-eclipse mask as the site grid.
    """
    times = len(sun_m)
    origins_m = np.ascontiguousarray(np.broadcast_to(collector_m, (times, 3)))
    up = collector_m / np.linalg.norm(collector_m)
    normals = np.broadcast_to(up, (times, 3))
    lower, upper, _, _ = direct_sunlight(
        prepared.terrain,
        origins_m,
        normals,
        sun_m,
        earth_m,
        prepared.settings.solar_disk_samples,
    )
    return [_bounded_state(low, high) for low, high in zip(lower, upper, strict=True)]


def earth_center_visibility(
    prepared: PreparedSite, mast_m: FloatArray, earth_m: FloatArray
) -> list[Visibility]:
    """Line of sight from the mast to Earth's centre at each time."""
    times = len(earth_m)
    origins_m = np.ascontiguousarray(np.broadcast_to(mast_m, (times, 3)))
    earth_vectors_m = earth_m - origins_m
    directions = earth_vectors_m / np.linalg.norm(earth_vectors_m, axis=1)[:, None]
    statuses = prepared.terrain.trace_rays(origins_m, np.ascontiguousarray(directions[:, None, :]))
    return [_STATUS_LABEL[int(status)] for status in statuses[:, 0]]


def visibility_windows(
    start: datetime,
    end: datetime,
    states_at: StateFunction,
    *,
    step: timedelta = SCAN_STEP,
    resolution: timedelta = TIME_RESOLUTION,
) -> list[VisibilityWindow]:
    """Split [start, end] into windows of constant state, refining each change.

    `states_at` evaluates the state at a batch of times. Changes are located by
    bisection between scan points to within `resolution`.
    """
    if end <= start:
        raise ValueError("The scan interval must end after it starts.")

    scan_times = [start]
    while scan_times[-1] + step < end:
        scan_times.append(scan_times[-1] + step)
    scan_times.append(end)
    states = states_at(scan_times)

    windows: list[VisibilityWindow] = []
    window_start = start
    for index in range(1, len(scan_times)):
        before, after = states[index - 1], states[index]
        if before == after:
            continue

        change = _refine_change(scan_times[index - 1], scan_times[index], before, states_at, resolution)
        _append_window(windows, VisibilityWindow(window_start, change, before))
        window_start = change

    _append_window(windows, VisibilityWindow(window_start, end, states[-1]))
    return windows


def _refine_change(
    early: datetime,
    late: datetime,
    early_state: Visibility,
    states_at: StateFunction,
    resolution: timedelta,
) -> datetime:
    """Bisect a bracketed state change and return the middle of the final bracket."""
    while late - early > resolution:
        middle = early + (late - early) / 2
        if states_at([middle])[0] == early_state:
            early = middle
        else:
            late = middle
    return early + (late - early) / 2


def _append_window(windows: list[VisibilityWindow], window: VisibilityWindow) -> None:
    """Append a window in place, merging it into a preceding window with the same state."""
    if window.end_utc <= window.start_utc:
        return
    if windows and windows[-1].visibility == window.visibility:
        windows[-1] = replace(windows[-1], end_utc=window.end_utc)
        return
    windows.append(window)


def _bounded_state(lower: float, upper: float) -> Visibility:
    if lower > 0:
        return "clear"
    if upper == 0:
        return "blocked"
    return "unknown"


_STATUS_LABEL: dict[int, Visibility] = {
    mesh.CLEAR: "clear",
    mesh.BLOCKED: "blocked",
    mesh.UNKNOWN: "unknown",
}
