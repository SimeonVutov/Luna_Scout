import { addProjection, get as getProjection } from "ol/proj";
import Projection from "ol/proj/Projection";
import { register } from "ol/proj/proj4";
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
export const polarCoverages = [
  { latitude: -85.5, label: "85.5°S · NAC imagery", color: "#9ee4d5" },
  { latitude: -87.5, label: "87.5°S · PDS LOLA 5 m extent", color: "#e4c48c" },
] as const;
export function polarRadius(latitude: number) {
  return 2 * radius * Math.tan((90 + latitude) * Math.PI / 360);
}
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

export function polarImagery(layer: string, levels: number, extent?: number[]) {
  const matrices = Array.from({ length: levels }, (_, i) => i);
  return new WMTS({
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
