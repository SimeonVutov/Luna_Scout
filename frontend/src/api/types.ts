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

export type Receiver = "vertical_tracking" | "terrain" | "horizontal";
export type RayMethod = "horizon" | "direct";

export type SimulationOptions = {
  grid_spacing_m: number;
  solar_disk_samples: number;
  integration_minutes: number;
  mast_height_m: number;
  collector_height_m: number;
  receiver: Receiver;
  ray_method: RayMethod;
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
  earth_disk_visible_fraction?: Bounds | null;
  summary: {
    sample_count: number;
    ground_sample_count: number;
    ground_covered_area_fraction: number;
    sun_resolved_area_fraction: number;
    lit_area_fraction: Bounds;
    mean_visible_sun_fraction: Bounds;
    mean_irradiance_on_known_ground_w_m2: Bounds | null;
    half_disk_lit_area_fraction?: Bounds | null;
    usable_area_fraction?: Bounds | null;
    /** Share of the site with at least half of Earth's disk in line of sight from mast height. */
    earth_visible_area_fraction?: Bounds | null;
  };
};

export type PeriodMetrics = {
  sunlit_hours: Bounds;
  half_disk_sunlit_hours?: Bounds | null;
  incident_energy_kwh_m2: Bounds | null;
  earth_visible_hours: Bounds;
  earth_resolved_hours: number;
};

export type VisibilityWindow = { start_utc: string; end_utc: string; visibility: Visibility };

export type LongestWindow = {
  start_utc: string;
  end_utc: string;
  hours: number;
  /** The window touches the start or end of the run, so the real one may be longer. */
  truncated: boolean;
};

export type PeriodSummary = PeriodMetrics & {
  days: (PeriodMetrics & { date_utc: string })[];
  earth_windows: VisibilityWindow[];
  sun_windows?: VisibilityWindow[] | null;
  longest_darkness?: LongestWindow | null;
  longest_earth_blackout?: LongestWindow | null;
  /** Longest unbroken sunlight at the centre, and longest unbroken Earth visibility. */
  longest_daylight?: LongestWindow | null;
  longest_earth_contact?: LongestWindow | null;
};

export type RunStatus = {
  run_id: string;
  stage: "queued" | "running" | "complete" | "failed";
  revision: number;
  plan: TimeRange & {
    integration_minutes: number;
    site: Coordinate & { radius_m: number };
    settings?: { receiver: Receiver | "fixed"; collector_height_m: number; mast_height_m: number; grid_spacing_m: number };
  };
  ready_indices: number[];
  ready_times_utc: string[];
  completed_samples: number;
  total_samples: number;
  total_frames: number;
  period: PeriodSummary | null;
  message: string | null;
  submitted_utc?: string | null;
};

export type WorkerStatus = {
  running: boolean;
  pid: number | null;
  /** What the worker is doing right now, such as "Computing snapshots". */
  activity: string | null;
  run_id: string | null;
};

export type RunList = { worker: WorkerStatus; runs: RunStatus[] };

export type SunlightGrid = {
  offsets_m: number[];
  inside_site: boolean[];
  visible_sun_fraction_lower: (number | null)[];
  visible_sun_fraction_upper: (number | null)[];
  irradiance_lower_w_m2: (number | null)[];
  irradiance_upper_w_m2: (number | null)[];
  /** Fraction of Earth's disk in line of sight from mast height; absent from older results. */
  earth_visible_fraction_lower?: (number | null)[] | null;
  earth_visible_fraction_upper?: (number | null)[] | null;
};

export type FramePayload = { reading: Reading; grid: SunlightGrid };

/** Moon-fixed Cartesian components: +Z north, +X longitude 0, +Y longitude 90°E. */
export type Vector = [number, number, number];

/** Moon-centred Sun and Earth positions at one time, in metres. */
export type SkySample = { at_utc: string; sun_m: Vector; earth_m: Vector };
export type SkyBatch = { first_index: number; frame: string; samples: SkySample[] };

/** The simulation's rays from one instrument toward a body's disk. Lists share the ray order. */
export type RayFan = {
  origin_m: Vector;
  body_m: Vector;
  directions: Vector[];
  statuses: Visibility[];
  /** Distance to the terrain that blocks the ray; null when clear or not resolved. */
  hit_distances_m: (number | null)[];
  visible_fraction: Bounds;
};

/** Rays from a subset of a site's points, as saved with a simulation snapshot. */
export type RunRays = { at_utc: string; sun_points: RayFan[]; earth_points: RayFan[] };

/** The Sun's disk seen from the collector and Earth's disk seen from the mast, at the site centre. */
export type SiteRays = {
  at_utc: string;
  sun: RayFan;
  earth: RayFan;
  /** Sun fans from a subset of the site's reporting points; empty unless the whole site was asked for. */
  sun_points: RayFan[];
  /** Earth fans from the same points at mast height; empty unless the whole site was asked for. */
  earth_points: RayFan[];
};

export type TerrainSummary = {
  known_area_fraction: number;
  /** Share of the site's area by terrain posting in metres, such as { "5": 1 }. */
  detail_area_fractions: Record<string, number>;
  centre_detail_m: number | null;
  centre_height_m: number | null;
  height_min_m: number | null;
  height_max_m: number | null;
  slope_mean_deg: number | null;
  slope_p95_deg: number | null;
  slope_max_deg: number | null;
  /** Share of the site at or below each slope limit in degrees, such as { "10": 0.82 }. */
  gentle_area_fractions: Record<string, number>;
  slope_baseline_m: number;
};

export type SlopeGrid = {
  offsets_m: number[];
  inside_site: boolean[];
  slope_deg: (number | null)[];
};

export type SiteInsight = {
  summary: TerrainSummary;
  slope_grid: SlopeGrid;
  skyline_azimuth_step_deg: number;
  collector_height_m: number;
  mast_height_m: number;
  /** Terrain horizon elevation above the level plane per azimuth bin, clockwise from north. */
  collector_skyline_deg: (number | null)[] | null;
  mast_skyline_deg: (number | null)[] | null;
};
