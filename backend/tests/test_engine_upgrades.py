"""Essential checks for hit distances, horizon maps and centre event windows.

A synthetic wall gives exactly known geometry. The last test uses the NASA LOLA
files and is skipped when they are absent.
"""

import json
from datetime import UTC, datetime, timedelta
from math import radians
from pathlib import Path

import numpy as np
import pytest

from lunascout.ephemeris.states import EphemerisSample
from lunascout.simulation.engine import SimulationSettings, prepare_site, trace_snapshot
from lunascout.simulation.insight import skyline_degrees
from lunascout.simulation.events import visibility_windows
from lunascout.simulation.frames import MOON_RADIUS_M, SiteFootprint
from lunascout.terrain import mesh
from lunascout.terrain.horizon import build_horizons, ray_visibility, receiver_axes
from lunascout.terrain.model import Terrain, TerrainSource, prepare_terrain

_SPACING_M = 100.0


def _wall_terrain() -> Terrain:
    """Flat datum around the south pole with a 500 m wall 5.0–5.3 km toward +E."""
    return _synthetic_terrain(lambda east, north: np.where((east >= 5_000) & (east <= 5_300), 500.0, 0.0))


def _synthetic_terrain(height_at) -> Terrain:
    """Gnomonic grid around the south pole with heights from `height_at(east_m, north_m)`."""
    offsets = np.arange(-20_000.0, 20_000.0 + _SPACING_M, _SPACING_M)
    east, north = np.meshgrid(offsets, offsets)
    heights = height_at(east, north)

    # Reciprocal gnomonic depth: D = √(1 + (E/R)² + (N/R)²)/(R + h)
    #   D - Mesh value per node, in m⁻¹; E, N - projected node coordinates, in metres.
    #   R (MOON_RADIUS_M) - Datum radius; h (heights) - radial height above it, in metres.
    depths = np.sqrt(1 + (east / MOON_RADIUS_M) ** 2 + (north / MOON_RADIUS_M) ** 2) / (
        MOON_RADIUS_M + heights
    )
    bounds = (offsets[0], offsets[0], offsets[-1], offsets[-1])
    source = TerrainSource("synthetic-wall", "0" * 64, _SPACING_M, bounds)
    geometry = np.array([[offsets[0], offsets[0], _SPACING_M]])
    return Terrain((source,), (np.ascontiguousarray(depths),), geometry)


_POLE_OBSERVER = np.array([[0.0, 0.0, -(MOON_RADIUS_M + 2.0)]])


def test_level_ray_reports_the_wall_hit_distance():
    level_toward_wall = np.array([[[0.0, 1.0, 0.0]]])
    statuses, distances = _wall_terrain().trace_hits(_POLE_OBSERVER, level_toward_wall)

    # The ray rises s²/(2R) ≈ 6.9 m above the datum by 4.9 km and the wall face climbs
    # 500 m over the next 100 m, so the hit is near 4,900 + 100 × 8.9/500 ≈ 4,902 m.
    assert statuses[0, 0] == mesh.BLOCKED
    assert 4_898 < distances[0, 0] < 4_906


def test_horizon_classification_equals_direct_tracing():
    terrain = _wall_terrain()
    observers = np.array([_POLE_OBSERVER[0], [1_500.0, -800.0, -(MOON_RADIUS_M + 2.0)]])
    horizons = build_horizons(terrain, observers)

    generator = np.random.default_rng(7)
    azimuth = generator.uniform(0, 2 * np.pi, size=(2, 4_000))
    elevation = generator.uniform(radians(-2), radians(8), size=(2, 4_000))
    level = (
        np.cos(azimuth)[..., None] * horizons.north[:, None, :]
        + np.sin(azimuth)[..., None] * horizons.east[:, None, :]
    )
    directions = np.cos(elevation)[..., None] * level + np.sin(elevation)[..., None] * horizons.up[:, None, :]

    exact = terrain.trace_rays(observers, np.ascontiguousarray(directions))
    classified = ray_visibility(terrain, horizons, slice(0, 2), observers, directions)
    np.testing.assert_array_equal(classified, exact)


def test_single_viewpoint_skyline_equals_the_batch_horizon_kernel():
    terrain = _wall_terrain()
    origin = _POLE_OBSERVER[0]
    east, north, up = receiver_axes(_POLE_OBSERVER)
    batch_map = build_horizons(terrain, _POLE_OBSERVER)

    single, complete = terrain.horizon_around(origin, (east[0], north[0], up[0]), 720)
    np.testing.assert_array_equal(single, batch_map.elevation_rad[0])
    np.testing.assert_array_equal(complete, batch_map.complete[0])
    assert np.degrees(skyline_degrees(terrain, origin, (east[0], north[0], up[0]))).shape == (3600,)


def test_grid_slope_of_a_plane_matches_its_gradient():
    # Heights rise 0.1 m per metre toward +E, so the slope is atan(0.1) ≈ 5.71° everywhere.
    terrain = _synthetic_terrain(lambda east, north: 0.1 * east)
    prepared = prepare_site(SiteFootprint(-90, 0, 500), terrain, SimulationSettings(grid_spacing_m=50))

    slopes = prepared.slope_deg[prepared.inside]
    assert np.isfinite(slopes).all()
    np.testing.assert_allclose(slopes, np.degrees(np.arctan(0.1)), atol=0.1)
    assert np.isnan(prepared.slope_deg[~prepared.inside]).all()


def test_visibility_windows_locate_changes_within_one_second():
    start = datetime(2026, 11, 15, tzinfo=UTC)
    sunset = start + timedelta(minutes=37, seconds=23)
    sunrise = start + timedelta(hours=2, minutes=5, seconds=41)

    def states(times):
        return ["blocked" if sunset <= time < sunrise else "clear" for time in times]

    windows = visibility_windows(start, start + timedelta(hours=3), states)
    assert [window.visibility for window in windows] == ["clear", "blocked", "clear"]
    assert abs(windows[0].end_utc - sunset) <= timedelta(seconds=1)
    assert abs(windows[1].end_utc - sunrise) <= timedelta(seconds=1)


def test_horizon_snapshot_equals_direct_snapshot_on_nasa_terrain():
    data_dir = Path(__file__).resolve().parents[2] / "DATA"
    fixture = data_dir / "runs/shackleton-20261114T1200/summary.json"
    if not fixture.is_file():
        pytest.skip("Local NASA terrain and the archived Shackleton ephemeris are required.")

    report = json.loads(fixture.read_text())
    archived = report["ephemeris"]["samples"][0]
    ephemeris = EphemerisSample(
        at_utc=datetime.fromisoformat(archived["at_utc"]),
        et_tdb_seconds=archived["et_tdb_seconds"],
        sun_m=np.array(archived["sun_m"]),
        earth_m=np.array(archived["earth_m"]),
    )
    site = SiteFootprint(report["site"]["latitude_deg"], report["site"]["longitude_deg"], 500)
    terrain = prepare_terrain(data_dir, site)
    prepared = prepare_site(site, terrain, SimulationSettings(grid_spacing_m=100))

    horizons = build_horizons(terrain, prepared.solar_origins_m)
    direct = trace_snapshot(prepared, ephemeris)
    fast = trace_snapshot(prepared, ephemeris, horizons)
    for name, values in vars(direct.grid).items():
        np.testing.assert_array_equal(values, getattr(fast.grid, name), err_msg=name)
