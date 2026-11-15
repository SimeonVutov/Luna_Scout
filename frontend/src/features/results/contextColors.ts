import type { ContextLayer } from "./mapLayers";

type Colour = readonly [number, number, number];

const dark: Colour = [38, 44, 78];
/** Colour at the high end of each map; the low end is dark for all of them. */
const high: Record<ContextLayer, Colour> = {
  averageSunlight: [255, 214, 102],
  averageEarth: [95, 184, 255],
  permanentShadow: [196, 116, 255],
  skyOpenness: [226, 234, 242],
};

/** Colour of a value between 0 and 1: dark at 0 blending to the layer's colour at 1. */
export function contextColour(layer: ContextLayer, value: number): Colour {
  // Linear blend: c = c₀ + (c₁ − c₀)·v, per channel.
  const t = Math.max(0, Math.min(1, value));
  return [0, 1, 2].map((channel) => Math.round(dark[channel] + (high[layer][channel] - dark[channel]) * t)) as unknown as Colour;
}

export function contextCss(layer: ContextLayer, value: number) {
  return `rgb(${contextColour(layer, value).join(" ")})`;
}
