import { register } from "ol/proj/proj4";
import Static from "ol/source/ImageStatic";
import proj4 from "proj4";
import type { Site, SunlightGrid } from "../../api/types";
import { sunlightClass, sunlightColors } from "../results/sunlightColors";

export const MOON_RADIUS_M = 1_737_400;

export function sunlightOverlay(site: Site, grid: SunlightGrid) {
  const offsets = grid.offsets_m;
  const size = offsets.length;
  const spacing = size > 1 ? offsets[1] - offsets[0] : 2 * site.radius_m;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const image = context.createImageData(size, size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const category = sunlightClass(grid, row * size + column);
      if (!category) continue;
      const rgba = ((size - 1 - row) * size + column) * 4;
      const [red, green, blue] = sunlightColors[category];
      image.data.set([red, green, blue, category === "shadow" ? 126 : 149], rgba);
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
