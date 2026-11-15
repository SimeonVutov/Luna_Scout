import { Vector3 } from "three";

/** Radius of the lunar reference sphere used by LOLA, Moon Trek and the simulation. */
export const MOON_RADIUS_KM = 1737.4;
/** Half the width of the level-0 south-polar tile, in projected kilometres. */
export const POLAR_HALF_EXTENT_KM = 1095.93;
/** Elevation data and the polar photos reach 60°S; the rest of the Moon is a smooth sphere. */
export const CAP_LATITUDE_DEG = -60;
// Stereographic radius of a latitude: ρ = 2R·tan((90° + φ)/2), so ρ(60°S) = 2R·tan(15°).
export const CAP_RADIUS_KM = 2 * MOON_RADIUS_KM * Math.tan((90 + CAP_LATITUDE_DEG) * Math.PI / 360);
export const SUN_RADIUS_KM = 695_700;
export const EARTH_RADIUS_KM = 6371.0088;

const radians = Math.PI / 180;

/**
 * Unit direction of a south-polar stereographic point (kilometres, longitude 0 toward +y).
 *
 * Inverse stereographic: t² = (x² + y²)/(4R²); u = (y/R, x/R, t² − 1)/(1 + t²)
 *   x, y - Projected coordinates, in km; R - sphere radius, in km.
 *   u - Unit Moon-fixed direction (+Z north, +X longitude 0, +Y longitude 90°E).
 */
export function polarToUnit(xKm: number, yKm: number, out: Vector3) {
  const scale = 1 / (1 + (xKm * xKm + yKm * yKm) / (4 * MOON_RADIUS_KM * MOON_RADIUS_KM));
  return out.set(yKm / MOON_RADIUS_KM * scale, xKm / MOON_RADIUS_KM * scale, 1 - 2 * scale);
}

/**
 * South-polar stereographic coordinates (km) of a unit direction.
 *
 * Forward stereographic: x = 2R·u_y/(1 − u_z); y = 2R·u_x/(1 − u_z)
 */
export function unitToPolar(unit: Vector3): [number, number] {
  const scale = 2 * MOON_RADIUS_KM / (1 - unit.z);
  return [unit.y * scale, unit.x * scale];
}

/** Unit direction of an east-positive longitude and latitude in degrees. */
export function latLonToUnit(latitudeDeg: number, longitudeDeg: number, out: Vector3) {
  const latitude = latitudeDeg * radians;
  const longitude = longitudeDeg * radians;
  return out.set(Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude));
}

export function unitToLatLon(unit: Vector3) {
  return {
    latitude: Math.asin(Math.max(-1, Math.min(1, unit.z))) / radians,
    longitude: Math.atan2(unit.y, unit.x) / radians,
  };
}

/**
 * Unit east, north and up vectors at a site, matching the simulation's local axes:
 *   e = (−sin λ, cos λ, 0); u = (cos φ cos λ, cos φ sin λ, sin φ); n = u × e
 */
export function siteAxes(latitudeDeg: number, longitudeDeg: number) {
  const longitude = longitudeDeg * radians;
  const east = new Vector3(-Math.sin(longitude), Math.cos(longitude), 0);
  const up = latLonToUnit(latitudeDeg, longitudeDeg, new Vector3());
  const north = new Vector3().crossVectors(up, east);
  return { east, north, up };
}
