import type { SiteIceSummary } from "../../api/types";
import { decimal, wholePercent } from "./format";

/** The deepest ice the model reaches, in metres. */
export const MODEL_DEPTH_M = 2.9;

export const kelvin = (value: number | null) => value === null ? "—" : `${decimal.format(value)} K`;

/** A depth in centimetres below a metre, in metres above, and "at the surface" for zero. */
export function depthLabel(metres: number | null) {
  if (metres === null) return "—";
  if (metres === 0) return "At the surface";
  return metres < 1 ? `${decimal.format(metres * 100)} cm` : `${decimal.format(metres)} m`;
}

/** How deep the shallowest ice is, or that there is none within the model's reach. */
export function shallowestIceLabel(ice: SiteIceSummary) {
  return ice.shallowest_ice_depth_m === null ? `None within ${MODEL_DEPTH_M} m` : depthLabel(ice.shallowest_ice_depth_m);
}

export const share = (value: number) => wholePercent.format(value);
