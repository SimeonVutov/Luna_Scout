import { Matrix4, Quaternion, Vector3 } from "three";

const FLIGHT_MS = 900;

/** Where the camera is, as far as a flight cares: the ground frame, how far back and how tilted. */
export type FlightPose = { frame: Quaternion; distanceKm: number; tilt: number };

/** A glide from one pose to another, started at `startedAt` (ms). */
export type Flight = {
  startedAt: number;
  from: FlightPose;
  to: FlightPose;
  /** Runs once, when the glide arrives. */
  then?: () => void;
};

export function startFlight(from: FlightPose, to: FlightPose, then?: () => void): Flight {
  return { startedAt: performance.now(), from, to, then };
}

/**
 * The pose a flight has reached at time `now`, and whether it has arrived.
 *
 * Ease in and out: e = 3p² − 2p³
 *   e - Eased share of the way, 0 to 1; p - Elapsed share of the flight's duration, 0 to 1.
 * Distance: d = exp(ln d₀ + (ln d₁ − ln d₀)·e)
 *   d₀, d₁ - Starting and final camera distances, in km. Distances span many orders of
 *   magnitude, so they are interpolated as logarithms to feel even.
 * Tilt: τ = τ₀ + (τ₁ − τ₀)·e, in radians. The ground frame is turned along the shortest arc.
 */
export function sampleFlight(flight: Flight, now: number, out: FlightPose) {
  const progress = Math.min(1, (now - flight.startedAt) / FLIGHT_MS);
  const eased = progress * progress * (3 - 2 * progress);

  out.frame.slerpQuaternions(flight.from.frame, flight.to.frame, eased);
  out.distanceKm = Math.exp(Math.log(flight.from.distanceKm) + (Math.log(flight.to.distanceKm) - Math.log(flight.from.distanceKm)) * eased);
  out.tilt = flight.from.tilt + (flight.to.tilt - flight.from.tilt) * eased;

  return progress >= 1;
}

const basis = new Matrix4();

/**
 * The rotation that turns the reference frame (x east of the screen, y up the screen along the
 * ground, z straight up) into the frame at ground direction `up` with `forward` up the screen.
 */
export function groundFrame(up: Vector3, forward: Vector3, out: Quaternion) {
  const levelled = forward.clone().addScaledVector(up, -forward.dot(up)).normalize();
  basis.makeBasis(new Vector3().crossVectors(levelled, up), levelled, up);
  return out.setFromRotationMatrix(basis);
}
