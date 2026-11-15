import type { SunlightGrid } from "../../api/types";

export const sunlightColors = {
  full: [115, 226, 190],
  partial: [255, 194, 103],
  shadow: [65, 83, 133],
  unknown: [166, 167, 181],
} as const;

export function sunlightClass(grid: SunlightGrid, index: number): keyof typeof sunlightColors | null {
  if (!grid.inside_site[index]) return null;
  const lower = grid.visible_sun_fraction_lower[index];
  const upper = grid.visible_sun_fraction_upper[index];
  if (lower === null || lower !== upper) return "unknown";
  if (lower === 0) return "shadow";
  if (lower === 1) return "full";
  return "partial";
}

export function sunlightColor(category: keyof typeof sunlightColors) {
  return `rgb(${sunlightColors[category].join(" ")})`;
}

/** Earth line of sight, in colours that cannot be mistaken for the Sun's. */
export const earthColors = {
  full: [95, 184, 255],
  partial: [167, 139, 250],
  blocked: [96, 52, 120],
  unknown: [166, 167, 181],
} as const;

/** How much of Earth's disk a point sees: all of it, part of it, none, or not known. */
export function earthClass(grid: SunlightGrid, index: number): keyof typeof earthColors | null {
  if (!grid.inside_site[index]) return null;
  const lower = grid.earth_visible_fraction_lower?.[index];
  const upper = grid.earth_visible_fraction_upper?.[index];
  if (lower === undefined || upper === undefined) return null;
  if (lower === null || lower !== upper) return "unknown";
  if (lower === 0) return "blocked";
  if (lower === 1) return "full";
  return "partial";
}

export function earthColor(category: keyof typeof earthColors) {
  return `rgb(${earthColors[category].join(" ")})`;
}
