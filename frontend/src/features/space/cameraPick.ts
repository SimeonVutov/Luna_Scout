import { Vector3 } from "three";
import type { PerspectiveCamera } from "three";
import { MOON_RADIUS_KM } from "./geodesy";

/** Terrain, exaggerated, never rises higher than this above the reference sphere. */
const MAX_RELIEF_KM = 40;
/** The ray is taken to have reached the ground when it is this close above it. */
const HIT_KM = 0.001;
/** Each step covers this share of the height above the ground: terrain slopes cannot outrun it. */
const STEP_SHARE = 0.3;
const MAX_STEPS = 600;
const REFINE_STEPS = 16;

const ray = new Vector3();
const point = new Vector3();
const unit = new Vector3();

/**
 * The unit direction of the ground under a screen position, or null when the position shows
 * space or looks away from the Moon. `groundKm` gives the drawn terrain's height above the
 * reference sphere at a unit direction.
 *
 * The ray is followed with sphere tracing: from the point where it enters a shell just above the
 * highest terrain, it moves forward by a share of its height above the ground, so it can never
 * step through a hill, and slows as it nears the surface.
 *   h = ‖p‖ − (R + g(p/‖p‖)); t ← t + k·h
 *   p - Point on the ray, Moon-centred, in km; R - sphere radius, in km.
 *   g - Terrain height above the sphere at p's direction, in km; h - Height above the ground, in km.
 *   t - Distance along the ray, in km; k (STEP_SHARE) - Step share, safe while terrain slopes stay
 *   below about 2 (a 3× exaggerated 35° slope).
 * Once the ray dips below the ground, the crossing is found by halving the last step.
 */
export function pickGround(
  camera: PerspectiveCamera,
  bounds: DOMRect,
  clientX: number,
  clientY: number,
  groundKm: (unit: Vector3) => number,
) {
  screenRay(camera, bounds, clientX, clientY);

  const origin = camera.position;
  const shell = MOON_RADIUS_KM + MAX_RELIEF_KM;
  let distance = 0;

  if (origin.lengthSq() > shell * shell) {
    // Ray–sphere intersection: t = −b − √(b² − (‖o‖² − r²)), b = o·v
    //   o - Camera position and v - unit ray direction, Moon-centred, in km; r - shell radius.
    const b = origin.dot(ray);
    const discriminant = b * b - (origin.lengthSq() - shell * shell);
    if (discriminant < 0) return null;

    distance = -b - Math.sqrt(discriminant);
    if (distance < 0) return null;
  }

  const heightAt = (t: number) => {
    point.copy(ray).multiplyScalar(t).add(origin);
    const radius = point.length();
    unit.copy(point).divideScalar(radius);
    return radius - (MOON_RADIUS_KM + groundKm(unit));
  };

  let previous = distance;
  for (let step = 0; step < MAX_STEPS; step++) {
    const height = heightAt(distance);

    if (height <= HIT_KM) return refine(heightAt, previous, distance);

    // Past the highest terrain and moving away from the Moon: the ray missed.
    if (point.length() > shell && point.dot(ray) > 0) return null;

    previous = distance;
    distance += Math.max(height * STEP_SHARE, HIT_KM);
  }
  return null;
}

/** The crossing between a point above the ground at `above` and one on or below it at `below`. */
function refine(heightAt: (t: number) => number, above: number, below: number) {
  let low = above;
  let high = below;

  for (let step = 0; step < REFINE_STEPS; step++) {
    const middle = (low + high) / 2;
    if (heightAt(middle) > HIT_KM) low = middle;
    else high = middle;
  }

  heightAt(high);
  return unit.clone();
}

/**
 * Set `ray` to the unit direction through a screen position.
 *
 * Ray direction: v ∝ x·h·a·ê + y·h·û − ẑ, in camera axes (ê right, û up, ẑ backward)
 *   x, y - Position on screen from −1 to 1, with y up; h - tan(φ/2) for vertical field of view φ.
 *   a - Aspect ratio (width/height); ê, û, ẑ - Columns of the camera's world rotation.
 */
function screenRay(camera: PerspectiveCamera, bounds: DOMRect, clientX: number, clientY: number) {
  const x = (clientX - bounds.left) / bounds.width * 2 - 1;
  const y = 1 - (clientY - bounds.top) / bounds.height * 2;
  const half = Math.tan(camera.fov * Math.PI / 360);

  const e = camera.matrixWorld.elements;
  ray.set(
    e[0] * x * half * camera.aspect + e[4] * y * half - e[8],
    e[1] * x * half * camera.aspect + e[5] * y * half - e[9],
    e[2] * x * half * camera.aspect + e[6] * y * half - e[10],
  ).normalize();
}
