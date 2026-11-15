from pydantic import AwareDatetime, BaseModel, Field, model_validator

from ..simulation.engine import RayMethod, Receiver


class SiteSpec(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    latitude_deg: float = Field(ge=-90, le=90)
    longitude_deg: float = Field(ge=-180, le=180)
    radius_m: int = Field(gt=0)


class Site(SiteSpec):
    id: str


class RunSpec(BaseModel):
    site_id: str | None = None
    site: SiteSpec | None = None
    start_utc: AwareDatetime
    end_utc: AwareDatetime
    snapshot_minutes: int = Field(default=60, gt=0, le=1440)
    integration_minutes: int | None = Field(default=None, gt=0)
    priority_utc: AwareDatetime | None = None
    grid_spacing_m: float = Field(default=20, gt=0)
    solar_disk_samples: int = Field(default=37, gt=0)
    mast_height_m: float = Field(default=2, ge=0)
    collector_height_m: float = Field(default=2, ge=0)
    receiver: Receiver = "vertical_tracking"
    collector_tilt_deg: float | None = Field(default=None, ge=0, le=90)
    collector_azimuth_deg: float = Field(default=0, ge=0, lt=360)
    ray_method: RayMethod = "horizon"

    @model_validator(mode="after")
    def check_request(self) -> "RunSpec":
        if (self.site_id is None) == (self.site is None):
            raise ValueError("Provide either a saved site ID or a site footprint.")
        if self.end_utc <= self.start_utc:
            raise ValueError("end_utc must be after start_utc")
        return self


class RunPriority(BaseModel):
    run_ids: list[str] = Field(min_length=1, max_length=50)
    at_utc: AwareDatetime
