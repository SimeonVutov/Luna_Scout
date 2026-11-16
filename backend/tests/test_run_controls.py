"""Run controls act on one browser's request, cancelling deletes nothing, and overlaps compute once."""

from datetime import UTC, datetime, timedelta

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


def test_one_browsers_pause_never_stops_a_run_another_browser_still_wants(tmp_path):
    queue = _queue(tmp_path)
    plan = _hourly_plan(START, 3)
    run_id = queue.submit(plan, session="browser-a").run_id
    queue.submit(plan, session="browser-b")

    assert queue.pause(run_id, "browser-a").stage == "queued"
    assert queue.next_batch(8).run_id == run_id

    # Once every requester has paused, the worker stops at its next sample.
    assert queue.pause(run_id, "browser-b").stage == "paused"
    assert queue.next_batch(8) is None
    with pytest.raises(RunPaused):
        queue.record(WorkBatch(run_id, plan, (0,)), 0, _reading(plan.at(0), "clear", 1, 1000))

    # A requester changing the timeline does not restart it; a new requester does.
    assert queue.submit(plan, session="browser-a").stage == "paused"
    assert queue.submit(plan, session="browser-c").stage == "queued"
    assert queue.pause(run_id, "browser-c").stage == "paused"
    assert queue.resume(run_id, "browser-a").stage == "queued"


def test_cancelling_keeps_every_computed_sample_for_later_and_overlapping_requests(tmp_path):
    queue = _queue(tmp_path)
    first_day = _hourly_plan(START, 24)
    queue.submit(first_day, session="browser-a")
    queue.submit(first_day, session="browser-b")
    _compute_all(queue, first_day)

    # Another browser still wants it, so one cancel changes nothing for them.
    assert queue.cancel(first_day.identity(), "browser-a").stage == "queued"
    assert [run.run_id for run in queue.list_runs()] == [first_day.identity()]

    # The last cancel hides the run and stops it, but deletes nothing.
    assert queue.cancel(first_day.identity(), "browser-b").stage == "paused"
    assert queue.list_runs() == [] and queue.next_batch(8) is None
    assert queue.status(first_day.identity()).completed_samples == first_day.interval_count + 1

    two_days = _hourly_plan(START, 48)
    assert queue.lookup(two_days).reusable_samples == first_day.interval_count + 1
    assert queue.lookup(first_day).run is None
    assert queue.lookup(first_day).reusable_samples == first_day.interval_count + 1
    # Asking for it again brings it back with everything it had.
    assert queue.submit(first_day, session="browser-c").completed_samples == first_day.interval_count + 1
    assert queue.list_runs()[0].run_id == first_day.identity()


def test_runs_nobody_wants_expire_but_what_others_copied_stays(tmp_path):
    queue = _queue(tmp_path)
    first_day = _hourly_plan(START, 24)
    queue.submit(first_day, session="browser-a")
    _compute_all(queue, first_day)
    two_days = _hourly_plan(START, 48)
    copied = queue.submit(two_days, session="browser-b").completed_samples

    queue.cancel(first_day.identity(), "browser-a")
    assert queue.prune_abandoned(timedelta(days=14)) == 0
    assert queue.prune_abandoned(timedelta(0)) == 1
    assert queue.status(first_day.identity()) is None
    assert queue.status(two_days.identity()).completed_samples == copied
    assert queue.frame(two_days.identity(), 1)[1].is_file()

    # A page still watching the deleted run is told it is gone.
    statuses, removed = queue.changes({first_day.identity(): 1, two_days.identity(): -1})
    assert removed == [first_day.identity()] and [status.run_id for status in statuses] == [two_days.identity()]


def test_overlapping_runs_compute_each_time_once_even_while_both_are_running(tmp_path):
    queue = _queue(tmp_path)
    days_one_and_two = _hourly_plan(START, 48)
    days_two_and_three = _hourly_plan(START + timedelta(days=1), 48)
    # Both are submitted before either has computed anything.
    queue.submit(days_one_and_two, session="browser-a")
    queue.submit(days_two_and_three, session="browser-b")

    _compute_all(queue, days_one_and_two)
    batch = queue.next_batch(400)

    # The second run took day two from the first and is left with only day three.
    assert batch.run_id == days_two_and_three.identity()
    shared = days_one_and_two.interval_count - 96
    assert queue.status(days_two_and_three.identity()).completed_samples == shared
    assert min(batch.indices) >= 96 and len(batch.indices) == days_two_and_three.interval_count + 1 - shared


def _endpoint(router, path: str, method: str):
    return next(route.endpoint for route in router.routes if route.path == path and method in route.methods)


def test_on_a_public_server_each_browser_controls_only_its_own_request(tmp_path):
    queue = _queue(tmp_path)
    plan = _hourly_plan(START, 3)
    run_id = queue.submit(plan, session="browser-one").run_id
    queue.submit(plan, session="browser-two")
    router = science_router(tmp_path, queue, PublicMode(enabled=True))
    pause = _endpoint(router, "/api/runs/{run_id}/pause", "POST")
    resume = _endpoint(router, "/api/runs/{run_id}/resume", "POST")
    cancel = _endpoint(router, "/api/runs/{run_id}", "DELETE")

    with pytest.raises(HTTPException) as anonymous:
        pause(run_id, session=None)
    assert anonymous.value.status_code == 422

    # Browser two's cancel withdraws only its own request; browser one's run carries on.
    assert cancel(run_id, session="browser-two").stage == "queued"
    assert pause(run_id, session="browser-one").stage == "paused"
    assert resume(run_id, session="browser-one").stage == "queued"
