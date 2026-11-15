import { Group, Vector3 } from "three";
import type { BufferAttribute, PerspectiveCamera } from "three";
import { CAP_LATITUDE_DEG, MOON_RADIUS_KM, POLAR_HALF_EXTENT_KM, unitToPolar } from "./geodesy";
import { LoadQueue } from "./loadQueue";
import { PADDED, Tile } from "./tile";
import { createTileMesh, tileIndex } from "./tileMesh";
import { TilePhotos } from "./tilePhotos";
import { applySitesToTile } from "./tileSites";
import { TileVisibility } from "./tileVisibility";
import type { TileOverlay, TileSite } from "./tileSites";
import type { SharedUniforms } from "./terrainMaterial";

export type { TileOverlay, TileSite };

/** Tiles unused for this many view updates are freed. */
const KEEP_UPDATES = 400;
const RETRY_AFTER_MS = 4000;
/** Smooth-sphere tiles built in one update; more would stutter the frame. */
const GLOBAL_BUILDS_PER_UPDATE = 6;
/** Around each saved site, tiles down to this level (8 m nodes) are loaded ahead and kept. */
const PREFETCH_LEVEL = 12;
/** Elevation downloads in flight at once; the API cuts tiles in several processes. */
const ELEVATION_DOWNLOADS = 12;
/**
 * The Moon's surface as two trees of tiles that refine toward the camera: the south-polar cap
 * with LOLA elevation, and the rest of the globe as a smooth sphere. Both carry NASA photos.
 */
export class TileTree {
  readonly group = new Group();
  /** Set when elevation tiles cannot be fetched, so the view can say why terrain is missing. */
  problem: string | null = null;

  private readonly roots = [new Tile("polar", 0, 0, 0, null), new Tile("global", 0, 0, 0, null), new Tile("global", 0, 0, 1, null)];
  private readonly index: BufferAttribute = tileIndex();
  private readonly photos: TilePhotos;
  private readonly elevations = new LoadQueue(ELEVATION_DOWNLOADS);
  private readonly built = new Set<Tile>();
  private shown = new Set<Tile>();
  private showing = new Set<Tile>();
  private pinned = new Set<Tile>();

  private sites: TileSite[] = [];
  private overlay: TileOverlay | null = null;

  private stamp = 0;
  private buildsLeft = 0;
  private deferred = false;
  private readonly visibility = new TileVisibility();

  constructor(private readonly shared: SharedUniforms, anisotropy: number, private readonly onChange: () => void) {
    this.photos = new TilePhotos(anisotropy, onChange);
  }

  /**
   * Choose the tiles to draw for this camera and start loading what is missing.
   * Returns true when another update is needed soon even if the camera stays still.
   */
  update(camera: PerspectiveCamera, viewportHeightPx: number) {
    this.stamp++;
    this.buildsLeft = GLOBAL_BUILDS_PER_UPDATE;
    this.deferred = false;
    this.visibility.observe(camera, viewportHeightPx, this.shared.uExaggeration.value);

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
    while (!this.shown.has(tile)) {
      const finer = tile.children?.find((child) => child.heights && child.containsPolar(x, y));
      if (!finer) break;
      tile = finer;
    }
    return tile.interpolateHeight(x, y);
  }

  setSites(sites: TileSite[]) {
    this.sites = sites;
    this.prefetch(sites);
    this.refreshSites();
  }

  /** Where the simulation's result grid lies, or null to hide it. The texture is shared. */
  setOverlay(overlay: TileOverlay | null) {
    this.overlay = overlay;
    this.refreshSites();
  }

  dispose() {
    for (const root of this.roots) this.release(root);
    this.photos.dispose();
  }

  private visit(tile: Tile) {
    tile.touched = this.stamp;
    if (!this.inView(tile)) return;
    this.load(tile);

    if (this.visibility.wantsDetail(tile)) {
      tile.children ??= this.subdivide(tile);
      if (this.childrenReady(tile.children)) {
        for (const child of tile.children) this.visit(child);
        return;
      }
    }

    if (tile.mesh) {
      tile.mesh.visible = true;
      this.showing.add(tile);
    }
  }

  /**
   * Whether every visible child can be drawn, loading the ones that cannot yet. Children replace
   * their parent only then, so the surface never shows a hole while finer tiles are loading.
   */
  private childrenReady(children: Tile[]) {
    let ready = true;

    for (const child of children) {
      child.touched = this.stamp;
      if (!this.inView(child)) continue;

      this.load(child);
      if (child.state !== "ready") ready = false;
    }
    return ready;
  }

  private subdivide(tile: Tile) {
    const children = [];

    for (const [down, right] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const child = new Tile(tile.grid, tile.level + 1, tile.row * 2 + down, tile.column * 2 + right, tile);
      if (child.inDomain) children.push(child);
    }
    return children;
  }

  private inView(tile: Tile) {
    return this.visibility.inView(tile, this.shared.uExaggeration.value);
  }

  private load(tile: Tile) {
    if (tile.state === "failed" && performance.now() - tile.failedAt > RETRY_AFTER_MS) tile.state = "idle";
    if (tile.state !== "idle") return;

    if (tile.grid === "global") {
      // A smooth-sphere tile needs no download, but building many in one frame would stutter.
      if (this.buildsLeft === 0) {
        this.deferred = true;
        return;
      }
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
    const { mesh, heights, lowestKm, highestKm } = createTileMesh(tile, heightsM, this.index, this.shared);
    this.group.add(mesh);

    tile.mesh = mesh;
    tile.heights = heights;
    if (heights) {
      tile.minHeightKm = lowestKm;
      tile.maxHeightKm = highestKm;
    }
    tile.state = "ready";

    this.built.add(tile);
    this.photos.request(tile);
    applySitesToTile(tile, this.sites, this.overlay);
  }

  private refreshSites() {
    for (const tile of this.built) applySitesToTile(tile, this.sites, this.overlay);
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
    this.shown.delete(tile);
    this.photos.release(tile);
    if (!tile.mesh) return;

    this.group.remove(tile.mesh);

    // The index buffer is shared; detach it so freeing this tile leaves it on the graphics card.
    tile.mesh.geometry.setIndex(null);
    tile.mesh.geometry.dispose();
    tile.mesh.material.dispose();
    tile.mesh = null;
  }
}
