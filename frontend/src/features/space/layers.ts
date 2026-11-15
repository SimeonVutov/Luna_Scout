import type { MapLayer } from "../results/mapLayers";

/** What the 3D view draws. Shared between the two panes of a comparison so they always match. */
export type SpaceLayers = {
  sunRays: boolean;
  earthRays: boolean;
  /** Shade the relief from the Sun's direction. */
  shading: boolean;
  /** What is drawn on the ground: a simulation result or one of NASA's long-term maps. */
  resultLayer: MapLayer;
  /** Vertical exaggeration of the relief; 1 is true scale. */
  exaggeration: number;
};

export const defaultSpaceLayers: SpaceLayers = {
  sunRays: false, earthRays: false, shading: true, resultLayer: "sunlight", exaggeration: 1,
};
