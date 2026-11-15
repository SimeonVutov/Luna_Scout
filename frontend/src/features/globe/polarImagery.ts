import { addProjection, get as getProjection } from "ol/proj";
import Projection from "ol/proj/Projection";
import { register } from "ol/proj/proj4";
import type ImageTile from "ol/ImageTile";
import type Tile from "ol/Tile";
import WMTS from "ol/source/WMTS";
import XYZ from "ol/source/XYZ";
import TileGrid from "ol/tilegrid/TileGrid";
import WMTSTileGrid from "ol/tilegrid/WMTS";
import proj4 from "proj4";

const radius = 1_737_400;
export const polar = "LUNA:SP";
export const geographic = "LUNA:LL";
export const edge = 1_095_930;
export const resolution = 3.0578404017857101e7 * 0.00028;

proj4.defs(geographic, `+proj=longlat +R=${radius} +no_defs`);
proj4.defs(polar, `+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=${radius} +units=m +no_defs`);
addProjection(new Projection({
  code: geographic,
  units: "degrees",
  extent: [-180, -90, 180, 90],
  metersPerUnit: Math.PI * radius / 180,
  // Mean local pixel scale: δ_local = δ(1 + cos φ)/2.
  // δ_local, δ - Angular pixel scales in degrees; φ - Latitude, converted to radians.
  // The projection's lunar metresPerUnit converts this to metres, avoiding Earth's radius.
  getPointResolution: (pixel, [, latitude]) => pixel * (1 + Math.cos(latitude * Math.PI / 180)) / 2,
}));
register(proj4);
const projection = getProjection(polar)!;
projection.setExtent([-edge, -edge, edge, edge]);
projection.setGetPointResolution((pixel, [x, y]) => pixel / (1 + (x * x + y * y) / (4 * radius * radius)));

export const detailExtent = [-136526, -136525, 136525, 136526];
export const detailLayer = "LRO_NAC_AvgMosaic_SPole855_1mp";
/** The NAC mosaic holds data inside this polar-stereographic radius (85.5°S) and nothing beyond it. */
const detailDataRadius = 136_526;
/** Width over which the sharp photo fades into the base photo at the edge of its data. */
const detailFeatherWidth = 6_000;
export const globalExtent = [-180, -90, 180, 90];
export const globalLayer = "LRO_WAC_Mosaic_Global_303ppd_v02";

/** NASA Moon Trek's global geographic pyramid has two columns and one row at level zero. */
export function globalImagery() {
  return new XYZ({
    url: `https://trek.nasa.gov/tiles/Moon/EQ/${globalLayer}/1.0.0/default/default028mm/{z}/{y}/{x}.jpg`,
    projection: geographic,
    wrapX: false,
    tileGrid: new TileGrid({
      extent: globalExtent,
      origin: [-180, 90],
      tileSize: 256,
      // Geographic tile scale: δλ_z = 180° / (256 × 2ᶻ).
      // δλ_z - Degrees per tile pixel at level z; z is dimensionless.
      resolutions: Array.from({ length: 9 }, (_, level) => 180 / (256 * 2 ** level)),
      sizes: Array.from({ length: 9 }, (_, level) => [2 ** (level + 1), 2 ** level]),
    }),
  });
}

/**
 * Load a detail tile through a canvas and fade its alpha to zero toward the edge of the
 * mosaic's data, so the sharp photo blends into the layer below instead of ending in a line.
 */
function featheredTile(tile: Tile, source: string) {
  const image = (tile as ImageTile).getImage() as HTMLImageElement;
  const [level, column, row] = tile.getTileCoord();
  const metresPerPixel = resolution / 2 ** level;
  const pixelX = (index: number) => -edge + (column * 256 + index + 0.5) * metresPerPixel;
  const pixelY = (index: number) => edge - (row * 256 + index + 0.5) * metresPerPixel;

  // Tiles entirely inside the solid part of the mosaic need no processing.
  const farthest = Math.hypot(Math.max(Math.abs(pixelX(0)), Math.abs(pixelX(255))), Math.max(Math.abs(pixelY(0)), Math.abs(pixelY(255))));
  if (farthest < detailDataRadius - detailFeatherWidth) { image.src = source; return; }

  const original = new Image();
  original.crossOrigin = "anonymous";
  original.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = original.naturalWidth;
    canvas.height = original.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) { image.src = source; return; }

    context.drawImage(original, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const scale = 256 / canvas.width;
    for (let y = 0; y < canvas.height; y++) {
      const projectedY = pixelY(y * scale);
      for (let x = 0; x < canvas.width; x++) {
        // Smoothstep fade: w = t²(3 − 2t), t = (R − r)/F clamped to [0, 1].
        const radius = Math.hypot(pixelX(x * scale), projectedY);
        const t = Math.max(0, Math.min(1, (detailDataRadius - radius) / detailFeatherWidth));
        pixels.data[(y * canvas.width + x) * 4 + 3] *= t * t * (3 - 2 * t);
      }
    }
    context.putImageData(pixels, 0, 0);
    image.src = canvas.toDataURL();
  };
  original.onerror = () => { image.src = source; };
  original.src = source;
}

export function polarImagery(layer: string, levels: number, extent?: number[], featherEdge = false) {
  const matrices = Array.from({ length: levels }, (_, i) => i);
  return new WMTS({
    ...(featherEdge ? { tileLoadFunction: featheredTile } : {}),
    url: `https://trek.nasa.gov/tiles/Moon/SP/${layer}/1.0.0/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png`,
    requestEncoding: "REST",
    layer,
    style: "default",
    matrixSet: "default028mm",
    format: "image/png",
    projection,
    wrapX: false,
    reprojectionErrorThreshold: 0.25,
    tileGrid: new WMTSTileGrid({
      extent,
      origin: [-edge, edge],
      sizes: matrices.map((i) => [2 ** (i + 1), 2 ** i]),
      resolutions: matrices.map((i) => resolution / 2 ** i),
      matrixIds: matrices.map(String),
    }),
  });
}
