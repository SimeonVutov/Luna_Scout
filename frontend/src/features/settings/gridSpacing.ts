import type { ChosenOptions, SimulationOptions } from "../../api/types";

/** The finest and coarsest automatic grid spacing, and the step it is rounded to, in metres. */
const FINEST_M = 5;
const COARSEST_M = 20;
const STEP_M = 5;
/** Cells across a site's radius that the automatic spacing aims for. */
const CELLS_ACROSS_RADIUS = 10;

/**
 * The grid spacing chosen for a site of radius `radiusM` when the user leaves it automatic.
 *
 * Spacing: s = clamp(σ ⌊r/(Nσ) + ½⌋, s_min, s_max)
 *   s - Grid spacing in metres; r (radiusM) - Site radius in metres.
 *   N (CELLS_ACROSS_RADIUS) - Cells wanted across the radius, so r/N is the spacing that gives them.
 *   σ (STEP_M) - Rounding step, so the spacing is a multiple of 5 m, and ⌊x + ½⌋ rounds half up.
 *   s_min, s_max (FINEST_M, COARSEST_M) - Limits: below 5 m nothing finer than the 5 m terrain
 *   exists, and a big site at 20 m already has about 2,000 points, which is what a run can afford.
 */
export function autoGridSpacing(radiusM: number) {
  const rounded = STEP_M * Math.floor(radiusM / (CELLS_ACROSS_RADIUS * STEP_M) + 0.5);
  return Math.min(COARSEST_M, Math.max(FINEST_M, rounded));
}

/** "5 m grid" for a site, or "automatic grid" when no site is at hand to say what automatic means. */
export function gridLabel(options: ChosenOptions, site?: { radius_m: number }) {
  if (options.grid_spacing_m !== null) return `${options.grid_spacing_m} m grid`;
  return site ? `${autoGridSpacing(site.radius_m)} m grid` : "automatic grid";
}

/** The settings of a request for `site`: the user's grid spacing, or the automatic one for its size. */
export function resolveOptions(options: ChosenOptions, site: { radius_m: number }): SimulationOptions {
  return { ...options, grid_spacing_m: options.grid_spacing_m ?? autoGridSpacing(site.radius_m) };
}
