"""Protections for a server open to the internet, switched on with LUNASCOUT_PUBLIC_MODE=1.

Anyone who can reach the server can ask it to compute, so a public server limits how large a run
can be, how many can wait, and how fast one visitor can ask for the heavy routes. It also turns off
the routes that change data shared by every visitor: the server-side site catalogue, and deleting
saved results. Visitors keep their own site list in their browser.
"""

import os
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import timedelta

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from .models import RunSpec

# Heavy routes and how many requests one visitor may make to each per minute.
_RATE_LIMITS_PER_MINUTE = {
    "POST /api/runs": 6,
    "POST /api/terrain/rays": 20,
    "POST /api/terrain/insight": 12,
    "POST /api/terrain/context": 30,
    "POST /api/terrain/ice": 60,
    "POST /api/runs/lookup": 120,
}


@dataclass(frozen=True)
class PublicMode:
    """Limits for a public server. With `enabled` False nothing is limited."""

    enabled: bool = False
    # A bit more than one lunar day (29.5 days), so a full day and night can be compared.
    max_range: timedelta = timedelta(days=35)
    min_grid_spacing_m: float = 20.0
    max_solar_disk_samples: int = 61
    # Runs waiting or running at once. The single worker handles them one after another.
    max_unfinished_runs: int = 6

    @classmethod
    def from_environment(cls) -> "PublicMode":
        return cls(enabled=os.environ.get("LUNASCOUT_PUBLIC_MODE") == "1")

    def require_private(self) -> None:
        """Refuse a route that changes data shared by every visitor."""
        if self.enabled:
            raise HTTPException(403, "This is turned off on the public server.")

    def check_run(self, spec: RunSpec, unfinished_runs: int | None) -> None:
        """Refuse a run that is too large. `unfinished_runs` is None when the run already exists."""
        if not self.enabled:
            return

        if spec.site is None:
            raise HTTPException(422, "The public server needs the site's position with the request.")
        if spec.end_utc - spec.start_utc > self.max_range:
            raise HTTPException(422, f"The public server allows at most {self.max_range.days} days per run.")
        if spec.grid_spacing_m < self.min_grid_spacing_m:
            raise HTTPException(422, f"The public server needs a grid spacing of at least {self.min_grid_spacing_m:g} m.")
        if spec.solar_disk_samples > self.max_solar_disk_samples:
            raise HTTPException(422, f"The public server allows at most {self.max_solar_disk_samples} Sun disk samples.")

        # A run that already exists is only reused, which costs nothing, so it is never refused.
        if unfinished_runs is not None and unfinished_runs >= self.max_unfinished_runs:
            raise HTTPException(429, "The server is busy with other simulations. Try again in a few minutes.")


class RequestLimiter:
    """Counts a visitor's recent requests to each heavy route, in memory."""

    def __init__(self, limits: dict[str, int], window_s: float = 60.0) -> None:
        self._limits = limits
        self._window_s = window_s
        self._recent: dict[tuple[str, str], deque[float]] = defaultdict(deque)

    def allow(self, visitor: str, route: str, now: float | None = None) -> bool:
        """Whether `visitor` may make another request to `route`; counts it when allowed."""
        limit = self._limits.get(route)
        if limit is None:
            return True

        moment = time.monotonic() if now is None else now
        times = self._recent[(visitor, route)]
        while times and moment - times[0] > self._window_s:
            times.popleft()

        if len(times) >= limit:
            return False
        times.append(moment)
        return True


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Answers 429 to a visitor who asks for a heavy route too often."""

    def __init__(self, app, limiter: RequestLimiter) -> None:
        super().__init__(app)
        self._limiter = limiter

    async def dispatch(self, request: Request, call_next):
        visitor = request.client.host if request.client else "unknown"
        route = f"{request.method} {request.url.path}"

        if not self._limiter.allow(visitor, route):
            return JSONResponse({"detail": "Too many requests. Wait a minute and try again."}, status_code=429)
        return await call_next(request)


def default_limiter() -> RequestLimiter:
    return RequestLimiter(_RATE_LIMITS_PER_MINUTE)
