/** What the 3D view draws. Shared between the two panes of a comparison so they always match. */
export type SpaceLayers = {
  sunRays: boolean;
  earthRays: boolean;
  /** Shade the relief from the Sun's direction. */
  shading: boolean;
  /** Which of the simulation's results is drawn on the ground. */
  resultLayer: "sun" | "earth" | "none";
  /** Vertical exaggeration of the relief; 1 is true scale. */
  exaggeration: number;
};

export const defaultSpaceLayers: SpaceLayers = {
  sunRays: false, earthRays: false, shading: true, resultLayer: "sun", exaggeration: 1,
};
