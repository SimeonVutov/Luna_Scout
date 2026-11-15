import { Frustum, Matrix4, Sphere, Vector3 } from "three";
import type { PerspectiveCamera } from "three";
import { MOON_RADIUS_KM } from "./geodesy";
import type { Tile } from "./tile";

/** A tile is replaced by its four children once it covers more than this many screen pixels. */
const TILE_PIXELS = 560;
/** Terrain never rises or falls more than this from the reference sphere, in km. */
const TERRAIN_BELOW_KM = 10;
const TERRAIN_ABOVE_KM = 8;
/** A tile's horizon test is widened by this much around its corners. */
const HORIZON_TILE_MARGIN = 1.1;

/** What a camera can see of the Moon, for deciding which tiles to draw and how finely. */
export class TileVisibility {
  private readonly frustum = new Frustum();
  private readonly matrix = new Matrix4();
  private readonly sphere = new Sphere();
  private readonly cameraPosition = new Vector3();
  private readonly cameraUnit = new Vector3();
  private pixelsPerRadian = 1000;
  private horizonAngle = Math.PI;

  /** Record the camera for the tests of this update. `exaggeration` is the relief scale. */
  observe(camera: PerspectiveCamera, viewportHeightPx: number, exaggeration: number) {
    this.cameraPosition.copy(camera.position);
    this.cameraUnit.copy(camera.position).normalize();
    this.frustum.setFromProjectionMatrix(this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

    // Pixels per radian: p = H / (2·tan(φ/2))
    //   p - Screen pixels one radian of view spans, near the screen centre.
    //   H - Viewport height, in pixels; φ - vertical field of view, in radians.
    this.pixelsPerRadian = viewportHeightPx / (2 * Math.tan(camera.fov * Math.PI / 360));

    // Horizon limit: γ_max = acos(R₋/d) + acos(R₋/R₊)
    //   γ_max - Largest angle from the camera's nadir at which terrain can still be seen.
    //   d - Camera distance from the Moon's centre; R₋ - a radius below all terrain;
    //   R₊ - a radius above all terrain, allowing for exaggeration. All in km.
    const below = MOON_RADIUS_KM - TERRAIN_BELOW_KM;
    const above = MOON_RADIUS_KM + TERRAIN_ABOVE_KM * exaggeration;
    this.horizonAngle = Math.acos(Math.min(1, below / camera.position.length())) + Math.acos(below / above);
  }

  /** Whether the tile can be seen, also noting its distance from the camera. */
  inView(tile: Tile, exaggeration: number) {
    const angle = Math.acos(Math.max(-1, Math.min(1, tile.unit.dot(this.cameraUnit))));
    if (angle - HORIZON_TILE_MARGIN * tile.cornerRadiusKm / MOON_RADIUS_KM > this.horizonAngle) return false;

    // Bounding sphere around the tile's relief at the current exaggeration.
    const [lowest, highest] = tile.heightRange();
    const middle = (lowest + highest) / 2 * exaggeration;

    this.sphere.center.copy(tile.unit).multiplyScalar(MOON_RADIUS_KM + middle);
    this.sphere.radius = tile.cornerRadiusKm + (highest - lowest) / 2 * exaggeration + 0.01;
    tile.distanceKm = Math.max(1e-3, this.sphere.center.distanceTo(this.cameraPosition) - this.sphere.radius);

    return this.frustum.intersectsSphere(this.sphere);
  }

  /** Whether the tile covers enough of the screen to be replaced by its finer children. */
  wantsDetail(tile: Tile) {
    if (tile.level >= tile.maxLevel) return false;

    // Screen size: s = (w/d)·p
    //   s - Approximate width of the tile on screen, in pixels.
    //   w - Ground width of the tile, in km; d - its distance from the camera, in km.
    //   p - Pixels per radian of view.
    //   Assumption: small-angle approximation, accurate for tiles well inside the view.
    return tile.widthKm / tile.distanceKm * this.pixelsPerRadian > TILE_PIXELS;
  }
}
