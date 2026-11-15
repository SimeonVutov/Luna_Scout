"""How each point of a site fares over a whole run: its longest day and night, and how much of the time it sees the Sun and Earth.

The run saves one result grid per snapshot. Going through them in time order gives, for every
grid point separately, the longest unbroken stretch of sunlight (its longest "day"), the longest
unbroken darkness, and the share of the period it was lit or had Earth in view. Those per-point
values drive the best-spot map layers and the whole-site numbers in the comparison.

Each snapshot is taken to describe the whole interval until the next one, so durations are
multiples of the snapshot cadence. The centre's exact windows (to about a second) come from
`events.py`; these per-point values trade that precision for covering every point.
"""

from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from .frames import FloatArray

# A point is "good for Sun" when it is lit at least this share of the period, and "good for
# communication" when Earth is in view at least this share. Earth is visible about half the
# time even from open ground, so its bar is lower. Both are judgements, returned with the
# results so the interface can state them.
SUN_GOOD_SHARE = 0.7
EARTH_GOOD_SHARE = 0.3

BoolArray = NDArray[np.bool_]
IntArray = NDArray[np.int64]


@dataclass(frozen=True)
class SiteMap:
    """Per-point results as grids shaped like the run's snapshot grid; NaN where ground is unknown."""

    sunlit_share: FloatArray
    # NaN everywhere when the snapshots were saved before Earth line of sight per point existed.
    earth_share: FloatArray
    longest_day_hours: FloatArray
    longest_dark_hours: FloatArray
    # Whether each point's longest day or night runs into the start or end of the period.
    day_truncated: BoolArray
    dark_truncated: BoolArray
    period_hours: float


@dataclass(frozen=True)
class Extremes:
    """A per-point duration summarised over the site, in hours."""

    typical_hours: float
    best_hours: float
    worst_hours: float
    # More than half the site's area has this duration cut off by the edge of the period.
    truncated: bool


@dataclass(frozen=True)
class SiteSummary:
    """Whole-site numbers: the spread of longest days and nights, and how much area is good."""

    longest_day: Extremes
    longest_dark: Extremes
    area_good_for_sun: float
    area_good_for_earth: float | None
    area_good_for_both: float | None


class SiteMapBuilder:
    """Accumulates snapshot grids in time order into a `SiteMap`."""

    def __init__(self, frame_hours: float) -> None:
        self._hours = frame_hours
        self._count = 0
        self._arrays: dict[str, FloatArray | IntArray] | None = None

    def add(self, grid: Mapping[str, np.ndarray]) -> None:
        """Take the next snapshot's grid (arrays named as in the saved snapshots)."""
        sun_lower = grid["visible_sun_fraction_lower"]
        sun_upper = grid["visible_sun_fraction_upper"]
        earth_lower = grid.get("earth_visible_fraction_lower")

        state = self._arrays or self._start(sun_lower.shape)
        self._arrays = state
        known = np.isfinite(sun_lower)

        # A point is lit when some Sun is definitely visible and dark when none can be; a point
        # whose coverage leaves it between the two belongs to neither run.
        lit = known & (sun_lower > 0)
        dark = known & (sun_upper <= 0)
        self._extend_run(state, "day", lit)
        self._extend_run(state, "dark", dark)

        state["sunlit_hours"] += np.where(lit, self._hours, 0.0)
        state["known_frames"] += known
        if earth_lower is not None:
            state["earth_hours"] += np.where(np.isfinite(earth_lower) & (earth_lower > 0), self._hours, 0.0)
            state["earth_known_frames"] += np.isfinite(earth_lower)
        self._count += 1

    def result(self) -> SiteMap:
        """The accumulated per-point results. Raises if no snapshot was added."""
        state = self._arrays
        if state is None:
            raise ValueError("A site map needs at least one snapshot.")

        period_hours = self._count * self._hours
        known = state["known_frames"] > 0
        earth_known = state["earth_known_frames"] > 0

        # Share of the period: s = Σ hours lit / period, over points with known ground.
        #   s - Share of the period a point is lit (or has Earth in view), between 0 and 1.
        #   Σ hours lit - Total time in the snapshots where the point was definitely lit.
        #   period - Number of snapshots times the snapshot cadence, in hours.
        sunlit_share = np.where(known, state["sunlit_hours"] / period_hours, np.nan)
        earth_share = np.where(earth_known, state["earth_hours"] / period_hours, np.nan)

        return SiteMap(
            sunlit_share=sunlit_share,
            earth_share=earth_share,
            longest_day_hours=np.where(known, state["day_longest"] * self._hours, np.nan),
            longest_dark_hours=np.where(known, state["dark_longest"] * self._hours, np.nan),
            day_truncated=self._touches_edge(state, "day"),
            dark_truncated=self._touches_edge(state, "dark"),
            period_hours=period_hours,
        )

    def _start(self, shape: tuple[int, ...]) -> dict[str, FloatArray | IntArray]:
        zeros = np.zeros(shape, dtype=np.int64)
        return {
            "sunlit_hours": np.zeros(shape),
            "earth_hours": np.zeros(shape),
            "known_frames": zeros.copy(),
            "earth_known_frames": zeros.copy(),
            # Per kind of run: its current length, the longest so far (in snapshots), and the
            # snapshot index where the longest one ended.
            "day_current": zeros.copy(), "day_longest": zeros.copy(), "day_ended": zeros.copy(),
            "dark_current": zeros.copy(), "dark_longest": zeros.copy(), "dark_ended": zeros.copy(),
        }

    def _extend_run(self, state: dict[str, FloatArray | IntArray], kind: str, active: BoolArray) -> None:
        current = state[f"{kind}_current"]
        current[:] = np.where(active, current + 1, 0)

        longer = current > state[f"{kind}_longest"]
        state[f"{kind}_longest"][longer] = current[longer]
        state[f"{kind}_ended"][longer] = self._count

    def _touches_edge(self, state: dict[str, FloatArray | IntArray], kind: str) -> BoolArray:
        longest = state[f"{kind}_longest"]
        ended = state[f"{kind}_ended"]
        starts_at_beginning = ended - longest + 1 == 0
        ends_at_end = ended == self._count - 1
        return (longest > 0) & (starts_at_beginning | ends_at_end)


def summarize_site_map(site_map: SiteMap, weights: FloatArray) -> SiteSummary:
    """Whole-site numbers from per-point results. `weights` are the points' spherical area weights."""
    known = np.isfinite(site_map.sunlit_share) & np.isfinite(weights)
    area = weights[known]

    good_sun = site_map.sunlit_share[known] >= SUN_GOOD_SHARE
    area_good_sun = float(area[good_sun].sum() / area.sum())

    area_good_earth = None
    area_good_both = None
    earth_known = np.isfinite(site_map.earth_share[known])
    if earth_known.all():
        # Good-area fraction: A = Σ wᵢ[sᵢ ≥ s_min] / Σ wᵢ
        #   A - Share of the site's area that meets the standard; wᵢ - area weight of point i.
        #   sᵢ - Share of the period point i is lit (or sees Earth); s_min - the standard.
        good_earth = site_map.earth_share[known] >= EARTH_GOOD_SHARE
        area_good_earth = float(area[good_earth].sum() / area.sum())
        area_good_both = float(area[good_sun & good_earth].sum() / area.sum())

    return SiteSummary(
        longest_day=_extremes(site_map.longest_day_hours[known], site_map.day_truncated[known], area, higher_is_better=True),
        longest_dark=_extremes(site_map.longest_dark_hours[known], site_map.dark_truncated[known], area, higher_is_better=False),
        area_good_for_sun=area_good_sun,
        area_good_for_earth=area_good_earth,
        area_good_for_both=area_good_both,
    )


def _extremes(hours: FloatArray, truncated: BoolArray, area: FloatArray, *, higher_is_better: bool) -> Extremes:
    # Area-weighted mean: h̄ = Σ wᵢhᵢ / Σ wᵢ
    #   h̄ - Typical duration over the site; hᵢ - point i's duration, in hours; wᵢ - its area weight.
    typical = float(np.average(hours, weights=area))
    best, worst = (hours.max(), hours.min()) if higher_is_better else (hours.min(), hours.max())

    return Extremes(
        typical_hours=typical,
        best_hours=float(best),
        worst_hours=float(worst),
        truncated=bool(area[truncated].sum() > area.sum() / 2),
    )
