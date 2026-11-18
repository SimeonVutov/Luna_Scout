"""The public server's limits: run size, busy queue, and how fast one visitor may ask."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from lunascout.api.models import RunSpec, SiteSpec
from lunascout.api.public import PublicMode, RequestLimiter


def _spec(**changes) -> RunSpec:
    start = datetime(2026, 11, 15, tzinfo=UTC)
    values = dict(
        site=SiteSpec(name="t", latitude_deg=-89.5, longitude_deg=10, radius_m=500),
        start_utc=start, end_utc=start + timedelta(days=1),
    )
    return RunSpec(**{**values, **changes})


def test_a_public_server_refuses_oversized_runs_and_a_busy_queue_but_reuses_existing_runs():
    public = PublicMode(enabled=True)
    start = datetime(2026, 11, 15, tzinfo=UTC)

    public.check_run(_spec(), unfinished_runs=0)
    for oversized in (
        _spec(end_utc=start + timedelta(days=60)),
        _spec(grid_spacing_m=5),
    ):
        with pytest.raises(HTTPException) as refused:
            public.check_run(oversized, unfinished_runs=0)
        assert refused.value.status_code == 422

    with pytest.raises(HTTPException) as busy:
        public.check_run(_spec(), unfinished_runs=public.max_unfinished_runs)
    assert busy.value.status_code == 429

    # A run that already exists is only reused, so a full queue does not block it.
    public.check_run(_spec(), unfinished_runs=None)
    # Nothing is limited, and nothing is turned off, on a private server.
    PublicMode().check_run(_spec(end_utc=start + timedelta(days=400)), unfinished_runs=99)
    PublicMode().require_private()
    with pytest.raises(HTTPException):
        public.require_private()


def test_a_public_server_allows_fine_grids_only_for_small_sites():
    public = PublicMode(enabled=True)
    small = SiteSpec(name="t", latitude_deg=-89.5, longitude_deg=10, radius_m=50)
    big = SiteSpec(name="t", latitude_deg=-89.5, longitude_deg=10, radius_m=500)

    # The reference sites' grid (500 m at 20 m, 1,963 points) and a small site at 5 m (314) are fine.
    public.check_run(_spec(site=big, grid_spacing_m=20), unfinished_runs=0)
    public.check_run(_spec(site=small, grid_spacing_m=5), unfinished_runs=0)

    # The same fine grid on a big site is four to sixteen times the work, and below 5 m is never allowed.
    for refused in (_spec(site=big, grid_spacing_m=10), _spec(site=big, grid_spacing_m=5), _spec(site=small, grid_spacing_m=2)):
        with pytest.raises(HTTPException) as error:
            public.check_run(refused, unfinished_runs=0)
        assert error.value.status_code == 422


def test_the_limiter_counts_each_visitor_and_route_separately_and_forgets_after_a_minute():
    limiter = RequestLimiter({"POST /api/runs": 2}, window_s=60)

    assert limiter.allow("a", "POST /api/runs", now=0)
    assert limiter.allow("a", "POST /api/runs", now=1)
    assert not limiter.allow("a", "POST /api/runs", now=2)
    assert limiter.allow("b", "POST /api/runs", now=2)
    assert limiter.allow("a", "GET /api/runs", now=2)
    assert limiter.allow("a", "POST /api/runs", now=62)


def test_every_server_refuses_a_site_larger_than_the_maximum_radius():
    SiteSpec(name="t", latitude_deg=-89.5, longitude_deg=10, radius_m=500)
    with pytest.raises(ValidationError):
        SiteSpec(name="t", latitude_deg=-89.5, longitude_deg=10, radius_m=501)
