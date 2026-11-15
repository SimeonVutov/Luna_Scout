export type Coordinate = {
  latitude_deg: number;
  longitude_deg: number;
};

export type SiteSpec = Coordinate & { name: string; radius_m: number };
export type Site = SiteSpec & { id: string };

export type TimeRange = {
  start_utc: string;
  end_utc: string;
  snapshot_minutes: number;
};

export type SimulationOptions = {
  grid_spacing_m: number;
  solar_disk_samples: number;
  integration_minutes: number;
  mast_height_m: number;
};

export type RunRequest = TimeRange & SimulationOptions & {
  site: SiteSpec;
  priority_utc: string;
};

export type Bounds = { lower: number; upper: number };
export type Visibility = "clear" | "blocked" | "unknown";
export type BodyView = {
  azimuth_deg: number | null;
  elevation_deg: number;
  distance_m: number;
  angular_radius_deg: number;
};

export type Reading = {
  at_utc: string;
  center_ground_height_m: number | null;
  sun_at_collector: BodyView | null;
  earth_at_mast: BodyView | null;
  earth_center_visibility: Visibility;
  summary: {
    sample_count: number;
    ground_sample_count: number;
    ground_covered_area_fraction: number;
    sun_resolved_area_fraction: number;
    lit_area_fraction: Bounds;
    mean_visible_sun_fraction: Bounds;
    mean_irradiance_on_known_ground_w_m2: Bounds | null;
    half_disk_lit_area_fraction?: Bounds | null;
  };
};

export type PeriodMetrics = {
  sunlit_hours: Bounds;
  half_disk_sunlit_hours?: Bounds | null;
  incident_energy_kwh_m2: Bounds | null;
  earth_visible_hours: Bounds;
  earth_resolved_hours: number;
};

export type PeriodSummary = PeriodMetrics & {
  days: (PeriodMetrics & { date_utc: string })[];
  earth_windows: { start_utc: string; end_utc: string; visibility: Visibility }[];
};

export type RunStatus = {
  run_id: string;
  stage: "queued" | "running" | "complete" | "failed";
  revision: number;
  plan: TimeRange & { integration_minutes: number };
  ready_indices: number[];
  ready_times_utc: string[];
  completed_samples: number;
  total_samples: number;
  total_frames: number;
  period: PeriodSummary | null;
  message: string | null;
};

export type SunlightGrid = {
  offsets_m: number[];
  inside_site: boolean[];
  visible_sun_fraction_lower: (number | null)[];
  visible_sun_fraction_upper: (number | null)[];
  irradiance_lower_w_m2: (number | null)[];
  irradiance_upper_w_m2: (number | null)[];
};

export type FramePayload = { reading: Reading; grid: SunlightGrid };

export type TerrainPreview = {
  offsets_m: number[];
  heights_m: (number | null)[];
  center_height_m: number | null;
  sources: string[];
  dem_spacings_m: number[];
};
