import { Vector3 } from "three";
import type { BufferGeometry, Mesh, ShaderMaterial } from "three";
import { footprints5m } from "../globe/terrainCoverage";
import { CAP_LATITUDE_DEG, CAP_RADIUS_KM, MOON_RADIUS_KM, POLAR_HALF_EXTENT_KM, latLonToUnit, polarToUnit } from "./geodesy";
import type { ImageryEntry, ImageryLayer } from "./imagery";
import { DETAIL_RADIUS_KM } from "./terrainMaterial";

/** Cells along one side of a tile, matching the API's elevation tiles. */
export const CELLS = 64;
export const SIDE = CELLS + 1;
/** The API adds one ring of nodes around a tile so its edges can be shaded without seams. */
export const PADDED = SIDE + 2;

const GLOBAL_MAX_LEVEL = 7;
/** The 80 m LOLA grid covers this square around the pole (projected km). */
const REGIONAL_80M_HALF_KM = 304;

export type TileGrid = "polar" | "global";
export type TileMesh = Mesh<BufferGeometry, ShaderMaterial>;

/** One photo layer of a tile: what it asked for, and whether that is the best it will get. */
export type PhotoSlot = { layer: ImageryLayer; level: number; entry: ImageryEntry; settled: boolean };

/**
 * One square of the Moon's surface at one level of detail. It knows where it lies and how big it
 * is, and carries the state the tile tree needs to load, draw and free it.
 */
export class Tile {
  children: Tile[] | null = null;
  mesh: TileMesh | null = null;
  /** Heights in km on the padded node grid, north to south. Polar tiles only. */
  heights: Float32Array | null = null;
  state: "idle" | "queued" | "ready" | "failed" = "idle";
  failedAt = 0;
  disposed = false;
  /** Loaded ahead for a saved site and never freed while the site exists. */
  pinned = false;
  touched = 0;
  distanceKm = Infinity;
  /** Height range of the tile's own nodes, in km; meaningful once `heights` is loaded. */
  minHeightKm = 0;
  maxHeightKm = 0;
  base: PhotoSlot | null = null;
  detail: PhotoSlot | null = null;

  /** Unit direction and position (km) of the tile centre on the reference sphere. */
  readonly unit = new Vector3();
  readonly centre = new Vector3();
  /** West and north edges and the tile size: projected km (polar) or degrees (global). */
  readonly west: number;
  readonly north: number;
  readonly size: number;
  /** Distance from the centre to the farthest corner, and ground width, in km. */
  readonly cornerRadiusKm: number;
  readonly widthKm: number;
  readonly maxLevel: number;

  constructor(
    readonly grid: TileGrid,
    readonly level: number,
    readonly row: number,
    readonly column: number,
    readonly parent: Tile | null,
  ) {
    if (grid === "polar") {
      this.size = 2 * POLAR_HALF_EXTENT_KM / 2 ** level;
      this.west = -POLAR_HALF_EXTENT_KM + column * this.size;
      this.north = POLAR_HALF_EXTENT_KM - row * this.size;

      const centreX = this.west + this.size / 2;
      const centreY = this.north - this.size / 2;

      // Ground scale of the polar stereographic map:
      //   w = s / (1 + ρ²/(4R²))
      //   w - Ground width of the tile, in km; s - its projected width, in km.
      //   ρ - Projected distance of the tile centre from the pole, in km; R - lunar radius, in km.
      this.widthKm = this.size / (1 + (centreX * centreX + centreY * centreY) / (4 * MOON_RADIUS_KM * MOON_RADIUS_KM));
      this.maxLevel = polarMaxLevel(this);
    } else {
      this.size = 180 / 2 ** level;
      this.west = -180 + column * this.size;
      this.north = 90 - row * this.size;
      this.widthKm = MOON_RADIUS_KM * this.size * Math.PI / 180;
      this.maxLevel = GLOBAL_MAX_LEVEL;
    }

    this.direction(0.5, 0.5, this.unit);
    this.centre.copy(this.unit).multiplyScalar(MOON_RADIUS_KM);
    this.cornerRadiusKm = this.farthestCornerKm();
  }

  /** Unit direction at fractions (s east, t south) across the tile. */
  direction(s: number, t: number, out: Vector3) {
    return this.grid === "polar"
      ? polarToUnit(this.west + s * this.size, this.north - t * this.size, out)
      : latLonToUnit(this.north - t * this.size, this.west + s * this.size, out);
  }

  /**
   * Height range in km for deciding whether the tile is in view. Until its own heights arrive,
   * a polar tile uses its nearest loaded ancestor's range, looked up now rather than when the
   * tile was created: tiles made ahead of time would otherwise sit at the reference sphere,
   * kilometres below high ground, and be wrongly judged out of view, leaving holes.
   */
  heightRange(): [number, number] {
    let source: Tile | null = this;
    while (source && source.grid === "polar" && !source.heights) source = source.parent;
    if (!source || source === this) return [this.minHeightKm, this.maxHeightKm];

    // A coarser tile averages its heights, so peaks inside this tile can rise a little above it.
    const margin = 0.05 + 0.02 * this.widthKm;
    return [source.minHeightKm - margin, source.maxHeightKm + margin];
  }

  /** Whether the projected point (km) lies inside this polar tile. */
  containsPolar(x: number, y: number) {
    return x >= this.west && x <= this.west + this.size && y <= this.north && y >= this.north - this.size;
  }

  /** Height in km at a projected point of this polar tile, from its own loaded heights. */
  interpolateHeight(x: number, y: number) {
    const heights = this.heights;
    if (!heights) return 0;

    // Bilinear interpolation: h = (1 − t)[(1 − s)h₀₀ + s·h₀₁] + t[(1 − s)h₁₀ + s·h₁₁]
    //   h₀₀, h₀₁, h₁₀, h₁₁ - Heights of the four surrounding nodes of the padded grid, in km.
    //   s, t - Fractions of a cell eastward and southward from the first node, dimensionless.
    const spacing = this.size / CELLS;
    const column = Math.max(0, Math.min(PADDED - 1.001, (x - this.west) / spacing + 1));
    const row = Math.max(0, Math.min(PADDED - 1.001, (this.north - y) / spacing + 1));

    const firstColumn = Math.floor(column);
    const firstRow = Math.floor(row);
    const s = column - firstColumn;
    const t = row - firstRow;
    const at = (r: number, c: number) => heights[r * PADDED + c];

    const northEdge = at(firstRow, firstColumn) * (1 - s) + at(firstRow, firstColumn + 1) * s;
    const southEdge = at(firstRow + 1, firstColumn) * (1 - s) + at(firstRow + 1, firstColumn + 1) * s;
    return northEdge * (1 - t) + southEdge * t;
  }

  /** Whether any part of the tile lies in the region its grid is responsible for. */
  get inDomain() {
    return this.grid === "polar" ? this.nearestToPoleKm < CAP_RADIUS_KM : this.north > CAP_LATITUDE_DEG;
  }

  /** Projected distance from the pole to the nearest point of a polar tile. */
  get nearestToPoleKm() {
    const east = this.west + this.size;
    const south = this.north - this.size;
    const x = this.west > 0 ? this.west : east < 0 ? -east : 0;
    const y = south > 0 ? south : this.north < 0 ? -this.north : 0;
    return Math.hypot(x, y);
  }

  private farthestCornerKm() {
    const corner = new Vector3();
    let farthest = 0;

    for (const [s, t] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const cornerKm = this.direction(s, t, corner).multiplyScalar(MOON_RADIUS_KM);
      farthest = Math.max(farthest, cornerKm.distanceTo(this.centre));
    }
    return farthest;
  }
}

/** The deepest level worth loading for a polar tile, from the data that exists there. */
function polarMaxLevel(tile: Tile) {
  const east = tile.west + tile.size;
  const south = tile.north - tile.size;
  const overlaps = (w: number, s: number, e: number, n: number) => tile.west < e && east > w && south < n && tile.north > s;

  // 5 m grids: level 13 nodes are 4 m apart. NAC photos: level 11 is their finest.
  if (footprints5m.some(({ bounds: [w, s, e, n] }) => overlaps(w / 1000, s / 1000, e / 1000, n / 1000))) return 13;
  if (tile.nearestToPoleKm < DETAIL_RADIUS_KM) return 11;
  if (overlaps(-REGIONAL_80M_HALF_KM, -REGIONAL_80M_HALF_KM, REGIONAL_80M_HALF_KM, REGIONAL_80M_HALF_KM)) return 9;
  return 7;
}
