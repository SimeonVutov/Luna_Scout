import { register } from "ol/proj/proj4";
import Static from "ol/source/ImageStatic";
import proj4 from "proj4";
import type { Site, SiteContext, SlopeGrid, SunlightGrid } from "../../api/types";
import { contextColour } from "../results/contextColors";
import type { ContextLayer } from "../results/mapLayers";
import { slopeClass } from "../results/slopeColors";
import { earthClass, earthColors, sunlightClass, sunlightColors } from "../results/sunlightColors";

export const MOON_RADIUS_M = 1_737_400;

type Paint = (index: number) => readonly [number, number, number, number] | null;

export function sunlightOverlay(site: Site, grid: SunlightGrid) {
  return gridOverlay(site, grid.offsets_m, (index) => {
    const category = sunlightClass(grid, index);
    if (!category) return null;
    const [red, green, blue] = sunlightColors[category];
    return [red, green, blue, category === "shadow" ? 126 : 149];
  });
}

/** Earth line of sight from mast height, as map overlay. */
export function earthOverlay(site: Site, grid: SunlightGrid) {
  return gridOverlay(site, grid.offsets_m, earthPaint(grid, 149));
}

function earthPaint(grid: SunlightGrid, alpha: number): Paint {
  return (index) => {
    const category = earthClass(grid, index);
    if (!category) return null;
    const [red, green, blue] = earthColors[category];
    return [red, green, blue, alpha];
  };
}

const contextValues: Record<ContextLayer, (context: SiteContext) => (number | null)[]> = {
  averageSunlight: (context) => context.average_sunlight,
  averageEarth: (context) => context.average_earth,
  permanentShadow: (context) => context.permanent_shadow,
  skyOpenness: (context) => context.sky_openness,
};

function contextPaint(context: SiteContext, layer: ContextLayer, alpha: number): Paint {
  const values = contextValues[layer](context);
  return (index) => {
    const value = values[index];
    if (!context.inside_site[index] || value === null) return null;
    return [...contextColour(layer, value), alpha] as const;
  };
}

/** One of NASA's long-term maps as a map overlay. */
export function contextOverlay(site: Site, context: SiteContext, layer: ContextLayer) {
  return gridOverlay(site, context.offsets_m, contextPaint(context, layer, 165));
}

/** One of NASA's long-term maps as a picture for the 3D terrain. */
export function contextCanvas(site: Site, context: SiteContext, layer: ContextLayer) {
  return gridCanvas(site, context.offsets_m, contextPaint(context, layer, 255));
}

export function slopeOverlay(site: Site, grid: SlopeGrid) {
  return gridOverlay(site, grid.offsets_m, (index) => {
    const slope = grid.slope_deg[index];
    if (!grid.inside_site[index] || slope === null) return null;
    const [red, green, blue] = slopeClass(slope).color;
    return [red, green, blue, 165];
  });
}

/** The simulation's sunlight grid as a picture, for drawing on the 3D terrain. */
export function sunlightCanvas(site: Site, grid: SunlightGrid) {
  return gridCanvas(site, grid.offsets_m, (index) => {
    const category = sunlightClass(grid, index);
    if (!category) return null;
    const [red, green, blue] = sunlightColors[category];
    return [red, green, blue, 255];
  });
}

/** Earth line of sight as a picture for the 3D terrain, like `sunlightCanvas`. */
export function earthCanvas(site: Site, grid: SunlightGrid) {
  return gridCanvas(site, grid.offsets_m, earthPaint(grid, 255));
}

/**
 * Paint one image pixel per reporting point, clipped to the site circle, with north at the top.
 * `halfWidthM` is the distance from the site centre to the picture's edge.
 */
function gridCanvas(site: Site, offsets: number[], paint: Paint) {
  const size = offsets.length;
  const spacing = size > 1 ? offsets[1] - offsets[0] : 2 * site.radius_m;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const image = context.createImageData(size, size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const color = paint(row * size + column);
      if (!color) continue;
      image.data.set(color, ((size - 1 - row) * size + column) * 4);
    }
  }
  context.putImageData(image, 0, 0);
  context.globalCompositeOperation = "destination-in";
  context.beginPath();
  context.arc(size / 2, size / 2, site.radius_m / spacing, 0, 2 * Math.PI);
  context.fill();
  return { canvas, halfWidthM: offsets[size - 1] + spacing / 2 };
}

/** Place a painted grid on the lunar map. */
function gridOverlay(site: Site, offsets: number[], paint: Paint) {
  const painted = gridCanvas(site, offsets, paint);
  if (!painted) return null;

  // The solver's east/north offsets are a spherical azimuthal equidistant grid.
  // OpenLayers reprojects it onto the lunar stereographic imagery as the map moves.
  const projection = `LUNA:AEQD:${site.latitude_deg}:${site.longitude_deg}`;
  if (!proj4.defs(projection)) {
    proj4.defs(projection, `+proj=aeqd +lat_0=${site.latitude_deg} +lon_0=${site.longitude_deg} +R=${MOON_RADIUS_M} +units=m`);
    register(proj4);
  }
  const { canvas, halfWidthM } = painted;
  return new Static({
    projection,
    imageExtent: [-halfWidthM, -halfWidthM, halfWidthM, halfWidthM],
    url: canvas.toDataURL(),
    interpolate: false,
  });
}
