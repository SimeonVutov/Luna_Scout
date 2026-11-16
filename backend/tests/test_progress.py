"""Progress estimates: the learned cost model, the stages of a run, and time shared with other runs."""

from datetime import UTC, datetime

import pytest
from test_science_regression import _hourly_plan

from lunascout.jobs.performance import Cost, Model, load_model, record
from lunascout.jobs.progress import ProgressState, estimate, grid_point_count, shared_remaining
from lunascout.jobs.scheduler import RunQueue

START = datetime(2026, 12, 1, tzinfo=UTC)


def test_the_cost_model_fits_measured_work_and_starts_again_on_a_different_server_size(tmp_path):
    # Samples on 8 cores: 0.01 s fixed plus 0.00003 s per point.
    for points in (100, 500, 1000, 2000):
        record(tmp_path, "sample", points, 0.01 + 3e-5 * points, cpus=8)

    # Only samples timed so far: the rest is still typical, and the model says so.
    assert load_model(tmp_path, cpus=8).basis == "typical"
    for kind, units, seconds in (("terrain", 1, 3.0), ("horizon", 500, 50.0), ("windows", 3, 1.0)):
        record(tmp_path, kind, units, seconds, cpus=8)

    measured = load_model(tmp_path, cpus=8)
    assert measured.basis == "measured"
    assert measured.costs["sample"].fixed_s == pytest.approx(0.01)
    assert measured.costs["sample"].per_unit_s == pytest.approx(3e-5)

    # Resized to 2 cores: the 8-core numbers are scaled until 2-core runs are timed.
    resized = load_model(tmp_path, cpus=2)
    assert resized.basis == "scaled"
    assert resized.costs["sample"].per_unit_s == pytest.approx(3e-5 * 2.5 / 2)
    assert resized.costs["horizon"].per_unit_s > measured.costs["horizon"].per_unit_s * 3.9

    for kind, units, seconds in (("sample", 500, 0.05), ("terrain", 1, 9.0), ("horizon", 500, 200.0), ("windows", 3, 2.0)):
        record(tmp_path, kind, units, seconds, cpus=2)
    assert load_model(tmp_path, cpus=2).basis == "measured"
    assert load_model(tmp_path / "empty", cpus=2).basis == "typical"


def _model() -> Model:
    return Model(
        {
            "terrain": Cost(2.0, 0.0),
            "direct": Cost(0.0, 0.01),
            "horizon": Cost(1.0, 0.1),
            "sample": Cost(0.0, 0.001),
            "windows": Cost(1.0, 0.0),
        },
        "measured",
    )


def test_stages_follow_the_worker_and_skip_what_is_already_saved():
    plan = _hourly_plan(START, 24)
    points = grid_point_count(plan)
    assert points == 1961

    # Nothing saved for this centre yet: every stage is pending and horizons cost the most.
    stages, remaining = estimate(plan, completed_samples=0, reused_samples=0, state=ProgressState(),
                                 model=_model(), saved_horizon_points=0, now_ns=0)
    by_key = {stage.key: stage for stage in stages}
    assert [stage.state for stage in stages] == ["pending"] * 4
    assert by_key["horizons"].seconds == pytest.approx(1.0 + 0.1 * points)
    assert remaining == pytest.approx(sum(stage.seconds for stage in stages))

    # Horizons already saved, and earlier runs had computed half the samples.
    half = (plan.interval_count + 1) // 2
    state = ProgressState(phase="snapshots", points=points, horizon_missing=0, finished=["preparing", "horizons"])
    stages, remaining = estimate(plan, completed_samples=half + 10, reused_samples=half, state=state,
                                 model=_model(), saved_horizon_points=points, now_ns=0)
    by_key = {stage.key: stage for stage in stages}
    assert by_key["horizons"].state == "skipped" and by_key["horizons"].seconds == 0
    assert by_key["snapshots"].state == "active"
    assert by_key["snapshots"].total_units == plan.interval_count + 1 - half
    assert by_key["snapshots"].done_units == 10
    assert remaining < sum(stage.seconds for stage in stages)

    # Halfway through building horizons.
    state = ProgressState(phase="horizons", points=points, horizon_missing=200, horizon_done=100, finished=["preparing"])
    by_key = {stage.key: stage for stage in estimate(plan, completed_samples=1, reused_samples=0, state=state,
                                                     model=_model(), saved_horizon_points=0, now_ns=0)[0]}
    assert by_key["preparing"].state == "done"
    assert by_key["horizons"].state == "active" and by_key["horizons"].fraction == 0.5


def test_runs_taking_turns_share_the_time_left():
    assert shared_remaining(60, []) == 60
    # A shorter run finishes first and only delays this one by its own length.
    assert shared_remaining(60, [20, 100]) == 60 + 20 + 60


def test_reported_stages_reach_the_run_status_until_it_completes(tmp_path):
    queue = RunQueue(tmp_path)
    queue.initialize()
    plan = _hourly_plan(START, 3)
    run_id = queue.submit(plan, session="browser-a").run_id

    waiting = queue.status(run_id)
    assert waiting.progress is not None and waiting.progress.waiting

    queue.set_progress(run_id, phase="preparing", points=1961)
    started = queue.status(run_id)
    assert started.revision > waiting.revision
    assert not started.progress.waiting
    assert [stage.state for stage in started.progress.stages][0] == "active"

    queue.complete(run_id, _period())
    assert queue.status(run_id).progress is None


def _period():
    from lunascout.jobs.metrics import integrate
    from test_science_regression import _reading
    return integrate([_reading(START, "clear", 1, 1000), _reading(datetime(2026, 12, 2, tzinfo=UTC), "clear", 1, 1000)])
