"""Diviner polar table: the fixed-width parser and the per-site numbers worked out by hand."""

from math import cos, radians, sin
from pathlib import Path

import numpy as np

from lunascout.terrain.context_maps import polar_xy_m
from lunascout.terrain.diviner import (
    RECORD_BYTES,
    PolarTable,
    build_compact_table,
    load_table,
    summarize_site_ice,
)


def _record(longitude: float, latitude: float, mean_k: float, max_k: float, depth: float) -> bytes:
    """One 210-byte table record laid out as the file is: nine vertex columns, then the values."""
    vertices = ", ".join(f"{0.0:12.5f}" for _ in range(9))
    text = (
        f"{vertices}, {longitude:15.9f}, {latitude:15.9f}, {0.5:15.9f}, "
        f"{mean_k:8.3f}, {max_k:8.3f}, {depth:11.5f}"
    )
    assert len(text) == 208
    return (text + "\r\n").encode("ascii")


def test_the_parser_reads_each_column_and_maps_the_ice_markers(tmp_path: Path):
    header = b"x" * (RECORD_BYTES - 2) + b"\r\n"
    rows = [
        _record(-45.0, -85.0, 162.9, 272.1, -999.0),   # no ice within reach
        _record(10.0, -89.0, 40.0, 60.0, -1.0),        # the table's undocumented coldest flag
        _record(20.0, -88.0, 90.0, 120.0, 0.0),        # ice stable at the surface
        _record(30.0, -87.0, 110.0, 250.0, 0.35),      # ice buried at 35 cm
    ]
    table_path = tmp_path / "prp.tab"
    table_path.write_bytes(header + b"".join(rows))

    compact_path = tmp_path / "compact.npz"
    build_compact_table(table_path, compact_path)
    table = load_table(compact_path)

    assert table is not None
    assert table.mean_temperature_k.tolist() == np.float32([162.9, 40.0, 90.0, 110.0]).tolist()
    assert table.max_temperature_k.tolist() == np.float32([272.1, 60.0, 120.0, 250.0]).tolist()
    assert np.isinf(table.ice_depth_m[0])
    assert table.ice_depth_m[1:].tolist() == [0.0, 0.0, np.float32(0.35)]

    # A triangle centre's position matches the south-polar projection of its latitude and longitude.
    latitude, longitude = radians(-89.0), radians(10.0)
    direction = np.array([cos(latitude) * cos(longitude), cos(latitude) * sin(longitude), sin(latitude)])
    expected_x, expected_y = polar_xy_m(direction)
    assert abs(table.x_m[1] - expected_x) < 0.1 and abs(table.y_m[1] - expected_y) < 0.1
    assert load_table(tmp_path / "missing.npz") is None


def _table() -> PolarTable:
    """Five triangle centres 300 m apart along x: no ice, surface ice, buried 0.2 m and 0.4 m, and no data."""
    x = np.array([0.0, 300.0, 600.0, 900.0, 1200.0])
    return PolarTable(
        x_m=x,
        y_m=np.zeros(5),
        mean_temperature_k=np.array([200.0, 50.0, 80.0, 90.0, np.nan], dtype=np.float32),
        max_temperature_k=np.array([300.0, 70.0, 150.0, 160.0, np.nan], dtype=np.float32),
        ice_depth_m=np.array([np.inf, 0.0, 0.2, 0.4, np.inf], dtype=np.float32),
    )


def test_a_site_takes_the_triangles_inside_it_and_never_averages_the_no_ice_marker():
    # Radius 400 m around x = 600 m holds the centres at 300, 600 and 900 m.
    summary = summarize_site_ice(_table(), 600.0, 0.0, 400.0)

    assert summary is not None
    assert summary.triangle_count == 3 and not summary.nearest_triangle_only
    assert summary.mean_temperature_k == np.float32(np.mean([50.0, 80.0, 90.0]))
    assert summary.coldest_max_temperature_k == 70.0
    assert summary.stable_ice_share == 1.0
    assert summary.surface_ice_share == 1 / 3
    assert summary.shallowest_ice_depth_m == 0.0
    assert abs(summary.mean_buried_ice_depth_m - 0.3) < 1e-6

    # Around x = 0 the one triangle has no stable ice, so there is no depth to report.
    bare = summarize_site_ice(_table(), 0.0, 0.0, 100.0)
    assert bare is not None
    assert bare.stable_ice_share == 0.0
    assert bare.shallowest_ice_depth_m is None and bare.mean_buried_ice_depth_m is None


def test_a_site_smaller_than_a_triangle_uses_the_nearest_one_and_a_site_off_the_table_gets_nothing():
    small = summarize_site_ice(_table(), 320.0, 10.0, 20.0)
    assert small is not None and small.triangle_count == 1 and small.nearest_triangle_only
    assert small.surface_ice_share == 1.0

    assert summarize_site_ice(_table(), 50_000.0, 0.0, 500.0) is None
