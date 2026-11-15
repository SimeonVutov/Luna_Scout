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
