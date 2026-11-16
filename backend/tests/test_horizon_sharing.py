"""A smaller site reuses the horizon map of a larger one at the same centre, with identical results."""

from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest

from lunascout.ephemeris.states import kernel_paths, load_ephemerides_at
from lunascout.simulation.engine import SimulationSettings, prepare_site, trace_snapshot
from lunascout.simulation.frames import SiteFootprint
from lunascout.terrain.horizon import (
    HorizonMap,
    build_horizons,
    load_or_build_horizons,
    read_cached_horizons,
)
from lunascout.terrain.model import REGIONAL_DEM_NAMES, prepare_terrain

DATA_DIR = Path(__file__).resolve().parents[2] / "DATA"
HAS_DATA = all((DATA_DIR / "raw" / "terrain" / name).is_file() for name in REGIONAL_DEM_NAMES) and all(
    path.is_file() for path in kernel_paths(DATA_DIR)
)
# Connecting Ridge, one of the sites with 5 m terrain.
CENTRE = (-89.4632, -137.49)


@pytest.mark.skipif(not HAS_DATA, reason="Needs the NASA data from lunascout-science fetch-data.")
def test_a_smaller_site_reads_the_larger_sites_horizons_and_gets_identical_results(tmp_path: Path):
    settings = SimulationSettings(grid_spacing_m=20)
    large = SiteFootprint(*CENTRE, 100)
    small = SiteFootprint(*CENTRE, 40)
    large_terrain = prepare_terrain(DATA_DIR, large)
    small_terrain = prepare_terrain(DATA_DIR, small)
    # Terrain is prepared for the largest allowed site, so both radii see the same ground.
    assert [source.bounds_m for source in large_terrain.sources] == [source.bounds_m for source in small_terrain.sources]

    large_site = prepare_site(large, large_terrain, settings)
    small_site = prepare_site(small, small_terrain, settings)
    built: list[int] = []
    load_or_build_horizons(large_terrain, large_site.solar_origins_m, tmp_path, progress=lambda done, total: built.append(total))
    assert built, "the larger site's map is built"

    shared = read_cached_horizons(small_terrain, small_site.solar_origins_m, tmp_path)
    assert shared is not None, "every receiver of the smaller site is already in the map"
    fresh = build_horizons(small_terrain, small_site.solar_origins_m)
    for name in HorizonMap.__dataclass_fields__:
        assert np.array_equal(getattr(shared, name), getattr(fresh, name)), name

    at = datetime(2026, 12, 1, 6, tzinfo=UTC)
    sample = load_ephemerides_at((at,), data_dir=DATA_DIR, correction="LT+S").samples[0]
    with_shared = trace_snapshot(small_site, sample, shared).grid
    with_fresh = trace_snapshot(small_site, sample, fresh).grid
    for name in ("visible_sun_fraction_lower", "visible_sun_fraction_upper", "irradiance_lower_w_m2"):
        assert np.array_equal(getattr(with_shared, name), getattr(with_fresh, name), equal_nan=True), name


class _NoTerrain:
    """Terrain with no sources, enough for the cache key when building is stubbed."""

    sources = ()


def test_a_larger_site_builds_only_the_receivers_the_map_lacks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from lunascout.terrain import horizon

    built_counts: list[int] = []

    def stub_build(_terrain, origins_m):
        """A map whose horizon in every direction equals the receiver's first coordinate."""
        built_counts.append(len(origins_m))
        count = len(origins_m)
        axes = np.tile([1.0, 0.0, 0.0], (count, 1))
        elevation = np.repeat(origins_m[:, :1], horizon.AZIMUTH_COUNT, axis=1)
        return HorizonMap(elevation, np.ones((count, horizon.AZIMUTH_COUNT), bool), axes, axes, axes)

    monkeypatch.setattr(horizon, "build_horizons", stub_build)
    origins = np.arange(30, dtype=float).reshape(10, 3)

    first = horizon.load_or_build_horizons(_NoTerrain(), origins[:4], tmp_path)
    second = horizon.load_or_build_horizons(_NoTerrain(), origins, tmp_path)

    assert built_counts == [4, 6]
    assert np.array_equal(second.elevation_rad[:4], first.elevation_rad)
    assert np.array_equal(second.elevation_rad[:, 0], origins[:, 0])
