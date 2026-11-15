import type { Texture, Vector4 } from "three";
import { ImageryCache, globalBase, polarBase, polarDetail } from "./imagery";
import type { ImageryLayer } from "./imagery";
import type { PhotoSlot, Tile } from "./tile";
import { DETAIL_RADIUS_KM } from "./terrainMaterial";

/** The sharp NAC mosaic joins the base photo from this level, as on the 2D map. */
const DETAIL_FROM_LEVEL = 5;
/** Below this level the sharp photo is blended in at partial strength. */
const FULL_DETAIL_LEVEL = 6;

/**
 * Chooses and applies the NASA photos of tiles. A tile asks for its own photo and shows the
 * matching part of a coarser ancestor's photo until its own has loaded.
 */
export class TilePhotos {
  private readonly cache: ImageryCache;
  /** Tiles still showing a coarser photo than the one they asked for. */
  private readonly waiting = new Set<Tile>();

  constructor(anisotropy: number, onChange: () => void) {
    this.cache = new ImageryCache(anisotropy, () => {
      this.refreshWaiting();
      onChange();
    });
  }

  /** Ask for the photos a tile needs and show whatever is already in memory. */
  request(tile: Tile) {
    tile.base = this.slotFor(tile, tile.grid === "polar" ? polarBase : globalBase);

    if (tile.grid === "polar" && tile.level >= DETAIL_FROM_LEVEL && tile.nearestToPoleKm < DETAIL_RADIUS_KM) {
      tile.detail = this.slotFor(tile, polarDetail);
    }

    this.waiting.add(tile);
    this.place(tile);
  }

  /** Let go of a tile's photos; they are freed once no tile uses them. */
  release(tile: Tile) {
    this.waiting.delete(tile);
    if (tile.base) this.cache.release(tile.base.entry);
    if (tile.detail) this.cache.release(tile.detail.entry);
  }

  dispose() {
    this.cache.dispose();
  }

  private slotFor(tile: Tile, layer: ImageryLayer): PhotoSlot {
    const level = Math.min(tile.level, layer.maxLevel);
    const shift = tile.level - level;
    const entry = this.cache.acquire(layer.url(level, tile.row >> shift, tile.column >> shift), tile.distanceKm);
    return { layer, level, entry, settled: false };
  }

  private refreshWaiting() {
    for (const tile of this.waiting) this.place(tile);
  }

  /**
   * Point the tile's material at the best photo in memory for each layer: its own once
   * loaded, and until then the part of an ancestor's photo that covers the tile.
   */
  private place(tile: Tile) {
    const uniforms = tile.mesh!.material.uniforms;

    if (tile.base) {
      uniforms.uHasBase.value = this.show(tile, tile.base, uniforms.uBase, uniforms.uBaseUv) ? 1 : 0;
      tile.base.settled ||= tile.base.entry.failed;
    }

    if (tile.detail) {
      const shown = this.show(tile, tile.detail, uniforms.uDetail, uniforms.uDetailUv);
      uniforms.uDetailMix.value = shown ? (tile.level >= FULL_DETAIL_LEVEL ? 1 : 0.6) : 0;
      tile.detail.settled ||= tile.detail.entry.failed;
    }

    const baseDone = tile.base?.settled ?? true;
    const detailDone = tile.detail?.settled ?? true;
    if (baseDone && detailDone) this.waiting.delete(tile);
  }

  /** Show the best available photo of a slot; returns whether any photo was found. */
  private show(tile: Tile, slot: PhotoSlot, sampler: { value: Texture | null }, address: { value: Vector4 }) {
    for (let level = slot.level; level >= 0; level--) {
      const shift = tile.level - level;
      const own = level === slot.level;
      const texture = own ? slot.entry.texture : this.cache.peek(slot.layer.url(level, tile.row >> shift, tile.column >> shift));
      if (!texture) continue;

      // Sub-rectangle of a coarser photo: scale = 2^(−shift); offset = (index mod 2^shift)·scale
      //   shift - Levels between the tile and the photo, dimensionless.
      //   scale - Share of the photo's width and height that the tile covers.
      //   offset - Where the tile's part starts in the photo, as a share of its width and height.
      const scale = 1 / 2 ** shift;
      const offsetX = (tile.column - ((tile.column >> shift) << shift)) * scale;
      const offsetY = (tile.row - ((tile.row >> shift) << shift)) * scale;

      sampler.value = texture;
      address.value.set(offsetX, offsetY, scale, scale);
      slot.settled = own;
      return true;
    }
    return false;
  }
}
