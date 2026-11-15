import { register } from "ol/proj/proj4";
import Static from "ol/source/ImageStatic";
import proj4 from "proj4";
import type { Site, SlopeGrid, SunlightGrid } from "../../api/types";
import { slopeClass } from "../results/slopeColors";
import { sunlightClass, sunlightColors } from "../results/sunlightColors";

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

export function slopeOverlay(site: Site, grid: SlopeGrid) {
  return gridOverlay(site, grid.offsets_m, (index) => {
    const slope = grid.slope_deg[index];
    if (!grid.inside_site[index] || slope === null) return null;
    const [red, green, blue] = slopeClass(slope).color;
    return [red, green, blue, 165];
  });
}

/** Paint one image pixel per reporting point, clipped to the site circle, on the lunar map. */
function gridOverlay(site: Site, offsets: number[], paint: Paint) {
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

  // The solver's east/north offsets are a spherical azimuthal equidistant grid.
  // OpenLayers reprojects it onto the lunar stereographic imagery as the map moves.
  const projection = `LUNA:AEQD:${site.latitude_deg}:${site.longitude_deg}`;
  if (!proj4.defs(projection)) {
    proj4.defs(projection, `+proj=aeqd +lat_0=${site.latitude_deg} +lon_0=${site.longitude_deg} +R=${MOON_RADIUS_M} +units=m`);
    register(proj4);
  }
  const minimum = offsets[0] - spacing / 2;
  const maximum = offsets[size - 1] + spacing / 2;
  return new Static({
    projection,
    imageExtent: [minimum, minimum, maximum, maximum],
    url: canvas.toDataURL(),
    interpolate: false,
  });
}
