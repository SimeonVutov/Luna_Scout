import logging
import os
from threading import Thread
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware

from ..jobs.plan import MissingScienceInputs, science_sources
from ..jobs.scheduler import RunQueue
from . import site_store
from .models import Site, SiteSpec
from .public import PublicMode, RateLimitMiddleware, default_limiter
from .context import context_router
from .ice import ice_router
from .science import science_router
from .site_map import site_map_router
from .space import space_router


def create_app(data_dir: Path | None = None) -> FastAPI:
    catalog_path = data_dir or Path(
        os.environ.get("LUNASCOUT_DATA_DIR", site_store.DEFAULT_DATA_DIR)
    )
    queue = RunQueue(catalog_path)
    public = PublicMode.from_environment()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        site_store.initialize(catalog_path)
        queue.initialize()
        # Checksum the input files now, in the background, so the first submitted simulation
        # does not wait for it. Missing inputs are reported when a run is submitted.
        Thread(target=_warm_checksums, args=(catalog_path,), daemon=True).start()
        yield

    app = FastAPI(title="LunaScout API", version="0.1.0", lifespan=lifespan)
    # Snapshots and ray sets are large JSON arrays that compress to a fraction of their size.
    app.add_middleware(GZipMiddleware, minimum_size=2000)
    if public.enabled:
        app.add_middleware(RateLimitMiddleware, limiter=default_limiter())
    app.include_router(science_router(catalog_path, queue, public))
    app.include_router(context_router(catalog_path))
    app.include_router(ice_router(catalog_path))
    app.include_router(site_map_router(queue))
    app.include_router(space_router(catalog_path, queue))

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "simulation": "queue_ready"}

    @app.get("/api/sites")
    def sites() -> list[Site]:
        public.require_private()
        return site_store.list_sites(catalog_path)

    @app.post("/api/sites", status_code=201)
    def create_site(site: SiteSpec) -> Site:
        public.require_private()
        return site_store.add_site(catalog_path, site)

    @app.put("/api/sites/{site_id}")
    def edit_site(site_id: str, site: SiteSpec) -> Site:
        public.require_private()
        updated = site_store.update_site(catalog_path, site_id, site)
        if updated is None:
            raise HTTPException(404, "Site not found")
        return updated

    @app.delete("/api/sites/{site_id}", status_code=204)
    def remove_site(site_id: str) -> None:
        public.require_private()
        if not site_store.delete_site(catalog_path, site_id):
            raise HTTPException(404, "Site not found")

    return app


def _warm_checksums(data_dir: Path) -> None:
    try:
        science_sources(data_dir)
    except (MissingScienceInputs, OSError):
        logging.getLogger(__name__).info("Input checksums not prepared; the data is incomplete.")


app = create_app()

