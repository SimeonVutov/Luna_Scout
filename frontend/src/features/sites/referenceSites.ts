import type { SiteSpec } from "../../api/types";

// NASA Lunar Surface Data Book, ACD-50044 Rev A, Table A2-2.
export const maximumSiteRadius = 1_000_000;
export const referenceSites: SiteSpec[] = [
  { name: "Connecting Ridge", latitude_deg: -89.4632, longitude_deg: -137.49, radius_m: 500 },
  { name: "Shackleton Rim", latitude_deg: -89.7668, longitude_deg: -171.87, radius_m: 500 },
];

export function coordinatesLabel(latitude: number, longitude: number) {
  return `${Math.abs(latitude).toFixed(4)}° ${latitude < 0 ? "S" : "N"}, ${Math.abs(longitude).toFixed(4)}° ${longitude < 0 ? "W" : "E"}`;
}
