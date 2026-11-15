"""Time integration over known samples, and Sun and Earth visibility windows."""

from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

from pydantic import BaseModel, model_validator

from ..simulation.engine import BodyView, Bounds, SnapshotSummary, Visibility
from ..simulation.events import CentreWindows, VisibilityWindow


class Reading(BaseModel):
    """Small, time-indexed part of a scientific snapshot."""

    at_utc: datetime
    center_ground_height_m: float | None
    sun_at_collector: BodyView | None
    earth_at_mast: BodyView | None
    earth_center_visibility: Visibility
    summary: SnapshotSummary
    earth_disk_visible_fraction: Bounds | None = None


class PeriodMetrics(BaseModel):
    sunlit_hours: Bounds
    half_disk_sunlit_hours: Bounds | None = None
    incident_energy_kwh_m2: Bounds | None
    earth_visible_hours: Bounds
    earth_resolved_hours: float


class DaySummary(PeriodMetrics):
    date_utc: str


class LongestWindow(BaseModel):
    """The longest window with one visibility state over the run."""

    start_utc: datetime
    end_utc: datetime
    hours: float
    # The window touches the start or end of the run, so the real one may be longer.
    truncated: bool


class PeriodSummary(PeriodMetrics):
    days: list[DaySummary]
    earth_windows: list[VisibilityWindow]
    # Exact windows at the site-centre instruments. None for runs saved before revision 3,
    # whose Earth windows place each change at the midpoint between samples.
    sun_windows: list[VisibilityWindow] | None = None
    longest_darkness: LongestWindow | None = None
    longest_earth_blackout: LongestWindow | None = None
    # The opposite states: the longest unbroken sunlight at the centre (the longest "day") and
    # the longest unbroken Earth visibility. Derived from the exact windows, so they are also
    # filled in for results saved before they existed.
    longest_daylight: LongestWindow | None = None
    longest_earth_contact: LongestWindow | None = None

    @model_validator(mode="after")
    def _fill_longest_clear_windows(self) -> "PeriodSummary":
        if self.longest_daylight is None:
            self.longest_daylight = _longest_in_windows(self.sun_windows, "clear")
        if self.longest_earth_contact is None:
            self.longest_earth_contact = _longest_in_windows(self.earth_windows, "clear")
        return self


@dataclass
class _Totals:
    sunlit: list[float] = field(default_factory=lambda: [0.0, 0.0])
    half_sunlit: list[float] = field(default_factory=lambda: [0.0, 0.0])
    has_half: bool = True
    energy: list[float] = field(default_factory=lambda: [0.0, 0.0])
    has_energy: bool = True
    earth_clear: float = 0.0
    earth_unknown: float = 0.0
    hours: float = 0.0

    def report(self) -> PeriodMetrics:
        return PeriodMetrics(
            sunlit_hours=Bounds(*self.sunlit),
            half_disk_sunlit_hours=Bounds(*self.half_sunlit) if self.has_half else None,
            incident_energy_kwh_m2=Bounds(*self.energy) if self.has_energy else None,
            earth_visible_hours=Bounds(self.earth_clear, self.earth_clear + self.earth_unknown),
            earth_resolved_hours=max(0.0, self.hours - self.earth_unknown),
        )


def integrate(
    readings: Sequence[Reading], centre: CentreWindows | None = None
) -> PeriodSummary:
    """Integrate successive samples, including the run end, using elapsed UTC time.

    Site-area metrics use linear segments between samples. Earth hours and windows
    come from the exact `centre` windows when available; otherwise each Earth
    change is placed at the midpoint between the two samples that bracket it.
    """
    total = _Totals()
    by_day: dict[str, _Totals] = {}

    for first, last in zip(readings, readings[1:]):
        for day, start, end in _split_at_midnight(first.at_utc, last.at_utc):
            daily = by_day.setdefault(day.isoformat(), _Totals())
            _accumulate_site((total, daily), first, last, start, end)

    earth_windows = centre.earth if centre is not None else _midpoint_earth_windows(readings)
    for window in earth_windows:
        for day, start, end in _split_at_midnight(window.start_utc, window.end_utc):
            daily = by_day.setdefault(day.isoformat(), _Totals())
            _accumulate_earth((total, daily), window.visibility, start, end)

    sun_windows = centre.sun if centre is not None else None
    run_start = readings[0].at_utc if readings else None
    run_end = readings[-1].at_utc if readings else None
    return PeriodSummary(
        **total.report().model_dump(),
        days=[
            DaySummary(date_utc=day, **metrics.report().model_dump())
            for day, metrics in by_day.items()
        ],
        earth_windows=earth_windows,
        sun_windows=sun_windows,
        longest_darkness=_longest(sun_windows, "blocked", run_start, run_end),
        longest_earth_blackout=(
            _longest(earth_windows, "blocked", run_start, run_end) if centre is not None else None
        ),
    )


def _split_at_midnight(start: datetime, end: datetime) -> Iterator[tuple[date, datetime, datetime]]:
    """Yield (UTC day, start, end) pieces of an interval, split at UTC midnights."""
    while start < end:
        day = start.date()
        midnight = datetime.combine(day + timedelta(days=1), time.min, tzinfo=start.tzinfo)
        finish = min(end, midnight)
        yield day, start, finish
        start = finish


def _midpoint_earth_windows(readings: Sequence[Reading]) -> list[VisibilityWindow]:
    """Earth windows estimated from samples when exact centre windows are unavailable."""
    windows: list[VisibilityWindow] = []
    for first, last in zip(readings, readings[1:]):
        start, end = first.at_utc, last.at_utc
        before, after = first.earth_center_visibility, last.earth_center_visibility
        if "unknown" in (before, after):
            pieces = [(start, end, "unknown")]
        elif before == after:
            pieces = [(start, end, before)]
        else:
            # Midpoint transition estimate: t_cross = t_start + (t_end − t_start)/2
            #   t_cross (midpoint) - Estimated transition time, UTC.
            #   t_start, t_end (start, end) - Consecutive known sample times, UTC.
            #   Assumption: A single crossing is assigned to the sample midpoint.
            midpoint = start + (end - start) / 2
            pieces = [(start, midpoint, before), (midpoint, end, after)]

        for piece_start, piece_end, visibility in pieces:
            if windows and windows[-1].visibility == visibility:
                previous = windows[-1]
                windows[-1] = VisibilityWindow(previous.start_utc, piece_end, visibility)
            else:
                windows.append(VisibilityWindow(piece_start, piece_end, visibility))
    return windows


def _accumulate_site(
    totals: tuple[_Totals, _Totals],
    first: Reading,
    last: Reading,
    start: datetime,
    end: datetime,
) -> None:
    """Add a linear sample segment's site-area metrics to period and UTC-day totals."""
    # Elapsed duration: Δh = (t_b − t_a)/3600
    #   Δh (duration_hours) - Integration segment duration, in hours.
    #   t_a, t_b (start, end) - Segment UTC endpoints, difference in seconds.
    #   3600 - Seconds per hour.
    duration_hours = (end - start).total_seconds() / 3600

    # Linear segment quadrature: f = ((t_a + t_b)/2 − t₀)/(t₁ − t₀)
    #   f (midpoint_fraction) - Dimensionless interpolation position.
    #   t_a, t_b (start, end) - Possibly split integration segment endpoints.
    #   t₀, t₁ (first.at_utc, last.at_utc) - Bracketing sample times.
    #   Assumption: Scalars vary linearly between samples; midpoint equals trapezoid mean.
    midpoint = start + (end - start) / 2
    midpoint_fraction = (midpoint - first.at_utc) / (last.at_utc - first.at_utc)
    lit_fraction = _interpolate(
        first.summary.lit_area_fraction, last.summary.lit_area_fraction, midpoint_fraction
    )
    initial_half = first.summary.half_disk_lit_area_fraction
    final_half = last.summary.half_disk_lit_area_fraction
    half_fraction = (
        _interpolate(initial_half, final_half, midpoint_fraction)
        if initial_half is not None and final_half is not None
        else None
    )
    initial_flux = first.summary.mean_irradiance_on_known_ground_w_m2
    final_flux = last.summary.mean_irradiance_on_known_ground_w_m2
    irradiance = (
        _interpolate(initial_flux, final_flux, midpoint_fraction)
        if initial_flux is not None and final_flux is not None
        else None
    )

    for accumulator in totals:
        accumulator.hours += duration_hours

        # Area-time integral: ΔL = Δh × f_lit
        #   ΔL (sunlit increment) - Area-weighted sunlit time, in hours.
        #   Δh (duration_hours) - Segment duration, in hours.
        #   f_lit (lit_fraction) - Dimensionless mean lit-area coverage bounds.
        accumulator.sunlit[0] += duration_hours * lit_fraction.lower
        accumulator.sunlit[1] += duration_hours * lit_fraction.upper

        # Half-disk area-time integral: ΔL½ = Δh × f½
        #   ΔL½ (half_sunlit increment) - Area-weighted time with ≥ ½ Sun visible, in hours.
        #   Δh (duration_hours) - Segment duration, in hours.
        #   f½ (half_fraction) - Dimensionless half-disk lit-area bounds.
        if half_fraction is None:
            accumulator.has_half = False
        else:
            accumulator.half_sunlit[0] += duration_hours * half_fraction.lower
            accumulator.half_sunlit[1] += duration_hours * half_fraction.upper

        if irradiance is None:
            accumulator.has_energy = False
        else:
            # Incident energy: ΔE = Δh × G/1000
            #   ΔE (energy increment) - Incident energy density, in kWh/m².
            #   Δh (duration_hours) - Segment duration, in hours.
            #   G (irradiance) - Mean direct irradiance bounds, in W/m².
            #   1000 - Watts per kilowatt.
            accumulator.energy[0] += duration_hours * irradiance.lower / 1000
            accumulator.energy[1] += duration_hours * irradiance.upper / 1000


def _accumulate_earth(
    totals: tuple[_Totals, _Totals], visibility: Visibility, start: datetime, end: datetime
) -> None:
    """Add a piece of an Earth window to period and UTC-day totals."""
    duration_hours = (end - start).total_seconds() / 3600
    for accumulator in totals:
        if visibility == "clear":
            accumulator.earth_clear += duration_hours
        elif visibility == "unknown":
            accumulator.earth_unknown += duration_hours


def _longest_in_windows(
    windows: Sequence[VisibilityWindow] | None, visibility: Visibility
) -> LongestWindow | None:
    """`_longest` for windows that tile the whole run, so the run's edges are the windows' edges."""
    if not windows:
        return None
    return _longest(windows, visibility, windows[0].start_utc, windows[-1].end_utc)


def _longest(
    windows: Sequence[VisibilityWindow] | None,
    visibility: Visibility,
    run_start: datetime | None,
    run_end: datetime | None,
) -> LongestWindow | None:
    """The longest window in a given state, flagged when it touches the run's edges."""
    if not windows or run_start is None or run_end is None:
        return None

    matching = [window for window in windows if window.visibility == visibility]
    if not matching:
        return None

    longest = max(matching, key=lambda window: window.end_utc - window.start_utc)
    return LongestWindow(
        start_utc=longest.start_utc,
        end_utc=longest.end_utc,
        hours=(longest.end_utc - longest.start_utc).total_seconds() / 3600,
        truncated=longest.start_utc <= run_start or longest.end_utc >= run_end,
    )


def _interpolate(first: Bounds, last: Bounds, fraction: float) -> Bounds:
    # Linear interpolation: y(f) = y₀ + (y₁ − y₀)f
    #   y(f) - Interpolated lower/upper bound, retaining the input units.
    #   y₀, y₁ (first, last) - Endpoint bounds of the same physical quantity.
    #   f (fraction) - Dimensionless position between the endpoint samples.
    return Bounds(
        first.lower + (last.lower - first.lower) * fraction,
        first.upper + (last.upper - first.upper) * fraction,
    )
