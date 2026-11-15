import { MultiLineString } from "ol/geom";
import { circular } from "ol/geom/Polygon";
import type { SiteSpec } from "../../api/types";
import { geographic, polar } from "./polarImagery";

/** Draw a lunar geodesic footprint without drawing a line across the longitude seam. */
export function siteFootprint(site: SiteSpec, southPolar: boolean) {
  // Spherical small circle: θ = r/R.
  // θ - Angular radius in radians; r - Site radius in metres; R - Lunar radius in metres.
  const circle = circular([site.longitude_deg, site.latitude_deg], site.radius_m, 128, 1_737_400);
  if (southPolar) return circle.transform(geographic, polar);

  const ring = circle.getCoordinates()[0];
  const segments: number[][][] = [[ring[0]]];
  for (let index = 1; index < ring.length; index++) {
    const previous = ring[index - 1];
    const next = ring[index];
    if (Math.abs(next[0] - previous[0]) <= 180) {
      segments.at(-1)!.push(next);
      continue;
    }

    // Linear display clipping: φ_edge = φ₀ + f(φ₁ − φ₀); f = (λ_edge − λ₀)/(λ₁ − λ₀).
    // φ - Latitude in degrees; λ - Unwrapped longitude in degrees; f - Dimensionless fraction.
    // This clips a sampled display segment; it does not change the scientific footprint.
    const boundary = previous[0] > 0 ? 180 : -180;
    const unwrappedLongitude = next[0] + (previous[0] > 0 ? 360 : -360);
    const fraction = (boundary - previous[0]) / (unwrappedLongitude - previous[0]);
    const latitude = previous[1] + fraction * (next[1] - previous[1]);
    segments.at(-1)!.push([boundary, latitude]);
    segments.push([[-boundary, latitude], next]);
  }
  return new MultiLineString(segments);
}
