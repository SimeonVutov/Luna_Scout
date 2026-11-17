import { Quaternion, Vector3 } from "three";
import type { PerspectiveCamera } from "three";
import { attachCameraInput } from "./cameraInput";
import { groundFrame, sampleFlight, startFlight } from "./cameraFlight";
import { pickGround } from "./cameraPick";
import type { Flight, FlightPose } from "./cameraFlight";
import { MOON_RADIUS_KM, unitToLatLon } from "./geodesy";

const ORBIT_FOV_DEG = 45;
const STAND_FOV_DEG = 60;
const MIN_DISTANCE_KM = 0.03;
const MAX_DISTANCE_KM = 40_000;
const MAX_TILT = 1.55;
const MAX_PITCH = 1.45;
/** Radians the view turns per pixel of a right-drag. */
const TURN_PER_PIXEL = 0.005;
/** Radians the view turns per pixel of an arrow-key nudge in stand mode. */
const LOOK_PER_NUDGE_PX = 0.003;
/** Upper limit on how far the ground moves per pixel while panning, in radians. */
const MAX_PAN_PER_PIXEL = 0.0045;
/** How strongly the wheel zooms: the distance or field of view scales by exp(k·scroll). */
const ZOOM_PER_SCROLL_PX = 0.0012;

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
  private readonly right = new Vector3();
  private readonly target = new Vector3();
  private readonly scratch = new Vector3();
  private readonly scratch2 = new Vector3();
  private readonly flightPose: FlightPose = { frame: new Quaternion(), distanceKm: 0, tilt: 0 };
  private readonly stopInput: () => void;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly element: HTMLElement,
    /** Terrain height above the reference sphere at a unit direction, in rendered km. */
    private readonly groundKm: (unit: Vector3) => number,
    private readonly onChange: () => void,
  ) {
    camera.fov = ORBIT_FOV_DEG;
    this.stopInput = attachCameraInput(element, this);
  }

  dispose() {
    this.stopInput();
  }

  /** Cancel a flight in progress, such as when the user takes over. */
  interrupt() {
    this.flight = null;
  }

  /** Glide to a new orbit view. `then` runs on arrival. */
  flyTo(destination: Destination, then?: () => void) {
    this.mode = "orbit";
    this.camera.fov = ORBIT_FOV_DEG;
    this.camera.updateProjectionMatrix();
    const from = { frame: groundFrame(this.up, this.forward, new Quaternion()), distanceKm: this.distanceKm, tilt: this.tilt };

    // Without a requested heading, carry the current one along the shortest turn to the new point.
    const up = destination.up.clone().normalize();
    const forward = destination.forward?.clone()
      ?? this.forward.clone().applyQuaternion(new Quaternion().setFromUnitVectors(this.up, up));
    const to = { frame: groundFrame(up, forward, new Quaternion()), distanceKm: destination.distanceKm, tilt: destination.tilt };

    this.flight = startFlight(from, to, then);
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

    const arrived = sampleFlight(flight, now, this.flightPose);
    this.up.set(0, 0, 1).applyQuaternion(this.flightPose.frame);
    this.forward.set(0, 1, 0).applyQuaternion(this.flightPose.frame);
    this.distanceKm = this.flightPose.distanceKm;
    this.tilt = this.flightPose.tilt;
    if (!arrived) return true;

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

  /** The unit direction of the drawn ground under a screen point, or null when it shows space. */
  pick(clientX: number, clientY: number) {
    return pickGround(this.camera, this.element.getBoundingClientRect(), clientX, clientY, this.groundKm);
  }

  /** Move the view by a drag of `dx`, `dy` pixels: panning, turning and tilting, or looking around. */
  drag(dx: number, dy: number, turning: boolean) {
    if (this.mode === "stand") {
      // Looking around: the scene follows the pointer, scaled so a point stays under it.
      const perPixel = this.camera.fov * Math.PI / 180 / this.element.clientHeight;
      this.forward.applyAxisAngle(this.up, dx * perPixel);
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + dy * perPixel));
    } else if (turning) {
      this.forward.applyAxisAngle(this.up, dx * TURN_PER_PIXEL);
      this.tilt = Math.max(0, Math.min(MAX_TILT, this.tilt - dy * TURN_PER_PIXEL));
    } else {
      this.pan(dx, dy);
    }
    this.onChange();
  }

  /** Zoom by a scroll of `amount` pixels. In orbit mode the ground under the pointer stays in place. */
  scroll(amount: number, clientX: number, clientY: number) {
    this.flight = null;

    if (this.mode === "stand") {
      this.camera.fov = Math.max(8, Math.min(90, this.camera.fov * Math.exp(amount * ZOOM_PER_SCROLL_PX)));
      this.camera.updateProjectionMatrix();
      this.onChange();
      return;
    }

    const before = this.distanceKm;
    this.distanceKm = Math.max(MIN_DISTANCE_KM, Math.min(MAX_DISTANCE_KM, before * Math.exp(amount * ZOOM_PER_SCROLL_PX)));

    // Zooming in pulls the focus toward the ground under the pointer, keeping it in place.
    const under = this.distanceKm < before ? this.pick(clientX, clientY) : null;
    if (under) {
      const toward = new Quaternion().setFromUnitVectors(this.up, under);
      const turn = new Quaternion().slerpQuaternions(new Quaternion(), toward, 1 - this.distanceKm / before);
      this.up.applyQuaternion(turn).normalize();
      this.forward.applyQuaternion(turn);
    }
    this.onChange();
  }

  /** Fly closer to the ground under a screen point. Only in orbit mode. */
  flyCloserTo(clientX: number, clientY: number) {
    if (this.mode !== "orbit") return;

    const under = this.pick(clientX, clientY);
    if (under) this.flyTo({ up: under, distanceKm: Math.max(MIN_DISTANCE_KM, this.distanceKm / 2.5), tilt: this.tilt });
  }

  /** Move the view by `dx`, `dy` pixels' worth, as a key press does. */
  nudge(dx: number, dy: number) {
    this.flight = null;

    if (this.mode === "orbit") this.pan(dx, dy);
    else this.forward.applyAxisAngle(this.up, dx * LOOK_PER_NUDGE_PX);
    this.onChange();
  }

  /** Move the camera closer (factor below 1) or farther (above 1). */
  scaleDistance(factor: number) {
    this.flight = null;
    this.distanceKm = Math.max(MIN_DISTANCE_KM, Math.min(MAX_DISTANCE_KM, this.distanceKm * factor));
    this.onChange();
  }

  /** Move the focus point so the ground follows the pointer by `dx`, `dy` pixels. */
  private pan(dx: number, dy: number) {
    // Ground angle per pixel: α = min(d·2·tan(φ/2)/(H·R), α_max)
    //   α - Angle the focus point moves per pixel, in radians; d - camera distance, in km.
    //   φ - Vertical field of view; H - viewport height, in pixels; R - lunar radius, in km.
    //   α_max - Limit that keeps the view of the whole Moon controllable.
    const kmPerPixel = this.distanceKm * 2 * Math.tan(this.camera.fov * Math.PI / 360) / this.element.clientHeight;
    const perPixel = Math.min(kmPerPixel / MOON_RADIUS_KM, MAX_PAN_PER_PIXEL);

    this.right.crossVectors(this.forward, this.up);
    const aboutForward = this.scratch.copy(this.forward);
    this.up.applyAxisAngle(aboutForward, -dx * perPixel);

    const aboutRight = this.scratch.crossVectors(this.forward, this.up).negate().normalize();
    this.up.applyAxisAngle(aboutRight, dy * perPixel).normalize();
    this.forward.applyAxisAngle(aboutRight, dy * perPixel);
  }
}
