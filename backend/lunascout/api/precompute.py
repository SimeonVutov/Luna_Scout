"""Precomputing NASA's reference sites while the server is idle, and reporting how far they are ready.

Precomputed runs use the website's default settings and a 500 m radius. A visitor who adds a
reference site and keeps the defaults has their run filled from these samples straight away;
only dates outside the precomputed range are computed for them. Smaller radii at the same centre
reuse the saved horizon maps, so they compute quickly as well.
"""

from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from fastapi import APIRouter

from ..jobs.plan import RunPlan
from ..jobs.scheduler import Coverage, RunQueue
from ..reference_sites import (
    DEFAULT_OPTIONS,
    DEFAULT_SNAPSHOT_MINUTES,
    PRECOMPUTE_OWNER,
    REFERENCE_RADIUS_M,
    REFERENCE_SITES,
    ReferenceSite,
)
from .models import RunSpec, SiteSpec
from .science import plan_for_request


def reference_plan(data_dir: Path, site: ReferenceSite, first_day: date, last_day: date) -> RunPlan:
    """The plan a browser would create for this reference site, these whole UTC days and the defaults."""
    start = datetime(first_day.year, first_day.month, first_day.day, tzinfo=UTC)
    end = datetime(last_day.year, last_day.month, last_day.day, tzinfo=UTC) + timedelta(days=1)
    spec = RunSpec(
        site=SiteSpec(name=site.name, latitude_deg=site.latitude_deg, longitude_deg=site.longitude_deg, radius_m=REFERENCE_RADIUS_M),
        start_utc=start,
        end_utc=end,
        snapshot_minutes=DEFAULT_SNAPSHOT_MINUTES,
        **DEFAULT_OPTIONS,
    )
    return plan_for_request(data_dir, spec)


def precompute_reference_sites(data_dir: Path, queue: RunQueue, first_day: date, last_day: date) -> list[str]:
    """Queue every reference site for these days as background work; returns one line per site.

    Only the samples no earlier run has computed are left for the worker. Older precomputed runs
    inside the new range are deleted, since their samples were just copied.
    """
    report = []
    for site in REFERENCE_SITES:
        plan = reference_plan(data_dir, site, first_day, last_day)
        status = queue.submit(plan, owner=PRECOMPUTE_OWNER, background=True)
        dropped = queue.drop_superseded_background(plan)
        report.append(
            f"{site.name}: {status.completed_samples} of {status.total_samples} samples ready"
            + (f", replaced {dropped} older run(s)" if dropped else "")
        )
    return report


def precompute_router(data_dir: Path, queue: RunQueue) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/precomputed")
    def precomputed() -> list[Coverage]:
        """For each reference site, the newest precomputed date range with the default settings."""
        # Physics keys exclude the dates, so any day identifies a site's precomputed runs.
        any_day = date(2026, 1, 1)
        keys = {
            reference_plan(data_dir, site, any_day, any_day).physics_key(): (
                site.latitude_deg, site.longitude_deg, REFERENCE_RADIUS_M,
            )
            for site in REFERENCE_SITES
        }
        newest: dict[tuple[float, float], Coverage] = {}
        for coverage in queue.coverage(keys):
            newest.setdefault((coverage.latitude_deg, coverage.longitude_deg), coverage)
        return list(newest.values())

    return router
