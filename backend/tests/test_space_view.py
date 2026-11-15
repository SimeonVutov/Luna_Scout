"""Checks for the 3D view's data: elevation tiles and the centre rays.

The tile and ray tests use the NASA LOLA files and the archived Shackleton ephemeris, and are
skipped when they are absent.
"""

import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest
import rasterio

from lunascout.ephemeris.horizons import EphemerisSample
from lunascout.simulation.engine import (
    SimulationSettings,
    place_centre_instruments,
    prepare_site,
    trace_snapshot,
)
from lunascout.simulation.frames import SiteFootprint
from lunascout.simulation.rays import centre_ray_fans
from lunascout.terrain.model import prepare_terrain
from lunascout.terrain.tiles import TILE_BORDER, TILE_NODES, node_spacing_m, sample_tile

_DATA_DIR = Path(__file__).resolve().parents[2] / "DATA"
_FIXTURE = _DATA_DIR / "runs/shackleton-20261114T1200/summary.json"
_DEM_80M = _DATA_DIR / "raw/terrain/LDEM_80S_80MPP_ADJ.TIF"


def test_a_tile_holds_the_lola_heights_at_its_nodes():
    if not _DEM_80M.is_file():
        pytest.skip("The NASA 80 m LOLA grid is required.")

    # Level 10 nodes are 33 m apart, finer than the 80 m grid, so each node is a plain
    # bilinear read of the grid at the same projected point.
    level, row, column = 10, 520, 530
    heights = sample_tile(_DATA_DIR, level, row, column)
    assert heights.shape == (TILE_NODES, TILE_NODES)

    spacing = node_spacing_m(level)
    tile_width = spacing * (TILE_NODES - 1 - 2 * TILE_BORDER)
    west = -1_095_930.0 + column * tile_width
    north = 1_095_930.0 - row * tile_width
    with rasterio.open(_DEM_80M) as raster:
        grid = raster.read(1)
        transform = raster.transform
    for i, j in [(5, 7), (20, 41), (33, 33), (60, 12)]:
        x = west + (j - TILE_BORDER) * spacing
        y = north - (i - TILE_BORDER) * spacing
        # Pixel coordinates measured from pixel centres: p = (x − x₀)/s − ½
        column_px = (x - transform.c) / transform.a - 0.5
        row_px = (y - transform.f) / transform.e - 0.5
        c0, r0 = int(np.floor(column_px)), int(np.floor(row_px))
        fx, fy = column_px - c0, row_px - r0
        expected = (
            grid[r0, c0] * (1 - fx) * (1 - fy) + grid[r0, c0 + 1] * fx * (1 - fy)
            + grid[r0 + 1, c0] * (1 - fx) * fy + grid[r0 + 1, c0 + 1] * fx * fy
        )
        assert heights[i, j] == pytest.approx(expected, abs=0.01)


def test_centre_ray_fans_agree_with_the_simulation_snapshot():
    if not _FIXTURE.is_file():
        pytest.skip("Local NASA terrain and the archived Shackleton ephemeris are required.")

    archived = json.loads(_FIXTURE.read_text())["ephemeris"]["samples"][0]
    ephemeris = EphemerisSample(
        at_utc=datetime.fromisoformat(archived["at_utc"]),
        et_tdb_seconds=archived["et_tdb_seconds"],
        sun_m=np.array(archived["sun_m"]),
        earth_m=np.array(archived["earth_m"]),
    )
    site = SiteFootprint(-89.54, 129.2, 500)
    settings = SimulationSettings(grid_spacing_m=100, ray_method="direct")
    terrain = prepare_terrain(_DATA_DIR, site)
    prepared = prepare_site(site, terrain, settings)
    snapshot = trace_snapshot(prepared, ephemeris)

    instruments = place_centre_instruments(site, terrain, settings)
    assert instruments is not None
    sun, earth = centre_ray_fans(terrain, instruments, ephemeris, settings.solar_disk_samples)

    assert snapshot.earth_disk_visible_fraction is not None
    assert earth.visible_fraction == snapshot.earth_disk_visible_fraction

    # The grid cell at offset (0, 0) is traced from the same point as the collector.
    centre = len(prepared.offsets_m) // 2
    assert sun.visible_fraction.lower == snapshot.grid.visible_sun_fraction_lower[centre, centre]
    assert sun.visible_fraction.upper == snapshot.grid.visible_sun_fraction_upper[centre, centre]
    assert len(sun.directions) == settings.solar_disk_samples

    # The new per-point Earth line of sight equals the centre mast's Earth fraction there.
    assert snapshot.grid.earth_visible_fraction_lower[centre, centre] == snapshot.earth_disk_visible_fraction.lower
    assert snapshot.grid.earth_visible_fraction_upper[centre, centre] == snapshot.earth_disk_visible_fraction.upper


def test_context_maps_read_the_right_place_in_nasa_files():
    from math import radians, tan

    from lunascout.simulation.frames import MOON_RADIUS_M, local_axes
    from lunascout.terrain.context_maps import polar_xy_m, sample_context_map

    # Stereographic ρ = 2R·tan((90° + φ)/2): longitude 0 lies on +y, longitude 90°E on +x.
    _, _, up = local_axes(-85.0, 0.0)
    x_m, y_m = polar_xy_m(up[None, :])
    assert x_m[0] == pytest.approx(0, abs=1e-6)
    assert y_m[0] == pytest.approx(2 * MOON_RADIUS_M * tan(radians(2.5)))

    if not (_DATA_DIR / "raw/context/LPSR_85S_060M_201608.TIF").is_file():
        pytest.skip("The NASA long-term maps are required (lunascout-science fetch-data).")

    # Shackleton crater's floor never sees the Sun; the pole itself is lit about a quarter of the time.
    _, _, shackleton = local_axes(-89.9, 129.78)
    x_m, y_m = polar_xy_m(shackleton[None, :])
    assert sample_context_map(_DATA_DIR, "permanent_shadow", x_m, y_m).values[0] == 1.0
    assert sample_context_map(_DATA_DIR, "average_sunlight", x_m, y_m).values[0] == 0.0
    _, _, pole = local_axes(-90.0, 0.0)
    x_m, y_m = polar_xy_m(pole[None, :])
    assert 0.1 < sample_context_map(_DATA_DIR, "average_sunlight", x_m, y_m).values[0] < 0.5
