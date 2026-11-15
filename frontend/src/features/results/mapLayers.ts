/** What can be drawn on the ground of a site, in the flat map and in the 3D view. */
export type MapLayer =
  | "none" | "sunlight" | "earth" | "slope"
  | "averageSunlight" | "averageEarth" | "permanentShadow" | "skyOpenness";

/** Layers that come from NASA's long-term maps rather than from the simulation. */
export const contextLayers = ["averageSunlight", "averageEarth", "permanentShadow", "skyOpenness"] as const;
export type ContextLayer = (typeof contextLayers)[number];

export function isContextLayer(layer: MapLayer): layer is ContextLayer {
  return (contextLayers as readonly string[]).includes(layer);
}

export const layerLabel: Record<MapLayer, string> = {
  none: "No layer",
  sunlight: "Solar visibility",
  earth: "Earth radio coverage",
  slope: "Slope",
  averageSunlight: "Average sunlight",
  averageEarth: "Average Earth visibility",
  permanentShadow: "Permanent shadow",
  skyOpenness: "Open sky",
};

/** One sentence on what each layer means, shown under the picker. */
export const layerHelp: Partial<Record<MapLayer, string>> = {
  sunlight: "How much of the Sun each point sees at the time on the timeline.",
  earth: "How much of Earth each point sees from mast height at the timeline's time. Line of sight only, not signal strength.",
  slope: "Steepness of the ground. Gentle ground is easier to land on.",
  averageSunlight: "Share of time each point is lit, averaged over 18.6 years (NASA LOLA).",
  averageEarth: "Share of time Earth is in view, averaged over 18.6 years (NASA LOLA).",
  permanentShadow: "Ground that never sees the Sun. Cold enough to hold ice (NASA LOLA).",
  skyOpenness: "How much of the sky the terrain leaves open. Low means deep in a pit (NASA LOLA).",
};

/** Why a layer cannot be chosen right now, or nothing when it can. */
export type LayerAvailability = Partial<Record<MapLayer, string>>;

/**
 * Layers that need something that is not there yet, each with the reason. They stay in the
 * menu, greyed out, so it is clear they exist and what is missing.
 */
export function layerAvailability(has: { sunlight: boolean; earth: boolean; slope: boolean; context: boolean; slopeSupported: boolean }): LayerAvailability {
  const unavailable: LayerAvailability = {};
  if (!has.sunlight) unavailable.sunlight = "Run the simulation first";
  if (!has.earth) unavailable.earth = has.sunlight ? "Run the simulation again: this result was made before Earth coverage existed" : "Run the simulation first";
  if (!has.context) unavailable.averageSunlight = unavailable.averageEarth = unavailable.permanentShadow = unavailable.skyOpenness = "NASA maps not available for this site";
  if (!has.slopeSupported) unavailable.slope = "Only on the flat map";
  else if (!has.slope) unavailable.slope = "Loading the terrain";
  return unavailable;
}

/** Every layer in menu order. */
export const allLayers: MapLayer[] = [
  "none", "sunlight", "earth", "averageSunlight", "averageEarth", "permanentShadow", "skyOpenness", "slope",
];
