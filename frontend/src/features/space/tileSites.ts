import { Vector3 } from "three";
import type { Vector4 } from "three";
import { RING_LIMIT } from "./terrainMaterial";
import type { Tile } from "./tile";

/** A saved site as the terrain needs it: a circle to draw on the ground. */
export type TileSite = { centre: Vector3; radiusKm: number; selected: boolean };

/** The simulation's result grid draped on the ground: where it is centred and how far it reaches. */
export type TileOverlay = { centre: Vector3; halfKm: number };

/** Slack so a ring just beyond a tile's edge is still drawn across it. */
const RING_MARGIN = 1.1;
const offset = new Vector3();

/** Give a tile the site circles and the result grid that fall on it. */
export function applySitesToTile(tile: Tile, sites: TileSite[], overlay: TileOverlay | null) {
  const uniforms = tile.mesh!.material.uniforms;
  const rings = uniforms.uRings.value as Vector4[];

  let count = 0;
  let selected = -1;
  for (const site of sites) {
    if (count === RING_LIMIT) break;
    if (site.centre.distanceTo(tile.centre) > tile.cornerRadiusKm + site.radiusKm * RING_MARGIN) continue;

    offset.subVectors(site.centre, tile.centre);
    rings[count].set(offset.x, offset.y, offset.z, site.radiusKm);
    if (site.selected) selected = count;
    count++;
  }
  uniforms.uRingCount.value = count;
  uniforms.uSelectedRing.value = selected;

  const covered = overlay !== null && overlay.centre.distanceTo(tile.centre) < tile.cornerRadiusKm + overlay.halfKm * Math.SQRT2;
  uniforms.uOverlayOn.value = covered ? 1 : 0;
  if (covered) (uniforms.uOverlayOffset.value as Vector3).subVectors(overlay.centre, tile.centre);
}
