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
from lunascout.jobs.scheduler import RunQueue, WorkBatch
from lunascout.simulation.engine import Bounds, SimulationSettings, calculate_snapshot
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


def _hourly_plan(start, hours, **settings):
    return RunPlan(
        site=SiteFootprint(-89.7668, -171.87, 500), settings=SimulationSettings(**settings),
        start_utc=start, end_utc=start + timedelta(hours=hours),
        snapshot_minutes=60, integration_minutes=15, model_revision=1, sources_sha256={},
    )


def _compute_all(queue, plan):
    """Stand in for the worker: record every sample, and a snapshot file for each published hour."""
    run_id = plan.identity()
    for index in range(plan.interval_count + 1):
        if plan.is_frame(index):
            path = queue.frame_path(run_id, index)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"snapshot")
        queue.record(WorkBatch(run_id, plan, (index,)), index, _reading(plan.at(index), "clear", 1, 1000))


def test_changing_the_range_computes_only_the_missing_samples(tmp_path):
    start = datetime(2026, 11, 14, tzinfo=UTC)
    queue = RunQueue(tmp_path)
    queue.initialize()
    short, long, shorter = _hourly_plan(start, 3), _hourly_plan(start, 6), _hourly_plan(start, 2)
    assert short.physics_key() == long.physics_key() != _hourly_plan(start, 3, solar_disk_samples=10).physics_key()

    queue.submit(short)
    _compute_all(queue, short)
    queue.complete(short.identity(), integrate(queue.readings(short.identity())))

    # A longer range starts with the samples it shares. The old closing endpoint was never a
    # published snapshot, but is one now, so it is computed again along with everything after it.
    expanded = queue.submit(long)
    assert expanded.completed_samples == 12
    assert expanded.ready_indices == [0, 1, 2]
    shared = [queue.frame_path(short.identity(), 4), queue.frame_path(long.identity(), 4)]
    assert shared[0].stat().st_ino == shared[1].stat().st_ino
    assert queue.provenance(long.identity()).reused_samples[0].samples == 12
    batch = queue.next_batch(100)
    assert batch is not None and batch.run_id == long.identity()
    assert batch.indices[:3] == (12, 16, 20) and set(batch.indices) == set(range(12, 25))

    # A shorter range is complete at once, and the earlier results are still there.
    contracted = queue.submit(shorter)
    assert (contracted.completed_samples, contracted.total_samples) == (9, 9)
    assert queue.status(short.identity()).completed_samples == 13

    # Different physics never borrows samples.
    assert queue.submit(_hourly_plan(start, 3, solar_disk_samples=10)).completed_samples == 0


def test_deleting_a_site_removes_its_runs_and_snapshot_files(tmp_path):
    start = datetime(2026, 11, 14, tzinfo=UTC)
    queue = RunQueue(tmp_path)
    queue.initialize()
    plan = _hourly_plan(start, 2)
    queue.submit(plan)
    _compute_all(queue, plan)
    queue.submit(_hourly_plan(start, 4))

    assert queue.purge_site(-89.7668, -171.87, 500) == 2
    assert queue.list_runs() == []
    assert not (tmp_path / "runs" / plan.identity()).exists()
    assert queue.purge_site(-89.7668, -171.87, 500) == 0


def test_a_restored_reference_site_keeps_only_what_falls_inside_its_timeline(tmp_path):
    start = datetime(2026, 11, 14, tzinfo=UTC)
    queue = RunQueue(tmp_path)
    queue.initialize()
    original = _hourly_plan(start, 6)
    queue.submit(original)
    _compute_all(queue, original)
    queue.complete(original.identity(), integrate(queue.readings(original.identity())))

    # Deleting the site hides its runs but keeps their results.
    assert queue.keep_site(-89.7668, -171.87, 500) == 1
    assert queue.list_runs() == []
    assert (tmp_path / "runs" / original.identity()).exists()

    # Bringing it back with a timeline covering only the middle hours restores just those.
    later = _hourly_plan(start + timedelta(hours=2), 2)
    restored = queue.submit(later)
    assert (restored.completed_samples, restored.total_samples) == (9, 9)
    assert restored.ready_indices == [0, 1]
    assert queue.frame_path(later.identity(), 0).read_bytes() == b"snapshot"

    # The old run, with the hours outside the new timeline, is gone.
    assert queue.status(original.identity()) is None
    assert not (tmp_path / "runs" / original.identity()).exists()


def test_kept_results_expire_when_the_site_never_returns(tmp_path):
    start = datetime(2026, 11, 14, tzinfo=UTC)
    queue = RunQueue(tmp_path)
    queue.initialize()
    plan = _hourly_plan(start, 2)
    queue.submit(plan)
    _compute_all(queue, plan)
    queue.keep_site(-89.7668, -171.87, 500)

    assert queue.prune_kept(timedelta(days=14)) == 0
    assert queue.prune_kept(timedelta(seconds=-1)) == 1
    assert queue.status(plan.identity()) is None


def test_longest_day_and_earth_contact_come_from_the_exact_windows():
    from lunascout.jobs.metrics import PeriodSummary
    from lunascout.simulation.events import VisibilityWindow

    start = datetime(2026, 11, 15, tzinfo=UTC)
    hours = lambda h: start + timedelta(hours=h)  # noqa: E731
    sun = [
        VisibilityWindow(start_utc=hours(0), end_utc=hours(5), visibility="clear"),
        VisibilityWindow(start_utc=hours(5), end_utc=hours(9), visibility="blocked"),
        VisibilityWindow(start_utc=hours(9), end_utc=hours(24), visibility="clear"),
    ]
    earth = [
        VisibilityWindow(start_utc=hours(0), end_utc=hours(10), visibility="blocked"),
        VisibilityWindow(start_utc=hours(10), end_utc=hours(16), visibility="clear"),
        VisibilityWindow(start_utc=hours(16), end_utc=hours(24), visibility="blocked"),
    ]
    zero = Bounds(0, 0)
    period = PeriodSummary(
        sunlit_hours=zero, incident_energy_kwh_m2=None, earth_visible_hours=zero, earth_resolved_hours=0,
        days=[], earth_windows=earth, sun_windows=sun,
    )

    # The longest day is the 15 h window that runs to the end of the period, so it is flagged as cut off.
    assert period.longest_daylight.hours == 15 and period.longest_daylight.truncated
    assert period.longest_earth_contact.hours == 6 and not period.longest_earth_contact.truncated
