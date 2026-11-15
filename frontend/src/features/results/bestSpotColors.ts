import type { SiteMap } from "../../api/types";
import type { BestSpotLayer } from "./mapLayers";

type Colour = readonly [number, number, number];

/** What a point is on a best-spot layer. */
export type BestSpotClass = "both" | "sun" | "earth" | "neither";

/** Colours are the same ones the rays use: yellow for the Sun, blue for Earth, green for both. */
export const bestSpotColors: Record<BestSpotClass, Colour> = {
  both: [115, 226, 190],
  sun: [255, 214, 102],
  earth: [95, 184, 255],
  neither: [58, 66, 84],
};

/** What each colour is called on a layer's legend. */
export const bestSpotNames: Record<BestSpotLayer, Partial<Record<BestSpotClass, string>>> = {
  bestSun: { sun: "Good for Sun", neither: "Not enough sunlight" },
  bestEarth: { earth: "Good for Earth contact", neither: "Not enough Earth contact" },
  bestBoth: { both: "Good for both", sun: "Sun only", earth: "Earth only", neither: "Neither" },
};

/** Whether the run's per-point results include Earth contact. */
export function hasEarthShare(map: SiteMap) {
  return map.earth_share.some((share) => share !== null);
}

/** The class of one grid point on a best-spot layer, or null outside the site or without data. */
export function bestSpotClass(map: SiteMap, index: number, layer: BestSpotLayer): BestSpotClass | null {
  if (!map.inside_site[index]) return null;

  const sunShare = map.sunlit_share[index];
  const earthShare = map.earth_share[index];
  if (sunShare === null) return null;

  const goodSun = sunShare >= map.sun_good_share;
  const goodEarth = earthShare !== null && earthShare >= map.earth_good_share;

  if (layer === "bestSun") return goodSun ? "sun" : "neither";
  if (earthShare === null) return null;
  if (layer === "bestEarth") return goodEarth ? "earth" : "neither";

  if (goodSun && goodEarth) return "both";
  if (goodSun) return "sun";
  if (goodEarth) return "earth";
  return "neither";
}
