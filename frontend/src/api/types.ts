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
