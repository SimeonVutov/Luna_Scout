"""Offline science and queue contracts preserved by the readability refactor."""

import json
from time import time_ns
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest

from lunascout.ephemeris.horizons import EphemerisSample
from lunascout.jobs.metrics import Reading, integrate
from lunascout.jobs.plan import RunPlan
from lunascout.jobs.scheduler import RunQueue
from lunascout.simulation.engine import SimulationSettings, calculate_snapshot
from lunascout.simulation.frames import SiteFootprint, local_axes, site_directions
from lunascout.simulation.radiation import (
    AU_M,
    SUN_RADIUS_M,
    _earth_occultation_mask,
    direct_sunlight,
    disk_directions,
)
from lunascout.terrain import mesh
from lunascout.terrain.model import prepare_terrain


@pytest.mark.parametrize("latitude,longitude", [(-90, 0), (-90, 123), (-75, -180)])
def test_local_axes_are_right_handed_and_orthonormal(latitude, longitude):
    east, north, up = local_axes(latitude, longitude)
    basis = np.array([east, north, up])
    np.testing.assert_allclose(basis @ basis.T, np.eye(3), atol=1e-15)
    np.testing.assert_allclose(np.cross(east, north), up, atol=1e-15)


def test_reporting_center_has_unit_area_weight():
    site = SiteFootprint(-90, 45, 500)
    directions, weights = site_directions(site, np.zeros(1), np.zeros(1))
    np.testing.assert_allclose(directions[0], local_axes(-90, 45)[2])
    np.testing.assert_array_equal(weights, [1])


def test_earth_occultation_requires_forward_intersection_before_sun():
    earth = np.array([[10_000_000., 0, 0], [-10_000_000., 0, 0], [10_000_000., 0, 0]])
    rays = np.array([[[1., 0, 0]], [[1., 0, 0]], [[0., 1, 0]]])
    mask = _earth_occultation_mask(earth, rays, np.full(3, AU_M))
    np.testing.assert_array_equal(mask, [[True], [False], [False]])
    assert not _earth_occultation_mask(earth[:1], rays[:1], np.array([1.]))[0, 0]


@pytest.mark.parametrize("direction", [[1., 0, 0], [0., 0, 1]])
def test_single_disk_ray_uses_center(direction):
    sun_vector = np.array([direction]) * AU_M
    disk = disk_directions(sun_vector, SUN_RADIUS_M, 1)
    np.testing.assert_allclose(disk.directions[0, 0], direction)
    np.testing.assert_allclose(disk.separation_cos, [[1.]])
    np.testing.assert_allclose(disk.distances_m, [AU_M])


class _ConstantTerrain:
    def __init__(self, status):
        self.status = status

    def trace_rays(self, origins_m, directions):
        return np.full(directions.shape[:2], self.status, dtype=np.int8)


@pytest.mark.parametrize(
    "status,expected_fraction,expected_flux",
    [(mesh.CLEAR, (1., 1.), (1361., 1361.)),
     (mesh.BLOCKED, (0., 0.), (0., 0.)),
     (mesh.UNKNOWN, (0., 1.), (0., 1361.))],
)
def test_sunlight_preserves_coverage_bounds(status, expected_fraction, expected_flux):
    lower, upper, flux_lower, flux_upper = direct_sunlight(
        _ConstantTerrain(status), np.zeros((1, 3)), np.array([[1., 0, 0]]),
        np.array([AU_M, 0, 0]), np.array([0, 400_000_000., 0]), 37,
    )
    np.testing.assert_allclose([lower[0], upper[0]], expected_fraction)
    np.testing.assert_allclose([flux_lower[0], flux_upper[0]], expected_flux)


def _reading(at, visibility, lit, flux):
    return Reading.model_validate({
        "at_utc": at, "center_ground_height_m": 0,
        "sun_at_collector": None, "earth_at_mast": None,
        "earth_center_visibility": visibility,
        "summary": {
            "sample_count": 1, "ground_sample_count": 1,
            "ground_covered_area_fraction": 1, "sun_resolved_area_fraction": 1,
            "lit_area_fraction": {"lower": lit, "upper": lit},
            "mean_visible_sun_fraction": {"lower": lit, "upper": lit},
            "mean_irradiance_on_known_ground_w_m2": {"lower": flux, "upper": flux},
        },
    })


def test_linear_integration_splits_midnight_and_estimates_earth_transition():
    start = datetime(2026, 11, 14, 23, tzinfo=UTC)
    end = datetime(2026, 11, 15, 1, tzinfo=UTC)
    period = integrate([_reading(start, "clear", 0, 0), _reading(end, "blocked", 1, 1000)])
    assert period.sunlit_hours.lower == 1
    assert period.incident_energy_kwh_m2.lower == 1
    assert period.earth_visible_hours.lower == 1
    assert [day.incident_energy_kwh_m2.lower for day in period.days] == [0.25, 0.75]
    assert period.earth_windows[0].end_utc == datetime(2026, 11, 15, tzinfo=UTC)


def test_unknown_earth_endpoint_retains_full_interval_uncertainty():
    start = datetime(2026, 11, 14, tzinfo=UTC)
    period = integrate([
        _reading(start, "clear", 1, 1000),
        _reading(start + timedelta(hours=1), "unknown", 1, 1000),
    ])
    assert period.earth_visible_hours.lower == 0
    assert period.earth_visible_hours.upper == 1
    assert period.earth_resolved_hours == 0


def test_queue_prioritizes_playhead_and_resumes_failed_run(tmp_path):
    start = datetime(2026, 11, 14, tzinfo=UTC)
    plan = RunPlan(
        site=SiteFootprint(-89.7668, -171.87, 500), settings=SimulationSettings(),
        start_utc=start, end_utc=start + timedelta(hours=2),
        snapshot_minutes=60, integration_minutes=15, model_revision=1, sources_sha256={},
    )
    queue = RunQueue(tmp_path)
    queue.initialize()
    status = queue.submit(plan, start + timedelta(hours=1))
    batch = queue.next_batch(3)
    assert batch is not None
    assert batch.indices == (4,)
    queue.record(batch, 4, _reading(plan.at(4), "clear", 1, 1000))
    queue.fail(status.run_id, "temporary failure")
    resumed = queue.submit(plan)
    assert resumed.run_id == status.run_id
    assert resumed.completed_samples == 1
    assert resumed.ready_indices == [1]
    next_batch = queue.next_batch(3)
    assert next_batch is not None
    assert next_batch.indices == (0,)


def test_saved_shackleton_snapshot_matches_all_grid_arrays():
    data_dir = Path(__file__).resolve().parents[2] / "DATA"
    fixture = data_dir / "runs/shackleton-20261114T1200"
    if not (fixture / "summary.json").is_file():
        pytest.skip("Local NASA terrain and archived Shackleton fixture are required.")

    report = json.loads((fixture / "summary.json").read_text())
    archived = report["ephemeris"]["samples"][0]
    ephemeris = EphemerisSample(
        at_utc=datetime.fromisoformat(archived["at_utc"]),
        et_tdb_seconds=archived["et_tdb_seconds"],
        sun_m=np.array(archived["sun_m"]), earth_m=np.array(archived["earth_m"]),
    )
    site = SiteFootprint(**report["site"])

    # The fixture predates the extra 5 m tiles and the receiver presets, so rebuild
    # it from exactly the inputs it recorded: its two local DEMs and the terrain facet.
    local_dems = [
        data_dir / "raw" / "terrain" / source["filename"]
        for source in report["terrain"]["sources"]
        if "_5mpp_" in source["filename"]
    ]
    terrain = prepare_terrain(data_dir, site, local_dems=local_dems)
    settings = SimulationSettings(**report["settings"], receiver="terrain")
    snapshot = calculate_snapshot(site, ephemeris, terrain, settings)

    assert snapshot.summary.sample_count == 1961
    assert snapshot.summary.lit_area_fraction.lower == pytest.approx(0.958694543811824)
    assert snapshot.earth_center_visibility == "blocked"
    with np.load(fixture / "grid.npz", allow_pickle=False) as saved:
        for name, actual in vars(snapshot.grid).items():
            if name in saved:  # Fields added after the fixture was archived have no reference.
                np.testing.assert_allclose(actual, saved[name], rtol=1e-12, atol=1e-10)


def test_run_list_and_worker_heartbeat(tmp_path):
    start = datetime(2026, 11, 14, tzinfo=UTC)
    plan = RunPlan(
        site=SiteFootprint(-89.7668, -171.87, 500), settings=SimulationSettings(),
        start_utc=start, end_utc=start + timedelta(hours=1),
        snapshot_minutes=60, integration_minutes=15, model_revision=1, sources_sha256={},
    )
    queue = RunQueue(tmp_path)
    queue.initialize()
    assert not queue.worker_status().running

    queue.submit(plan)
    runs = queue.list_runs()
    assert [run.run_id for run in runs] == [plan.identity()]
    assert runs[0].submitted_utc is not None

    queue.beat(4242)
    queue.set_activity(plan.identity(), "Computing snapshots")
    status = queue.worker_status()
    assert (status.running, status.pid, status.activity) == (True, 4242, "Computing snapshots")

    # A worker that has not reported for longer than the timeout is treated as stopped.
    assert not queue.worker_status(now_ns=time_ns() + 60_000_000_000).running
    queue.stop_beating()
    assert not queue.worker_status().running
