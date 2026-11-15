import { BufferAttribute, BufferGeometry, Frustum, Group, Matrix4, Mesh, Sphere, Vector3 } from "three";
import type { PerspectiveCamera, ShaderMaterial, Texture, Vector4 } from "three";
import { footprints5m } from "../globe/terrainCoverage";
import { CAP_LATITUDE_DEG, CAP_RADIUS_KM, MOON_RADIUS_KM, POLAR_HALF_EXTENT_KM, latLonToUnit, polarToUnit, unitToPolar } from "./geodesy";
import { ImageryCache, globalBase, polarBase, polarDetail } from "./imagery";
import type { ImageryEntry, ImageryLayer } from "./imagery";
import { LoadQueue } from "./loadQueue";
import { DETAIL_RADIUS_KM, RING_LIMIT, terrainMaterial } from "./terrainMaterial";
import type { SharedUniforms } from "./terrainMaterial";

/** Cells along one side of a tile, matching the API's elevation tiles. */
const CELLS = 64;
const SIDE = CELLS + 1;
/** The API adds one ring of nodes around a tile so its edges can be shaded without seams. */
const PADDED = SIDE + 2;
const VERTICES = SIDE * SIDE + 4 * SIDE;
/** A tile is replaced by its four children once it covers more than this many screen pixels. */
const TILE_PIXELS = 560;
/** Heights fade to the reference sphere over this distance before the 60°S edge of the data. */
const EDGE_FADE_KM = 60;
const GLOBAL_MAX_LEVEL = 7;
/** The 80 m LOLA grid covers this square around the pole (projected km). */
const REGIONAL_80M_HALF_KM = 304;
/** Tiles unused for this many view updates are freed. */
const KEEP_UPDATES = 400;
const RETRY_AFTER_MS = 4000;
/** Around each saved site, tiles down to this level (8 m nodes) are loaded ahead and kept. */
const PREFETCH_LEVEL = 12;
/** Elevation downloads in flight at once; the API cuts tiles in several processes. */
const ELEVATION_DOWNLOADS = 12;

export type TileSite = { centre: Vector3; radiusKm: number; selected: boolean };
export type TileOverlay = { centre: Vector3; halfKm: number };

type Grid = "polar" | "global";
type Slot = { layer: ImageryLayer; level: number; entry: ImageryEntry; settled: boolean };
type TileMesh = Mesh<BufferGeometry, ShaderMaterial>;

class Tile {
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
  base: Slot | null = null;
  detail: Slot | null = null;

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

  constructor(readonly grid: Grid, readonly level: number, readonly row: number, readonly column: number, readonly parent: Tile | null) {
    if (grid === "polar") {
      this.size = 2 * POLAR_HALF_EXTENT_KM / 2 ** level;
      this.west = -POLAR_HALF_EXTENT_KM + column * this.size;
      this.north = POLAR_HALF_EXTENT_KM - row * this.size;
      const x = this.west + this.size / 2;
      const y = this.north - this.size / 2;
      // Ground scale of the polar stereographic map: k = 1/(1 + ρ²/(4R²)).
      this.widthKm = this.size / (1 + (x * x + y * y) / (4 * MOON_RADIUS_KM * MOON_RADIUS_KM));
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
    const corner = new Vector3();
    let farthest = 0;
    for (const [s, t] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      farthest = Math.max(farthest, this.direction(s, t, corner).multiplyScalar(MOON_RADIUS_KM).distanceTo(this.centre));
    }
    this.cornerRadiusKm = farthest;
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

  /** Unit direction at fractions (s east, t south) across the tile. */
  direction(s: number, t: number, out: Vector3) {
    return this.grid === "polar"
      ? polarToUnit(this.west + s * this.size, this.north - t * this.size, out)
      : latLonToUnit(this.north - t * this.size, this.west + s * this.size, out);
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
}

/** The deepest level worth loading for a polar tile, from the data that exists there. */
function polarMaxLevel(tile: Tile) {
  const east = tile.west + tile.size;
  const south = tile.north - tile.size;
  const within = (w: number, s: number, e: number, n: number) => tile.west < e && east > w && south < n && tile.north > s;

  // 5 m grids: level 13 nodes are 4 m apart. NAC photos: level 11 is their finest.
  if (footprints5m.some(({ bounds: [w, s, e, n] }) => within(w / 1000, s / 1000, e / 1000, n / 1000))) return 13;
  if (tile.nearestToPoleKm < DETAIL_RADIUS_KM) return 11;
  if (within(-REGIONAL_80M_HALF_KM, -REGIONAL_80M_HALF_KM, REGIONAL_80M_HALF_KM, REGIONAL_80M_HALF_KM)) return 9;
  return 7;
}

/** Triangles of the node grid plus a downward skirt along each edge; shared by every tile. */
function tileIndex() {
  const index = new Uint16Array((CELLS * CELLS + 4 * CELLS) * 6);
  let offset = 0;
  for (let row = 0; row < CELLS; row++) {
    for (let column = 0; column < CELLS; column++) {
      const a = row * SIDE + column;
      index.set([a, a + SIDE, a + 1, a + 1, a + SIDE, a + SIDE + 1], offset);
      offset += 6;
    }
  }

  const skirt = SIDE * SIDE;
  for (let k = 0; k < CELLS; k++) {
    const edges = [
      [k, k + 1, skirt + k],
      [CELLS * SIDE + k, CELLS * SIDE + k + 1, skirt + SIDE + k],
      [k * SIDE, (k + 1) * SIDE, skirt + 2 * SIDE + k],
      [k * SIDE + CELLS, (k + 1) * SIDE + CELLS, skirt + 3 * SIDE + k],
    ];
    for (const [first, second, below] of edges) {
      index.set([first, below, second, second, below, below + 1], offset);
      offset += 6;
    }
  }
  return new BufferAttribute(index, 1);
}

/** Smoothstep: 0 at or below 0, 1 at or above 1. */
function smooth(t: number) {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * The Moon's surface as two trees of tiles that refine toward the camera: the south-polar cap
 * with LOLA elevation, and the rest of the globe as a smooth sphere. Both carry NASA photos.
 */
export class TileTree {
  readonly group = new Group();
  /** Set when elevation tiles cannot be fetched, so the view can say why terrain is missing. */
  problem: string | null = null;

  private readonly roots = [new Tile("polar", 0, 0, 0, null), new Tile("global", 0, 0, 0, null), new Tile("global", 0, 0, 1, null)];
  private readonly index = tileIndex();
  private readonly imagery: ImageryCache;
  private readonly elevations = new LoadQueue(ELEVATION_DOWNLOADS);
  private readonly built = new Set<Tile>();
  private readonly awaitingPhotos = new Set<Tile>();
  private shown = new Set<Tile>();
  private showing = new Set<Tile>();
  private sites: TileSite[] = [];
  private pinned = new Set<Tile>();
  private overlay: TileOverlay | null = null;

  private stamp = 0;
  private buildsLeft = 0;
  private deferred = false;
  private pixelsPerRadian = 1000;
  private horizonAngle = Math.PI;
  private readonly frustum = new Frustum();
  private readonly matrix = new Matrix4();
  private readonly sphere = new Sphere();
  private readonly cameraPosition = new Vector3();
  private readonly cameraUnit = new Vector3();
  private readonly scratch = new Vector3();

  constructor(private readonly shared: SharedUniforms, anisotropy: number, private readonly onChange: () => void) {
    this.imagery = new ImageryCache(anisotropy, () => {
      this.settlePhotos();
      this.onChange();
    });
  }

  /**
   * Choose the tiles to draw for this camera and start loading what is missing.
   * Returns true when another update is needed soon even if the camera stays still.
   */
  update(camera: PerspectiveCamera, viewportHeightPx: number) {
    this.stamp++;
    this.buildsLeft = 6;
    this.deferred = false;
    this.cameraPosition.copy(camera.position);
    this.cameraUnit.copy(camera.position).normalize();
    this.frustum.setFromProjectionMatrix(this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    this.pixelsPerRadian = viewportHeightPx / (2 * Math.tan(camera.fov * Math.PI / 360));

    // Horizon limit: γ_max = acos(R₋/d) + acos(R₋/R₊)
    //   γ_max - Largest angle from the camera's nadir at which terrain can still be seen.
    //   d - Camera distance from the Moon's centre; R₋ - a radius below all terrain;
    //   R₊ - a radius above all terrain, allowing for exaggeration. All in km.
    const below = MOON_RADIUS_KM - 10;
    const above = MOON_RADIUS_KM + 8 * this.shared.uExaggeration.value;
    this.horizonAngle = Math.acos(Math.min(1, below / camera.position.length())) + Math.acos(below / above);

    for (const root of this.roots) this.visit(root);
    for (const tile of this.shown) {
      if (!this.showing.has(tile) && tile.mesh) tile.mesh.visible = false;
    }
    [this.shown, this.showing] = [this.showing, this.shown];
    this.showing.clear();

    if (this.stamp % 100 === 0) for (const root of this.roots) this.sweep(root);
    return this.deferred;
  }

  /**
   * Terrain height in km above the reference sphere, as drawn: from the tile on screen there,
   * which may be coarser than the finest loaded one while detail is still arriving. The camera
   * is kept above this, so it can never end up below the surface being drawn.
   */
  heightAt(unit: Vector3) {
    if (unit.z > Math.sin(CAP_LATITUDE_DEG * Math.PI / 180)) return 0;
    const [x, y] = unitToPolar(unit);

    let tile = this.roots[0];
    for (;;) {
      if (this.shown.has(tile)) break;
      const finer = tile.children?.find((child) => child.heights &&
        x >= child.west && x <= child.west + child.size && y <= child.north && y >= child.north - child.size);
      if (!finer) break;
      tile = finer;
    }
    if (!tile.heights) return 0;

    // Bilinear interpolation between the four surrounding nodes of the padded grid.
    const spacing = tile.size / CELLS;
    const column = Math.max(0, Math.min(PADDED - 1.001, (x - tile.west) / spacing + 1));
    const row = Math.max(0, Math.min(PADDED - 1.001, (tile.north - y) / spacing + 1));
    const c0 = Math.floor(column);
    const r0 = Math.floor(row);
    const s = column - c0;
    const t = row - r0;
    const at = (r: number, c: number) => tile.heights![r * PADDED + c];
    return (at(r0, c0) * (1 - s) + at(r0, c0 + 1) * s) * (1 - t) + (at(r0 + 1, c0) * (1 - s) + at(r0 + 1, c0 + 1) * s) * t;
  }

  setSites(sites: TileSite[]) {
    this.sites = sites;
    this.prefetch(sites);
    for (const tile of this.built) this.markSites(tile);
  }

  /** Where the simulation's result grid lies, or null to hide it. The texture is shared. */
  setOverlay(overlay: TileOverlay | null) {
    this.overlay = overlay;
    for (const tile of this.built) this.markSites(tile);
  }

  dispose() {
    for (const root of this.roots) this.release(root);
    this.imagery.dispose();
  }

  private visit(tile: Tile) {
    tile.touched = this.stamp;
    if (!this.inView(tile)) return;
    this.load(tile);

    const wantsDetail = tile.level < tile.maxLevel && tile.widthKm / tile.distanceKm * this.pixelsPerRadian > TILE_PIXELS;
    if (wantsDetail) {
      tile.children ??= this.subdivide(tile);
      // Children replace their parent only once every visible one can be drawn, so the
      // surface never shows a hole while finer tiles are still loading.
      let ready = true;
      for (const child of tile.children) {
        child.touched = this.stamp;
        if (!this.inView(child)) continue;
        this.load(child);
        if (child.state !== "ready") ready = false;
      }
      if (ready) {
        for (const child of tile.children) this.visit(child);
        return;
      }
    }

    if (tile.mesh) {
      tile.mesh.visible = true;
      this.showing.add(tile);
    }
  }

  private subdivide(tile: Tile) {
    const children = [];
    for (const [down, right] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const child = new Tile(tile.grid, tile.level + 1, tile.row * 2 + down, tile.column * 2 + right, tile);
      if (child.inDomain) children.push(child);
    }
    return children;
  }

  /** Whether the tile can be seen, also noting its distance from the camera. */
  private inView(tile: Tile) {
    const angle = Math.acos(Math.max(-1, Math.min(1, tile.unit.dot(this.cameraUnit))));
    if (angle - 1.1 * tile.cornerRadiusKm / MOON_RADIUS_KM > this.horizonAngle) return false;

    // Bounding sphere around the tile's relief at the current exaggeration.
    const exaggeration = this.shared.uExaggeration.value;
    const [lowest, highest] = tile.heightRange();
    const middle = (lowest + highest) / 2 * exaggeration;
    this.sphere.center.copy(tile.unit).multiplyScalar(MOON_RADIUS_KM + middle);
    this.sphere.radius = tile.cornerRadiusKm + (highest - lowest) / 2 * exaggeration + 0.01;
    tile.distanceKm = Math.max(1e-3, this.sphere.center.distanceTo(this.cameraPosition) - this.sphere.radius);
    return this.frustum.intersectsSphere(this.sphere);
  }

  private load(tile: Tile) {
    if (tile.state === "failed" && performance.now() - tile.failedAt > RETRY_AFTER_MS) tile.state = "idle";
    if (tile.state !== "idle") return;

    if (tile.grid === "global") {
      // A smooth-sphere tile needs no download, but building many in one frame would stutter.
      if (this.buildsLeft === 0) { this.deferred = true; return; }
      this.buildsLeft--;
      this.build(tile, null);
      return;
    }

    tile.state = "queued";
    this.elevations.add({
      get priority() { return tile.distanceKm; },
      stale: () => tile.disposed || (!tile.pinned && tile.touched < this.stamp - 2),
      dropped: () => {
        if (tile.disposed) return;
        // Asked for again by the next update, which this makes sure happens.
        tile.state = "idle";
        this.onChange();
      },
      run: () => this.fetchElevation(tile),
    });
  }

  private async fetchElevation(tile: Tile) {
    try {
      const response = await fetch(`/api/terrain/tiles/${tile.level}/${tile.row}/${tile.column}`);
      if (!response.ok) throw new Error(`Elevation tile ${response.status}`);
      const heights = new Float32Array(await response.arrayBuffer());
      if (heights.length !== PADDED * PADDED) throw new Error("Unexpected elevation tile size");
      if (tile.disposed) return;

      this.build(tile, heights);
      this.problem = null;
    } catch {
      if (tile.disposed) return;
      tile.state = "failed";
      tile.failedAt = performance.now();
      this.problem = "Elevation tiles could not be loaded. Check that the API is running and up to date.";
    }
    this.onChange();
  }

  /** Create the tile's mesh from heights in metres on the padded grid (null for a smooth sphere). */
  private build(tile: Tile, heightsM: Float32Array | null) {
    const directions = new Float64Array(PADDED * PADDED * 3);
    const heights = heightsM && new Float32Array(PADDED * PADDED);
    const direction = this.scratch;
    let lowest = Infinity;
    let highest = -Infinity;
    for (let row = 0; row < PADDED; row++) {
      for (let column = 0; column < PADDED; column++) {
        const node = row * PADDED + column;
        tile.direction((column - 1) / CELLS, (row - 1) / CELLS, direction).toArray(directions, node * 3);
        if (!heights || !heightsM) continue;

        // Nodes without data sit on the reference sphere, and the relief fades to it before
        // the 60°S edge of the data so the cap meets the smooth globe without a cliff.
        const x = tile.west + (column - 1) / CELLS * tile.size;
        const y = tile.north - (row - 1) / CELLS * tile.size;
        const fade = smooth((CAP_RADIUS_KM - Math.hypot(x, y)) / EDGE_FADE_KM);
        const height = Number.isFinite(heightsM[node]) ? heightsM[node] / 1000 * fade : 0;
        heights[node] = height;
        lowest = Math.min(lowest, height);
        highest = Math.max(highest, height);
      }
    }

    const positions = new Float32Array(VERTICES * 3);
    const normals = new Float32Array(VERTICES * 3);
    const uvs = new Float32Array(VERTICES * 2);
    const elevation = new Float32Array(VERTICES);
    const centre = tile.centre;
    for (let row = 0; row < SIDE; row++) {
      for (let column = 0; column < SIDE; column++) {
        const node = (row + 1) * PADDED + column + 1;
        const vertex = row * SIDE + column;
        const dx = directions[node * 3];
        const dy = directions[node * 3 + 1];
        const dz = directions[node * 3 + 2];
        positions[vertex * 3] = dx * MOON_RADIUS_KM - centre.x;
        positions[vertex * 3 + 1] = dy * MOON_RADIUS_KM - centre.y;
        positions[vertex * 3 + 2] = dz * MOON_RADIUS_KM - centre.z;
        uvs[vertex * 2] = column / CELLS;
        uvs[vertex * 2 + 1] = row / CELLS;

        let nx = dx;
        let ny = dy;
        let nz = dz;
        if (heights) {
          elevation[vertex] = heights[node];
          // Height-field normal from central differences across neighbouring nodes:
          //   n ∝ r − g_E·ê − g_N·n̂; g = Δh/(R·‖Δr‖)
          //   r - Unit radial direction; ê, n̂ - unit ground directions toward the east and
          //   north neighbours; Δh - height difference between opposite neighbours, in km;
          //   R·‖Δr‖ - ground distance between them, in km; g - dimensionless slope.
          for (const [ahead, behind] of [[node + 1, node - 1], [node - PADDED, node + PADDED]]) {
            const ax = directions[ahead * 3] - directions[behind * 3];
            const ay = directions[ahead * 3 + 1] - directions[behind * 3 + 1];
            const az = directions[ahead * 3 + 2] - directions[behind * 3 + 2];
            const span = ax * ax + ay * ay + az * az;
            const slope = (heights[ahead] - heights[behind]) / (MOON_RADIUS_KM * span);
            nx -= slope * ax;
            ny -= slope * ay;
            nz -= slope * az;
          }
          const length = Math.hypot(nx, ny, nz);
          nx /= length;
          ny /= length;
          nz /= length;
        }
        normals[vertex * 3] = nx;
        normals[vertex * 3 + 1] = ny;
        normals[vertex * 3 + 2] = nz;
      }
    }

    // Skirt: a copy of each edge pushed below the surface, hiding hairline gaps between
    // neighbouring tiles of different detail.
    const drop = tile.widthKm * 0.025;
    const edgeVertex = [
      (k: number) => k, (k: number) => CELLS * SIDE + k, (k: number) => k * SIDE, (k: number) => k * SIDE + CELLS,
    ];
    edgeVertex.forEach((vertexOf, edge) => {
      for (let k = 0; k < SIDE; k++) {
        const from = vertexOf(k);
        const to = SIDE * SIDE + edge * SIDE + k;
        positions.copyWithin(to * 3, from * 3, from * 3 + 3);
        normals.copyWithin(to * 3, from * 3, from * 3 + 3);
        uvs.copyWithin(to * 2, from * 2, from * 2 + 2);
        elevation[to] = elevation[from] - drop;
      }
    });

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
    geometry.setAttribute("aHeight", new BufferAttribute(elevation, 1));
    geometry.setIndex(this.index);

    const mesh: TileMesh = new Mesh(geometry, terrainMaterial(this.shared, tile.grid, tile.centre));
    mesh.position.copy(tile.centre);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // Tiles are culled here, with their relief; the vertex shader moves them anyway.
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.group.add(mesh);

    tile.mesh = mesh;
    tile.heights = heights;
    if (heights) {
      tile.minHeightKm = lowest;
      tile.maxHeightKm = highest;
    }
    tile.state = "ready";
    this.built.add(tile);
    this.requestPhotos(tile);
    this.markSites(tile);
  }

  private requestPhotos(tile: Tile) {
    const slot = (layer: ImageryLayer): Slot => {
      const level = Math.min(tile.level, layer.maxLevel);
      const shift = tile.level - level;
      const entry = this.imagery.acquire(layer.url(level, tile.row >> shift, tile.column >> shift), tile.distanceKm);
      return { layer, level, entry, settled: false };
    };
    tile.base = slot(tile.grid === "polar" ? polarBase : globalBase);
    // The sharp NAC mosaic joins in from level 5, as on the 2D map.
    if (tile.grid === "polar" && tile.level >= 5 && tile.nearestToPoleKm < DETAIL_RADIUS_KM) tile.detail = slot(polarDetail);
    this.awaitingPhotos.add(tile);
    this.placePhotos(tile);
  }

  private settlePhotos() {
    for (const tile of this.awaitingPhotos) this.placePhotos(tile);
  }

  /**
   * Point the tile's material at the best photo in memory for each layer: its own once
   * loaded, and until then the part of an ancestor's photo that covers the tile.
   */
  private placePhotos(tile: Tile) {
    const uniforms = tile.mesh!.material.uniforms;
    const place = (slot: Slot, sampler: { value: Texture | null }, address: { value: Vector4 }) => {
      for (let level = slot.level; level >= 0; level--) {
        const shift = tile.level - level;
        const texture = level === slot.level ? slot.entry.texture : this.imagery.peek(slot.layer.url(level, tile.row >> shift, tile.column >> shift));
        if (!texture) continue;

        // Sub-rectangle of a coarser photo: scale = 2^(−shift); offset = (index mod 2^shift)·scale.
        const scale = 1 / 2 ** shift;
        sampler.value = texture;
        address.value.set((tile.column - ((tile.column >> shift) << shift)) * scale, (tile.row - ((tile.row >> shift) << shift)) * scale, scale, scale);
        slot.settled = level === slot.level;
        return true;
      }
      return false;
    };

    if (tile.base) {
      uniforms.uHasBase.value = place(tile.base, uniforms.uBase, uniforms.uBaseUv) ? 1 : 0;
      tile.base.settled ||= tile.base.entry.failed;
    }
    if (tile.detail) {
      const shown = place(tile.detail, uniforms.uDetail, uniforms.uDetailUv);
      uniforms.uDetailMix.value = shown ? (tile.level >= 6 ? 1 : 0.6) : 0;
      tile.detail.settled ||= tile.detail.entry.failed;
    }
    if ((tile.base?.settled ?? true) && (tile.detail?.settled ?? true)) this.awaitingPhotos.delete(tile);
  }

  /** Give the tile the site circles and the result grid that fall on it. */
  private markSites(tile: Tile) {
    const uniforms = tile.mesh!.material.uniforms;
    const rings = uniforms.uRings.value as Vector4[];
    let count = 0;
    let selected = -1;
    for (const site of this.sites) {
      if (count === RING_LIMIT) break;
      if (site.centre.distanceTo(tile.centre) > tile.cornerRadiusKm + site.radiusKm * 1.1) continue;
      const offset = this.scratch.subVectors(site.centre, tile.centre);
      rings[count].set(offset.x, offset.y, offset.z, site.radiusKm);
      if (site.selected) selected = count;
      count++;
    }
    uniforms.uRingCount.value = count;
    uniforms.uSelectedRing.value = selected;

    const overlay = this.overlay;
    const covered = overlay !== null && overlay.centre.distanceTo(tile.centre) < tile.cornerRadiusKm + overlay.halfKm * Math.SQRT2;
    uniforms.uOverlayOn.value = covered ? 1 : 0;
    if (covered) (uniforms.uOverlayOffset.value as Vector3).subVectors(overlay.centre, tile.centre);
  }

  /** Free tiles nobody looked at for a while; returns the newest use within the subtree. */
  private sweep(tile: Tile): number {
    if (tile.pinned) return Infinity;
    if (!tile.children) return tile.touched;

    let newest = 0;
    for (const child of tile.children) newest = Math.max(newest, this.sweep(child));
    if (newest < this.stamp - KEEP_UPDATES) {
      for (const child of tile.children) this.release(child);
      tile.children = null;
    }
    return Math.max(newest, tile.touched);
  }

  /**
   * Load the terrain and photos around every saved site ahead of time, so flying there finds
   * them in memory instead of showing gaps while they download. These tiles stay loaded.
   */
  private prefetch(sites: TileSite[]) {
    const wanted = new Set<Tile>();
    const unit = new Vector3();
    for (const site of sites) {
      if (site.centre.z / MOON_RADIUS_KM > Math.sin(CAP_LATITUDE_DEG * Math.PI / 180)) continue;
      const [x, y] = unitToPolar(unit.copy(site.centre).normalize());
      for (let level = 0; level <= PREFETCH_LEVEL; level++) {
        const size = 2 * POLAR_HALF_EXTENT_KM / 2 ** level;
        const column = Math.floor((x + POLAR_HALF_EXTENT_KM) / size);
        const row = Math.floor((POLAR_HALF_EXTENT_KM - y) / size);
        // The tile holding the site and its neighbours, which a close view of the site also needs.
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const tile = this.tileAt(level, row + dr, column + dc);
            if (tile) wanted.add(tile);
          }
        }
      }
    }

    for (const tile of this.pinned) if (!wanted.has(tile)) tile.pinned = false;
    for (const tile of wanted) {
      tile.pinned = true;
      tile.distanceKm = 1e9;
      this.load(tile);
    }
    this.pinned = wanted;
  }

  /** The polar tile at a position in the tree, creating the ones above it; null if it does not exist. */
  private tileAt(level: number, row: number, column: number) {
    if (row < 0 || column < 0 || row >= 2 ** level || column >= 2 ** level) return null;

    let tile = this.roots[0];
    for (let depth = 1; depth <= level; depth++) {
      if (depth > tile.maxLevel) return null;
      tile.children ??= this.subdivide(tile);
      const shift = level - depth;
      const found: Tile | undefined = tile.children.find((child) => child.row === row >> shift && child.column === column >> shift);
      if (!found) return null;
      tile = found;
    }
    return tile;
  }

  private release(tile: Tile) {
    for (const child of tile.children ?? []) this.release(child);
    tile.children = null;
    tile.disposed = true;
    this.built.delete(tile);
    this.awaitingPhotos.delete(tile);
    this.shown.delete(tile);
    if (tile.base) this.imagery.release(tile.base.entry);
    if (tile.detail) this.imagery.release(tile.detail.entry);
    if (!tile.mesh) return;

    this.group.remove(tile.mesh);
    // The index buffer is shared; detach it so freeing this tile leaves it on the graphics card.
    tile.mesh.geometry.setIndex(null);
    tile.mesh.geometry.dispose();
    tile.mesh.material.dispose();
    tile.mesh = null;
  }
}
