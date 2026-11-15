"""Time integration over known samples and estimated Earth visibility windows."""

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import Sequence

from pydantic import BaseModel

from ..simulation.engine import BodyView, Bounds, SnapshotSummary, Visibility


class Reading(BaseModel):
    """Small, time-indexed part of a scientific snapshot."""

    at_utc: datetime
    center_ground_height_m: float | None
    sun_at_collector: BodyView | None
    earth_at_mast: BodyView | None
    earth_center_visibility: Visibility
    summary: SnapshotSummary


class EarthWindow(BaseModel):
    start_utc: datetime
    end_utc: datetime
    visibility: Visibility


class PeriodMetrics(BaseModel):
    sunlit_hours: Bounds
    half_disk_sunlit_hours: Bounds | None = None
    incident_energy_kwh_m2: Bounds | None
    earth_visible_hours: Bounds
    earth_resolved_hours: float


class DaySummary(PeriodMetrics):
    date_utc: str


class PeriodSummary(PeriodMetrics):
    days: list[DaySummary]
    earth_windows: list[EarthWindow]


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


def integrate(readings: Sequence[Reading]) -> PeriodSummary:
    """Integrate successive samples, including the run end, using elapsed UTC time."""
    total = _Totals()
    by_day: dict[str, _Totals] = {}
    windows: list[EarthWindow] = []
    for first, last in zip(readings, readings[1:]):
        for start, end, visibility in _window_intervals(first, last):
            if windows and windows[-1].visibility == visibility:
                windows[-1].end_utc = end
            else:
                windows.append(EarthWindow(start_utc=start, end_utc=end, visibility=visibility))

            while start < end:
                day = start.date()
                midnight = datetime.combine(day + timedelta(days=1), time.min, tzinfo=start.tzinfo)
                finish = min(end, midnight)
                daily = by_day.setdefault(day.isoformat(), _Totals())
                _accumulate((total, daily), first, last, start, finish, visibility)
                start = finish

    return PeriodSummary(
        **total.report().model_dump(),
        days=[
            DaySummary(date_utc=day, **metrics.report().model_dump())
            for day, metrics in by_day.items()
        ],
        earth_windows=windows,
    )


def _window_intervals(first: Reading, last: Reading) -> list[tuple[datetime, datetime, Visibility]]:
    start, end = first.at_utc, last.at_utc
    before, after = first.earth_center_visibility, last.earth_center_visibility
    if "unknown" in (before, after):
        return [(start, end, "unknown")]
    if before == after:
        return [(start, end, before)]

    # Midpoint transition estimate: t_cross = t_start + (t_end − t_start)/2
    #   t_cross (midpoint) - Estimated transition time, UTC.
    #   t_start, t_end (start, end) - Consecutive known sample times, UTC.
    #   Assumption: A single crossing is assigned to the sample midpoint.
    midpoint = start + (end - start) / 2
    return [(start, midpoint, before), (midpoint, end, after)]


def _accumulate(
    totals: tuple[_Totals, _Totals],
    first: Reading,
    last: Reading,
    start: datetime,
    end: datetime,
    visibility: Visibility,
) -> None:
    """Add a linear sample segment to both whole-period and UTC-day totals."""
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

        if visibility == "clear":
            accumulator.earth_clear += duration_hours
        elif visibility == "unknown":
            accumulator.earth_unknown += duration_hours


def _interpolate(first: Bounds, last: Bounds, fraction: float) -> Bounds:
    # Linear interpolation: y(f) = y₀ + (y₁ − y₀)f
    #   y(f) - Interpolated lower/upper bound, retaining the input units.
    #   y₀, y₁ (first, last) - Endpoint bounds of the same physical quantity.
    #   f (fraction) - Dimensionless position between the endpoint samples.
    return Bounds(
        first.lower + (last.lower - first.lower) * fraction,
        first.upper + (last.upper - first.upper) * fraction,
    )
