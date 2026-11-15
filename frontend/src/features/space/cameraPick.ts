import { Vector3 } from "three";
import type { PerspectiveCamera } from "three";

const ray = new Vector3();

/**
 * The unit direction of the point where a screen position meets a sphere of radius `radiusKm`
 * around the Moon's centre, or null when the position shows space or looks away from it.
 *
 * Ray direction: v ∝ x·h·a·ê + y·h·û − ẑ, in camera axes (ê right, û up, ẑ backward)
 *   x, y - Position on screen from −1 to 1, with y up; h - tan(φ/2) for vertical field of view φ.
 *   a - Aspect ratio (width/height); ê, û, ẑ - Columns of the camera's world rotation.
 * Ray–sphere intersection: t = −b − √(b² − (‖o‖² − r²)), b = o·v
 *   o - Camera position and v - unit ray direction, Moon-centred, in km; r - sphere radius, in km.
 *   t - Distance along the ray to the near intersection; none exists when the root is imaginary.
 */
export function pickSphere(camera: PerspectiveCamera, bounds: DOMRect, clientX: number, clientY: number, radiusKm: number) {
  const x = (clientX - bounds.left) / bounds.width * 2 - 1;
  const y = 1 - (clientY - bounds.top) / bounds.height * 2;
  const half = Math.tan(camera.fov * Math.PI / 360);

  const e = camera.matrixWorld.elements;
  ray.set(
    e[0] * x * half * camera.aspect + e[4] * y * half - e[8],
    e[1] * x * half * camera.aspect + e[5] * y * half - e[9],
    e[2] * x * half * camera.aspect + e[6] * y * half - e[10],
  ).normalize();

  const origin = camera.position;
  const b = origin.dot(ray);
  const discriminant = b * b - (origin.lengthSq() - radiusKm * radiusKm);
  if (discriminant < 0) return null;

  const distance = -b - Math.sqrt(discriminant);
  return distance > 0 ? ray.multiplyScalar(distance).add(origin).normalize().clone() : null;
}
