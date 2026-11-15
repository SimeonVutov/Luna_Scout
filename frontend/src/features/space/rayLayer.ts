import { BufferAttribute, BufferGeometry, Color, Group, LineBasicMaterial, LineSegments, Points, PointsMaterial, Vector3 } from "three";
import type { Scene } from "three";
import type { RayFan } from "../../api/types";
import { MOON_RADIUS_KM } from "./geodesy";
import type { ShownRays } from "./useSiteRays";

/** Each body has its own colour for clear rays and for rays terrain cuts off. */
export const rayColours = {
  sun: "#ffd76a", sunBlocked: "#ff5a36",
  earth: "#5fb8ff", earthBlocked: "#c45bff",
  unknown: "#9aa3ad",
} as const;

/** Distances along a clear ray where its drawn line is split, in km. */
const CLEAR_RAY_STOPS_KM = [5, 500];

/**
 * A clear ray is drawn only this far. It leaves the Moon, crosses some space and stops: the
 * Sun and Earth are millions of kilometres away, and drawing all of it only costs time.
 */
const RAY_DRAW_LENGTH_KM = 4000;

/** Length of the short stub drawn for a ray whose blocking point is not known, in km. */
const UNLOCATED_BLOCKED_STUB_KM = 1.5;
const UNRESOLVED_STUB_KM = 25;

/** Rays from many points overlap, so each is drawn fainter than a lone fan. */
const SINGLE_FAN_OPACITY = 0.9;
const CROWDED_FAN_OPACITY = 0.55;

export type RayToggles = { sun: boolean; earth: boolean };

/** The line segments, blocking points and colours of one fan, relative to its instrument. */
type FanSegments = { positions: number[]; colours: number[]; blockingPoints: number[] };

type FanPalette = { clear: Color; blocked: Color; unresolved: Color };

/** The Sun and Earth rays drawn over the terrain, rebuilt whenever the rays or the relief change. */
export class RayLayer {
  private fans: Group[] = [];

  constructor(private readonly scene: Scene) {}

  update(rays: ShownRays | null, show: RayToggles, exaggeration: number) {
    this.clear();
    if (!rays) return;

    if (show.sun) this.add(rays.sun, rayColours.sun, rayColours.sunBlocked, exaggeration);
    if (show.earth) this.add(rays.earth, rayColours.earth, rayColours.earthBlocked, exaggeration);
  }

  dispose() {
    this.clear();
  }

  private add(fans: RayFan[], clearColour: string, blockedColour: string, exaggeration: number) {
    const opacity = fans.length > 1 ? CROWDED_FAN_OPACITY : SINGLE_FAN_OPACITY;

    for (const fan of fans) {
      const group = drawFan(fan, clearColour, blockedColour, exaggeration, opacity);
      this.fans.push(group);
      this.scene.add(group);
    }
  }

  private clear() {
    for (const group of this.fans) disposeFan(group);
    this.fans = [];
  }
}

/**
 * A point with its height above the reference sphere scaled by `exaggeration`.
 *
 * Exaggerated radius: p′ = p·(R + k(‖p‖ − R))/‖p‖
 *   p - Moon-centred point, in km; p′ - the same point with the relief scaled.
 *   R (MOON_RADIUS_KM) - Reference sphere radius, in km; k - vertical exaggeration.
 */
function exaggerate(point: Vector3, exaggeration: number) {
  const radius = point.length();
  return point.multiplyScalar((MOON_RADIUS_KM + (radius - MOON_RADIUS_KM) * exaggeration) / radius);
}

/**
 * The simulation's rays from one instrument to a body's disk. A clear ray runs toward the body;
 * a blocked ray stops, with a dot, at the terrain that blocks it.
 */
function drawFan(fan: RayFan, clearColour: string, blockedColour: string, exaggeration: number, opacity: number) {
  const origin = new Vector3(...fan.origin_m).divideScalar(1000);
  const shownOrigin = exaggerate(origin.clone(), exaggeration);
  const palette: FanPalette = {
    clear: new Color(clearColour),
    blocked: new Color(blockedColour),
    unresolved: new Color(rayColours.unknown),
  };

  const segments = collectSegments(fan, palette, origin, shownOrigin, exaggeration);
  const group = new Group();

  // Vertices are relative to the instrument, which keeps them exact at lunar-radius distances.
  group.position.copy(shownOrigin);
  group.add(new LineSegments(
    pointGeometry(segments.positions, segments.colours),
    new LineBasicMaterial({ vertexColors: true, transparent: true, opacity }),
  ));
  group.add(new Points(pointGeometry(segments.blockingPoints), new PointsMaterial({ color: blockedColour, size: 6, sizeAttenuation: false })));
  group.add(new Points(pointGeometry([0, 0, 0]), new PointsMaterial({ color: "#ffffff", size: 7, sizeAttenuation: false })));

  for (const child of group.children) child.frustumCulled = false;
  return group;
}

function collectSegments(fan: RayFan, palette: FanPalette, origin: Vector3, shownOrigin: Vector3, exaggeration: number): FanSegments {
  const segments: FanSegments = { positions: [], colours: [], blockingPoints: [] };
  const bodyDistanceKm = Math.min(RAY_DRAW_LENGTH_KM, new Vector3(...fan.body_m).divideScalar(1000).distanceTo(origin));
  const direction = new Vector3();

  fan.directions.forEach((components, index) => {
    const status = fan.statuses[index];
    const hitM = fan.hit_distances_m[index];
    direction.set(...components);

    if (status === "clear") {
      addClearRay(segments, direction, palette.clear, origin.clone().sub(shownOrigin), bodyDistanceKm);
    } else if (status === "blocked" && hitM !== null) {
      // The blocking point is raised with the terrain, so the ray ends on the drawn ridge.
      const end = exaggerate(direction.multiplyScalar(hitM / 1000).add(origin), exaggeration).sub(shownOrigin);
      segments.blockingPoints.push(end.x, end.y, end.z);
      addSegment(segments, new Vector3(), end, palette.blocked);
    } else {
      // No blocking point is known: draw a short stub in the ray's direction.
      const blocked = status === "blocked";
      const stub = direction.multiplyScalar(blocked ? UNLOCATED_BLOCKED_STUB_KM : UNRESOLVED_STUB_KM);
      addSegment(segments, new Vector3(), stub, blocked ? palette.blocked : palette.unresolved);
    }
  });
  return segments;
}

/**
 * A clear ray reaches the body. It is drawn in pieces of growing length, because one line from
 * a few metres to millions of kilometres loses its near end to rounding when drawn.
 */
function addClearRay(segments: FanSegments, direction: Vector3, colour: Color, start: Vector3, lengthKm: number) {
  const stops = [...CLEAR_RAY_STOPS_KM.filter((stop) => stop < lengthKm), lengthKm];
  let from = start;

  for (const stop of stops) {
    const to = start.clone().addScaledVector(direction, stop);
    addSegment(segments, from, to, colour);
    from = to;
  }
}

function addSegment(segments: FanSegments, from: Vector3, to: Vector3, colour: Color) {
  segments.positions.push(from.x, from.y, from.z, to.x, to.y, to.z);
  segments.colours.push(colour.r, colour.g, colour.b, colour.r, colour.g, colour.b);
}

function pointGeometry(positions: number[], colours?: number[]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  if (colours) geometry.setAttribute("color", new BufferAttribute(new Float32Array(colours), 3));
  return geometry;
}

function disposeFan(group: Group) {
  for (const child of group.children as (LineSegments | Points)[]) {
    child.geometry.dispose();
    (child.material as LineBasicMaterial | PointsMaterial).dispose();
  }
  group.removeFromParent();
}
