"""Diviner's modelled temperatures and ice-stability depth for one site."""

from math import cos, radians, sin
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..terrain.context_maps import polar_xy_m
from ..terrain.diviner import COMPACT_NAME, IceSummary, load_table, summarize_site_ice
from .models import SiteSpec


class SiteIce(BaseModel):
    """The summary is null when the site lies outside the table, which reaches 80°S around the pole."""

    summary: IceSummary | None


def ice_router(data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.post("/terrain/ice")
    def site_ice(spec: SiteSpec) -> SiteIce:
        """Modelled temperature and ice-stability numbers for the triangles inside a site.

        The summary is null when the site lies outside the table.
        """
        table = load_table(data_dir / "raw" / "context" / COMPACT_NAME)
        if table is None:
            raise HTTPException(503, "Download the NASA maps with lunascout-science fetch-data.")

        # Unit direction of the site's centre: u = (cos φ cos λ, cos φ sin λ, sin φ)
        #   φ, λ - The site's latitude and east longitude.
        latitude, longitude = radians(spec.latitude_deg), radians(spec.longitude_deg)
        direction = np.array([cos(latitude) * cos(longitude), cos(latitude) * sin(longitude), sin(latitude)])
        if direction[2] >= 0:
            return SiteIce(summary=None)

        x_m, y_m = polar_xy_m(direction)
        return SiteIce(summary=summarize_site_ice(table, float(x_m), float(y_m), float(spec.radius_m)))

    return router
