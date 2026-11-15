import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from "three";
import { LoadQueue } from "./loadQueue";

/** One NASA Moon Trek photo layer: where its tiles are and how deep they go. */
export type ImageryLayer = {
  url: (level: number, row: number, column: number) => string;
  maxLevel: number;
};

const trek = "https://trek.nasa.gov/tiles/Moon";

/** LROC WAC mosaic of the south pole to 60°S, on the south-polar tile grid. */
export const polarBase: ImageryLayer = {
  url: (level, row, column) => `${trek}/SP/LRO_WAC_Mosaic_SPole60_100m_v02/1.0.0/default/default028mm/${level}/${row}/${column}.png`,
  maxLevel: 5,
};
/** LROC NAC mosaic inside 85.5°S, on the same grid. */
export const polarDetail: ImageryLayer = {
  url: (level, row, column) => `${trek}/SP/LRO_NAC_AvgMosaic_SPole855_1mp/1.0.0/default/default028mm/${level}/${row}/${column}.png`,
  maxLevel: 11,
};
/** LROC WAC global mosaic, on a longitude/latitude grid with two tiles at level 0. */
export const globalBase: ImageryLayer = {
  url: (level, row, column) => `${trek}/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/${level}/${row}/${column}.jpg`,
  maxLevel: 8,
};

export type ImageryEntry = {
  url: string;
  texture: Texture | null;
  failed: boolean;
  users: number;
  priority: number;
};

/**
 * Photo tiles shared between terrain tiles. A texture lives while at least one terrain tile
 * holds it, and is freed from the graphics card when the last one lets go.
 */
export class ImageryCache {
  private entries = new Map<string, ImageryEntry>();
  private queue = new LoadQueue(8);

  constructor(private readonly anisotropy: number, private readonly onLoad: () => void) {}

  /** A loaded texture for this address, if one is in memory. Does not start a download. */
  peek(url: string) {
    return this.entries.get(url)?.texture ?? null;
  }

  acquire(url: string, priority: number) {
    let entry = this.entries.get(url);
    if (entry) {
      entry.users++;
      entry.priority = Math.min(entry.priority, priority);
      return entry;
    }

    const created: ImageryEntry = { url, texture: null, failed: false, users: 1, priority };
    entry = created;
    this.entries.set(url, created);
    this.queue.add({
      get priority() { return created.priority; },
      stale: () => created.users === 0,
      dropped: () => { this.entries.delete(url); },
      run: () => this.load(created),
    });
    return entry;
  }

  release(entry: ImageryEntry) {
    entry.users--;
    if (entry.users > 0 || !entry.texture) return;
    entry.texture.dispose();
    this.entries.delete(entry.url);
  }

  private async load(entry: ImageryEntry) {
    try {
      const response = await fetch(entry.url, { mode: "cors" });
      if (!response.ok) throw new Error(`Imagery tile ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());

      const texture = new Texture(bitmap);
      // Image row 0 stays at v = 0, so tiles address their photo from the north edge down.
      texture.flipY = false;
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.anisotropy = this.anisotropy;
      texture.needsUpdate = true;
      if (entry.users === 0) {
        this.entries.delete(entry.url);
        bitmap.close();
        return;
      }
      entry.texture = texture;
    } catch {
      // Tiles outside a mosaic's coverage answer 404; the tile keeps its coarser photo.
      entry.failed = true;
    }
    this.onLoad();
  }

  dispose() {
    for (const entry of this.entries.values()) {
      entry.users = 0;
      entry.texture?.dispose();
    }
    this.entries.clear();
  }
}
