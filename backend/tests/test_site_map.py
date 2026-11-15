"""Per-point longest day and night, time shares and good-area numbers, on a timeline worked out by hand."""

import numpy as np
import pytest

from lunascout.simulation.site_map import (
    EARTH_GOOD_SHARE,
    SUN_GOOD_SHARE,
    SiteMapBuilder,
    summarize_site_map,
)


def _frame(sun: list[float], earth: list[float] | None = None) -> dict[str, np.ndarray]:
    """One snapshot over two grid points; `sun` and `earth` are the visible fractions at each."""
    grid = {
        "visible_sun_fraction_lower": np.array([sun]),
        "visible_sun_fraction_upper": np.array([sun]),
    }
    if earth is not None:
        grid["earth_visible_fraction_lower"] = np.array([earth])
    return grid


def test_longest_day_dark_and_shares_follow_the_timeline():
    # Hourly snapshots. Point 0 is lit for hours 0-2 and 5-6 (so its longest day is 3 h and
    # longest night 2 h, between them). Point 1 is dark the whole time, so its night is cut off.
    point_zero = [1, 1, 1, 0, 0, 1, 1]
    builder = SiteMapBuilder(frame_hours=1.0)
    for lit in point_zero:
        builder.add(_frame([lit, 0.0], earth=[0.0, 0.0]))

    result = builder.result()

    assert result.period_hours == 7
    assert result.longest_day_hours[0, 0] == 3
    assert result.longest_dark_hours[0, 0] == 2
    assert result.sunlit_share[0, 0] == pytest.approx(5 / 7)
    assert result.longest_day_hours[0, 1] == 0
    assert result.longest_dark_hours[0, 1] == 7

    # Point 0's day starts with the period, so it is cut off; its night is inside the period.
    assert result.day_truncated[0, 0] and not result.dark_truncated[0, 0]
    assert result.dark_truncated[0, 1]


def test_good_area_counts_points_above_the_standards_weighted_by_area():
    builder = SiteMapBuilder(frame_hours=1.0)
    # Point 0 is lit and sees Earth all the time; point 1 is lit 10 of 20 hours and never sees Earth.
    for hour in range(20):
        builder.add(_frame([1.0, 1.0 if hour < 10 else 0.0], earth=[1.0, 0.0]))

    summary = summarize_site_map(builder.result(), weights=np.array([[3.0, 1.0]]))

    assert 0.5 < SUN_GOOD_SHARE and EARTH_GOOD_SHARE < 1
    # Only point 0 (three quarters of the area) meets the Sun standard of 70%, and only it sees Earth.
    assert summary.area_good_for_sun == pytest.approx(0.75)
    assert summary.area_good_for_earth == pytest.approx(0.75)
    assert summary.area_good_for_both == pytest.approx(0.75)
    assert summary.longest_day.best_hours == 20 and summary.longest_day.worst_hours == 10
    assert summary.longest_day.typical_hours == pytest.approx(0.75 * 20 + 0.25 * 10)


def test_snapshots_without_earth_data_leave_the_earth_numbers_empty():
    builder = SiteMapBuilder(frame_hours=1.0)
    for _ in range(4):
        builder.add(_frame([1.0, 0.0]))

    result = builder.result()
    summary = summarize_site_map(result, weights=np.array([[1.0, 1.0]]))

    assert np.isnan(result.earth_share).all()
    assert summary.area_good_for_earth is None and summary.area_good_for_both is None
