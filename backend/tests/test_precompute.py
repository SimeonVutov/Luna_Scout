"""Precomputed reference sites: they match the website, wait behind visitors, and are cleaned up."""

import json
import re
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from test_science_regression import _compute_all, _hourly_plan, _reading

from lunascout.jobs.scheduler import RunQueue, RunYielded, WorkBatch
from lunascout.reference_sites import DEFAULT_OPTIONS, DEFAULT_SNAPSHOT_MINUTES, REFERENCE_RADIUS_M, REFERENCE_SITES
from lunascout.science_cli import _end_of_next_month

FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src"
START = datetime(2026, 12, 1, tzinfo=UTC)


@pytest.mark.skipif(not FRONTEND.is_dir(), reason="Needs the website's source next to the backend.")
def test_the_reference_sites_and_defaults_match_the_website_exactly():
    listing = (FRONTEND / "features" / "sites" / "referenceSites.ts").read_text(encoding="utf-8")
    website_sites = [
        (name, float(latitude), float(longitude))
        for name, latitude, longitude in re.findall(r'site\("([^"]+)", (-?[\d.]+), (-?[\d.]+)\)', listing)
    ]
    assert website_sites == [(site.name, site.latitude_deg, site.longitude_deg) for site in REFERENCE_SITES]
    assert f"radius_m: {REFERENCE_RADIUS_M} }}" in listing

    science = (FRONTEND / "features" / "results" / "useScience.ts").read_text(encoding="utf-8")
    block = re.search(r"defaultOptions: SimulationOptions = \{(.*?)\};", science, re.S).group(1)
    website_options = {key: json.loads(value) for key, value in re.findall(r'(\w+): ("[^"]*"|[\d.]+)', block)}
    assert website_options == DEFAULT_OPTIONS

    time_module = (FRONTEND / "features" / "timeline" / "time.ts").read_text(encoding="utf-8")
    assert f"snapshot_minutes: {DEFAULT_SNAPSHOT_MINUTES}," in time_module


def test_background_work_waits_behind_visitors_and_steps_aside_mid_batch(tmp_path):
    queue = RunQueue(tmp_path)
    queue.initialize()
    background = _hourly_plan(START, 24)
    queue.submit(background, owner="precompute", background=True)
    # Precomputing never fills the public server's limit on waiting visitors' runs.
    assert queue.unfinished_count() == 0
    assert queue.next_batch(4).run_id == background.identity()

    visitor = _hourly_plan(START, 3, solar_disk_samples=10)
    queue.submit(visitor, owner="browser-one")
    assert queue.unfinished_count() == 1
    with pytest.raises(RunYielded):
        queue.record(WorkBatch(background.identity(), background, (5,)), 5, _reading(background.at(5), "clear", 1, 1000))
    assert queue.next_batch(4).run_id == visitor.identity()


def test_a_wider_precompute_takes_over_an_older_one_and_reports_its_coverage(tmp_path):
    queue = RunQueue(tmp_path)
    queue.initialize()
    one_day = _hourly_plan(START, 24)
    queue.submit(one_day, owner="precompute", background=True)
    _compute_all(queue, one_day)
    queue.complete(one_day.identity(), _period())

    two_days = _hourly_plan(START, 48)
    status = queue.submit(two_days, owner="precompute", background=True)
    # Everything carries over except the first run's closing sample, which is a published snapshot only in the wider run.
    assert status.completed_samples == one_day.interval_count
    assert queue.drop_superseded_background(two_days) == 1
    assert queue.status(one_day.identity()) is None
    # The copied snapshot files survive the older run's deletion.
    assert queue.frame(two_days.identity(), 1) is not None and queue.frame(two_days.identity(), 1)[1].is_file()

    coverage = queue.coverage({two_days.physics_key(): (-89.7668, -171.87, 500)})
    assert [(item.start_utc, item.end_utc, item.complete) for item in coverage] == [(two_days.start_utc, two_days.end_utc, False)]


def _period():
    from lunascout.jobs.metrics import integrate
    return integrate([_reading(START, "clear", 1, 1000), _reading(datetime(2026, 12, 2, tzinfo=UTC), "clear", 1, 1000)])


def test_the_default_precompute_reaches_the_end_of_next_month():
    assert _end_of_next_month(date(2026, 11, 16)) == date(2026, 12, 31)
    assert _end_of_next_month(date(2026, 12, 5)) == date(2027, 1, 31)
    assert _end_of_next_month(date(2027, 1, 31)) == date(2027, 2, 28)
