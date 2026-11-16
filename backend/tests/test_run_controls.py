"""Pausing, resuming and cancelling runs, finding what the server already has, and who may control a run."""

from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from test_science_regression import _compute_all, _hourly_plan, _reading

from lunascout.api.public import PublicMode
from lunascout.api.science import science_router
from lunascout.jobs.scheduler import RunPaused, RunQueue, WorkBatch

START = datetime(2026, 12, 1, tzinfo=UTC)


def _queue(tmp_path) -> RunQueue:
    queue = RunQueue(tmp_path)
    queue.initialize()
    return queue


def test_a_paused_run_gets_no_work_until_resumed_and_resubmitting_does_not_restart_it(tmp_path):
    queue = _queue(tmp_path)
    plan = _hourly_plan(START, 3)
    run_id = queue.submit(plan, owner="browser-one").run_id

    assert queue.pause(run_id).stage == "paused"
    assert queue.next_batch(8) is None
    # A worker that was already computing stops at its next sample.
    with pytest.raises(RunPaused):
        queue.record(WorkBatch(run_id, plan, (0,)), 0, _reading(plan.at(0), "clear", 1, 1000))
    # Changing the timeline resubmits the same request; a paused run stays paused.
    assert queue.submit(plan).stage == "paused"

    assert queue.resume(run_id).stage == "queued"
    assert queue.next_batch(8).run_id == run_id


def test_cancelling_deletes_the_run_and_lookup_reports_what_earlier_runs_computed(tmp_path):
    queue = _queue(tmp_path)
    first_day = _hourly_plan(START, 24)
    queue.submit(first_day)
    _compute_all(queue, first_day)

    two_days = _hourly_plan(START, 48)
    lookup = queue.lookup(two_days)
    assert lookup.run is None
    assert lookup.reusable_samples == first_day.interval_count + 1
    assert lookup.total_samples == two_days.interval_count + 1

    assert queue.lookup(first_day).run.run_id == first_day.identity()
    assert queue.cancel(first_day.identity())
    assert queue.status(first_day.identity()) is None
    assert queue.lookup(two_days).reusable_samples == 0


def _endpoint(router, path: str, method: str):
    return next(route.endpoint for route in router.routes if route.path == path and method in route.methods)


def test_on_a_public_server_only_the_starting_browser_may_pause_or_cancel_but_anyone_may_resume(tmp_path):
    queue = _queue(tmp_path)
    run_id = queue.submit(_hourly_plan(START, 3), owner="browser-one").run_id
    router = science_router(tmp_path, queue, PublicMode(enabled=True))
    pause = _endpoint(router, "/api/runs/{run_id}/pause", "POST")
    resume = _endpoint(router, "/api/runs/{run_id}/resume", "POST")
    cancel = _endpoint(router, "/api/runs/{run_id}", "DELETE")

    for control in (pause, cancel):
        with pytest.raises(HTTPException) as refused:
            control(run_id, session="browser-two")
        assert refused.value.status_code == 403

    assert pause(run_id, session="browser-one").stage == "paused"
    assert resume(run_id).stage == "queued"
    cancel(run_id, session="browser-one")
    assert queue.status(run_id) is None

    # A private server has one user, so any browser may control any run.
    private_run = queue.submit(_hourly_plan(START, 2), owner="browser-one").run_id
    private_pause = _endpoint(science_router(tmp_path, queue), "/api/runs/{run_id}/pause", "POST")
    assert private_pause(private_run, session=None).stage == "paused"
