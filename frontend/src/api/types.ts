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
  /** The browser's own ID, so a public server knows who may pause or cancel the run. */
  session?: string;
};

/** The dates the server precomputed for a reference site, with the default settings. */
export type Coverage = {
  latitude_deg: number;
  longitude_deg: number;
  radius_m: number;
  start_utc: string;
  /** Start of the day after the last day covered. */
  end_utc: string;
  complete: boolean;
};

/** What the server already has for a request, without starting anything. */
export type RunLookup = {
  run: RunStatus | null;
  /** Samples that earlier runs of the same site and settings computed for this range. */
  reusable_samples: number;
  total_samples: number;
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

export type StageKey = "preparing" | "horizons" | "snapshots" | "windows";

/** One stage of a run, as the server estimates it. */
export type StageProgress = {
  key: StageKey;
  state: "pending" | "active" | "done" | "skipped";
  /** Estimated seconds for the whole stage, and the share of it done. */
  seconds: number;
  fraction: number;
  done_units?: number | null;
  total_units?: number | null;
  /** Samples earlier runs had already computed. */
  reused_units?: number | null;
};

export type RunProgress = {
  stages: StageProgress[];
  /** Seconds until the run should finish, including time shared with other visitors' runs. */
  remaining_s: number;
  /** How the times were estimated: timed on this server, scaled from another size, or typical. */
  basis: "measured" | "scaled" | "typical";
  sharing_with: number;
  waiting: boolean;
};

export type RunStatus = {
  run_id: string;
  stage: "queued" | "running" | "paused" | "complete" | "failed";
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
  /** Stages and time left while waiting, running or paused. */
  progress?: RunProgress | null;
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

/** A per-point duration summarised over a site, in hours. */
export type SiteExtremes = {
  typical_hours: number;
  best_hours: number;
  worst_hours: number;
  /** More than half the site's area has this duration cut off by the edge of the period. */
  truncated: boolean;
};

/**
 * How every point of a site fared over a whole finished run: its longest day and night and how
 * much of the time it saw the Sun and Earth. Grids are row-major, north increasing by row.
 */
export type SiteMap = {
  offsets_m: number[];
  inside_site: boolean[];
  sunlit_share: (number | null)[];
  /** Null throughout for results saved before Earth line of sight per point existed. */
  earth_share: (number | null)[];
  longest_day_hours: (number | null)[];
  longest_dark_hours: (number | null)[];
  period_hours: number;
  /** A point is a good spot for Sun when lit at least this share of the period; likewise for Earth. */
  sun_good_share: number;
  earth_good_share: number;
  summary: {
    longest_day: SiteExtremes;
    longest_dark: SiteExtremes;
    area_good_for_sun: number;
    area_good_for_earth: number | null;
    area_good_for_both: number | null;
  };
};

/** NASA's long-term maps over a site, as fractions between 0 and 1, plus site-wide means. */
export type SiteContext = {
  offsets_m: number[];
  inside_site: boolean[];
  average_sunlight: (number | null)[];
  average_earth: (number | null)[];
  permanent_shadow: (number | null)[];
  sky_openness: (number | null)[];
  summary: {
    average_sunlight: number | null;
    average_earth: number | null;
    /** Share of the site that never sees the Sun. */
    permanent_shadow_share: number | null;
    sky_openness: number | null;
    posting_m: Record<string, number | null>;
  };
};

/** Diviner's modelled temperatures and ice-stability depth over a site. Model results, not detected ice. */
export type SiteIceSummary = {
  triangle_count: number;
  resolution_m: number;
  /** The site is smaller than one model cell, so the nearest cell stands for it. */
  nearest_triangle_only: boolean;
  /** Annual average temperature at 2 cm depth, in kelvin. */
  mean_temperature_k: number | null;
  /** Annual maximum surface temperature, in kelvin. */
  max_temperature_k: number | null;
  coldest_max_temperature_k: number | null;
  /** Share of the site where ice is stable somewhere within the model's 2.9 m reach. */
  stable_ice_share: number;
  surface_ice_share: number;
  /** Depth in metres; 0 means at the surface. Null when no ice is stable. */
  shallowest_ice_depth_m: number | null;
  mean_buried_ice_depth_m: number | null;
};

export type SiteIce = { summary: SiteIceSummary | null };

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
