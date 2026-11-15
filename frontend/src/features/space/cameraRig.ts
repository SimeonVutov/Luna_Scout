import { Matrix4, Quaternion, Vector3 } from "three";
import type { PerspectiveCamera } from "three";
import { MOON_RADIUS_KM, unitToLatLon } from "./geodesy";

const ORBIT_FOV_DEG = 45;
const STAND_FOV_DEG = 60;
const MIN_DISTANCE_KM = 0.03;
const MAX_DISTANCE_KM = 40_000;
const MAX_TILT = 1.55;
const MAX_PITCH = 1.45;
const FLIGHT_MS = 900;

export type RigMode = "orbit" | "stand";

export type RigView = {
  mode: RigMode;
  /** Camera height above the terrain below it, in km. */
  altitudeKm: number;
  /** The ground point in focus (orbit) or under the observer (stand). */
  latitude: number;
  longitude: number;
  /** Clockwise screen angle of north in degrees, or null at a pole. */
  northAngleDeg: number | null;
  /** Stand mode: compass bearing and elevation of the view direction, in degrees. */
  bearingDeg: number | null;
  pitchDeg: number;
};

export type Destination = {
  up: Vector3;
  /** Ground direction that should point up the screen; kept from the current view if absent. */
  forward?: Vector3;
  distanceKm: number;
  tilt: number;
};

type Flight = {
  startedAt: number;
  from: Quaternion;
  to: Quaternion;
  fromDistanceKm: number;
  toDistanceKm: number;
  fromTilt: number;
  toTilt: number;
  then?: () => void;
};

/**
 * Moves the camera around a Moon that never turns: the view stays attached to the ground and
 * the Sun and Earth move in the sky, so playing the timeline does not spin the scene.
 *
 * Orbit mode looks at a ground point from a distance: drag moves that point, right-drag turns
 * and tilts, the wheel zooms toward the cursor. Stand mode puts the eye above a ground point:
 * drag looks around, the wheel narrows the field of view.
 */
export class CameraRig {
  mode: RigMode = "orbit";
  /** Unit direction of the ground point in focus, and the unit ground direction up the screen. */
  readonly up = new Vector3(0, 0, -1);
  readonly forward = new Vector3(1, 0, 0);
  distanceKm = 9000;
  /** Orbit: 0 looks straight down, larger looks toward the horizon. Radians. */
  tilt = 0;
  /** Stand: view elevation above the level plane, radians, and the eye height in km. */
  pitch = 0;
  eyeHeightKm = 0.002;

  private flight: Flight | null = null;
  private drag: { pointer: number; x: number; y: number; turning: boolean } | null = null;
  private readonly right = new Vector3();
  private readonly target = new Vector3();
  private readonly scratch = new Vector3();
  private readonly scratch2 = new Vector3();
  private readonly basis = new Matrix4();
  private readonly frame = new Quaternion();
  private readonly cleanup: () => void;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly element: HTMLElement,
    /** Terrain height above the reference sphere at a unit direction, in rendered km. */
    private readonly groundKm: (unit: Vector3) => number,
    private readonly onChange: () => void,
  ) {
    camera.fov = ORBIT_FOV_DEG;
    const down = (event: PointerEvent) => this.pointerDown(event);
    const move = (event: PointerEvent) => this.pointerMove(event);
    const release = (event: PointerEvent) => { if (this.drag?.pointer === event.pointerId) this.drag = null; };
    const wheel = (event: WheelEvent) => this.wheel(event);
    const double = (event: MouseEvent) => this.doubleClick(event);
    const key = (event: KeyboardEvent) => this.key(event);
    const menu = (event: Event) => event.preventDefault();
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", release);
    element.addEventListener("pointercancel", release);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("dblclick", double);
    element.addEventListener("keydown", key);
    element.addEventListener("contextmenu", menu);
    this.cleanup = () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", release);
      element.removeEventListener("pointercancel", release);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("dblclick", double);
      element.removeEventListener("keydown", key);
      element.removeEventListener("contextmenu", menu);
    };
  }

  dispose() {
    this.cleanup();
  }

  get flying() {
    return this.flight !== null;
  }

  /** Glide to a new orbit view. `then` runs on arrival. */
  flyTo(destination: Destination, then?: () => void) {
    this.mode = "orbit";
    this.camera.fov = ORBIT_FOV_DEG;
    this.camera.updateProjectionMatrix();
    const from = this.frameOf(this.up, this.forward, new Quaternion());

    // Without a requested heading, carry the current one along the shortest turn to the new point.
    const up = destination.up.clone().normalize();
    const forward = destination.forward?.clone()
      ?? this.forward.clone().applyQuaternion(new Quaternion().setFromUnitVectors(this.up, up));
    this.flight = {
      startedAt: performance.now(),
      from,
      to: this.frameOf(up, forward, new Quaternion()),
      fromDistanceKm: this.distanceKm,
      toDistanceKm: destination.distanceKm,
      fromTilt: this.tilt,
      toTilt: destination.tilt,
      then,
    };
    this.onChange();
  }

  /** Stand on the ground at `up`, gliding there first. */
  standAt(up: Vector3) {
    this.flyTo({ up, distanceKm: 0.06, tilt: 1.5 }, () => {
      this.mode = "stand";
      this.pitch = 0;
      this.camera.fov = STAND_FOV_DEG;
      this.camera.updateProjectionMatrix();
    });
  }

  /** Leave stand mode and rise to a view of the surroundings. */
  leaveStand() {
    this.distanceKm = 0.06;
    this.tilt = 1.5;
    this.flyTo({ up: this.up, distanceKm: 4, tilt: 1.05 });
  }

  /** Turn toward a direction in space, such as the Sun or Earth. */
  faceToward(direction: Vector3) {
    const level = this.scratch.copy(direction).addScaledVector(this.up, -direction.dot(this.up));
    if (level.lengthSq() < 1e-12) return;
    this.flight = null;
    this.forward.copy(level).normalize();
    if (this.mode === "stand") {
      const elevation = Math.asin(Math.max(-1, Math.min(1, direction.clone().normalize().dot(this.up))));
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, elevation));
    } else if (this.distanceKm < 300) {
      this.tilt = Math.max(this.tilt, 1.4);
    }
    this.onChange();
  }

  /** Advance a flight in progress. Returns true while the camera is still moving by itself. */
  advance(now: number) {
    const flight = this.flight;
    if (!flight) return false;

    const progress = Math.min(1, (now - flight.startedAt) / FLIGHT_MS);
    // Ease in and out: e = 3p² − 2p³.
    const eased = progress * progress * (3 - 2 * progress);
    this.frame.slerpQuaternions(flight.from, flight.to, eased);
    this.up.set(0, 0, 1).applyQuaternion(this.frame);
    this.forward.set(0, 1, 0).applyQuaternion(this.frame);
    // Distances span many orders of magnitude, so they are interpolated as logarithms.
    this.distanceKm = Math.exp(Math.log(flight.fromDistanceKm) + (Math.log(flight.toDistanceKm) - Math.log(flight.fromDistanceKm)) * eased);
    this.tilt = flight.fromTilt + (flight.toTilt - flight.fromTilt) * eased;
    if (progress < 1) return true;

    this.flight = null;
    flight.then?.();
    return false;
  }

  /** Place the camera from the current state and report where it is. */
  apply(): RigView {
    this.forward.addScaledVector(this.up, -this.forward.dot(this.up)).normalize();
    this.right.crossVectors(this.forward, this.up);
    const camera = this.camera;
    const ground = MOON_RADIUS_KM + this.groundKm(this.up);

    if (this.mode === "stand") {
      camera.position.copy(this.up).multiplyScalar(ground + this.eyeHeightKm);
      // View direction: v = cos(p)·f + sin(p)·u, with pitch p above the level plane.
      this.target.copy(camera.position)
        .addScaledVector(this.forward, Math.cos(this.pitch))
        .addScaledVector(this.up, Math.sin(this.pitch));
      camera.up.copy(this.up);
    } else {
      // Orbit position: c = g + d·(cos(τ)·u − sin(τ)·f)
      //   g - Ground point in focus; d - distance; τ - tilt from straight down;
      //   u, f - unit up and forward directions at the ground point.
      this.target.copy(this.up).multiplyScalar(ground);
      camera.position.copy(this.target)
        .addScaledVector(this.up, this.distanceKm * Math.cos(this.tilt))
        .addScaledVector(this.forward, -this.distanceKm * Math.sin(this.tilt));
      // Keep the camera above the terrain beneath it, however the view is tilted.
      const below = this.scratch.copy(camera.position).normalize();
      const floor = MOON_RADIUS_KM + this.groundKm(below) + Math.max(0.003, this.distanceKm * 0.02);
      if (camera.position.length() < floor) camera.position.setLength(floor);
      camera.up.copy(this.forward).multiplyScalar(Math.cos(this.tilt)).addScaledVector(this.up, Math.sin(this.tilt));
    }
    camera.lookAt(this.target);

    const below = this.scratch.copy(camera.position).normalize();
    const altitudeKm = camera.position.length() - MOON_RADIUS_KM - this.groundKm(below);
    // The closest thing in view is the ground below, so the near plane can follow the altitude.
    camera.near = Math.max(1e-4, Math.min(100, altitudeKm * 0.2));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // North along the ground: n = ẑ − (ẑ·u)u, undefined at the poles.
    const north = this.scratch2.set(0, 0, 1).addScaledVector(this.up, -this.up.z);
    const hasNorth = north.lengthSq() > 1e-10;
    const northAngle = Math.atan2(north.dot(this.right), north.dot(this.forward)) * 180 / Math.PI;
    return {
      mode: this.mode,
      altitudeKm,
      ...unitToLatLon(this.up),
      northAngleDeg: hasNorth ? northAngle : null,
      bearingDeg: hasNorth ? (360 - northAngle) % 360 : null,
      pitchDeg: this.pitch * 180 / Math.PI,
    };
  }

  /** The unit direction of the ground under a screen point, or null when it shows space. */
  pick(clientX: number, clientY: number) {
    const bounds = this.element.getBoundingClientRect();
    const x = (clientX - bounds.left) / bounds.width * 2 - 1;
    const y = 1 - (clientY - bounds.top) / bounds.height * 2;
    const half = Math.tan(this.camera.fov * Math.PI / 360);
    const elements = this.camera.matrixWorld.elements;
    const ray = this.scratch.set(
      elements[0] * x * half * this.camera.aspect + elements[4] * y * half - elements[8],
      elements[1] * x * half * this.camera.aspect + elements[5] * y * half - elements[9],
      elements[2] * x * half * this.camera.aspect + elements[6] * y * half - elements[10],
    ).normalize();

    // Ray–sphere intersection at the focus point's radius: t = −b − √(b² − (‖o‖² − r²)), b = o·v.
    const origin = this.camera.position;
    const radius = MOON_RADIUS_KM + this.groundKm(this.up);
    const b = origin.dot(ray);
    const discriminant = b * b - (origin.lengthSq() - radius * radius);
    if (discriminant < 0) return null;
    const distance = -b - Math.sqrt(discriminant);
    return distance > 0 ? ray.multiplyScalar(distance).add(origin).normalize().clone() : null;
  }

  private frameOf(up: Vector3, forward: Vector3, out: Quaternion) {
    const levelled = forward.clone().addScaledVector(up, -forward.dot(up)).normalize();
    this.basis.makeBasis(new Vector3().crossVectors(levelled, up), levelled, up);
    return out.setFromRotationMatrix(this.basis);
  }

  private pointerDown(event: PointerEvent) {
    this.element.setPointerCapture(event.pointerId);
    this.element.focus({ preventScroll: true });
    this.flight = null;
    this.drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, turning: event.button !== 0 || event.ctrlKey || event.shiftKey };
  }

  private pointerMove(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!dx && !dy) return;

    if (this.mode === "stand") {
      // Looking around: the scene follows the pointer, scaled so a point stays under it.
      const perPixel = this.camera.fov * Math.PI / 180 / this.element.clientHeight;
      this.forward.applyAxisAngle(this.up, dx * perPixel);
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + dy * perPixel));
    } else if (drag.turning) {
      this.forward.applyAxisAngle(this.up, dx * 0.005);
      this.tilt = Math.max(0, Math.min(MAX_TILT, this.tilt - dy * 0.005));
    } else {
      this.pan(dx, dy);
    }
    this.onChange();
  }

  /** Move the focus point so the ground follows the pointer by `dx`, `dy` pixels. */
  private pan(dx: number, dy: number) {
    // Ground angle per pixel: α = d·2·tan(fov/2)/(H·R), limited so the far view stays controllable.
    const kmPerPixel = this.distanceKm * 2 * Math.tan(this.camera.fov * Math.PI / 360) / this.element.clientHeight;
    const perPixel = Math.min(kmPerPixel / MOON_RADIUS_KM, 0.0045);
    this.right.crossVectors(this.forward, this.up);
    const aboutForward = this.scratch.copy(this.forward);
    this.up.applyAxisAngle(aboutForward, -dx * perPixel);
    const aboutRight = this.scratch.crossVectors(this.forward, this.up).negate().normalize();
    this.up.applyAxisAngle(aboutRight, dy * perPixel).normalize();
    this.forward.applyAxisAngle(aboutRight, dy * perPixel);
  }

  private wheel(event: WheelEvent) {
    event.preventDefault();
    this.flight = null;
    const scroll = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
    if (this.mode === "stand") {
      this.camera.fov = Math.max(8, Math.min(90, this.camera.fov * Math.exp(scroll * 0.0012)));
      this.camera.updateProjectionMatrix();
      this.onChange();
      return;
    }

    const before = this.distanceKm;
    this.distanceKm = Math.max(MIN_DISTANCE_KM, Math.min(MAX_DISTANCE_KM, before * Math.exp(scroll * 0.0012)));
    // Zooming in pulls the focus toward the ground under the pointer, keeping it in place.
    const under = this.distanceKm < before ? this.pick(event.clientX, event.clientY) : null;
    if (under) {
      const turn = new Quaternion().slerpQuaternions(new Quaternion(), new Quaternion().setFromUnitVectors(this.up, under), 1 - this.distanceKm / before);
      this.up.applyQuaternion(turn).normalize();
      this.forward.applyQuaternion(turn);
    }
    this.onChange();
  }

  private doubleClick(event: MouseEvent) {
    if (this.mode !== "orbit") return;
    const under = this.pick(event.clientX, event.clientY);
    if (under) this.flyTo({ up: under, distanceKm: Math.max(MIN_DISTANCE_KM, this.distanceKm / 2.5), tilt: this.tilt });
  }

  private key(event: KeyboardEvent) {
    const step = event.shiftKey ? 120 : 40;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const move = moves[event.key];
    if (move && this.mode === "orbit") this.pan(...move);
    else if (move) this.forward.applyAxisAngle(this.up, move[0] * 0.003);
    else if (event.key === "+" || event.key === "=") this.distanceKm = Math.max(MIN_DISTANCE_KM, this.distanceKm / 1.3);
    else if (event.key === "-") this.distanceKm = Math.min(MAX_DISTANCE_KM, this.distanceKm * 1.3);
    else return;
    event.preventDefault();
    this.flight = null;
    this.onChange();
  }
}
