import * as THREE from "three";
import { reducedMotion } from "../reduced-motion";
import { EARTH_RADIUS_UNITS, altitudeToRadius } from "./constants";

/**
 * Cinematic camera moves.
 *
 * The orbit controls can only ever look at the centre of the Earth, which is
 * the right model for exploring but cannot express the shots the flow calls
 * for -- in particular "show the uplink from a horizontal view, visualising the
 * vertical travel to space", which needs the camera beside the launch point
 * with the radial direction running up the screen.
 *
 * So the director takes the camera over for the duration of a shot, animating
 * position, look-at target and up vector together, then hands it back. The
 * orbit controls stay suspended while it is driving and resynchronise from
 * wherever the camera ended up, so control never jumps.
 */

export interface Pose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
}

/** Smoothstep-style ease so shots start and stop gently rather than snapping. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export interface CameraDirector {
  /** True while a shot is playing and the orbit controls should stand down. */
  readonly active: boolean;
  playPose(pose: Pose, durationMs?: number): void;
  /** Ends the current shot immediately, leaving the camera where it is. */
  release(): void;
  update(dtMs: number): void;
}

export function createCameraDirector(camera: THREE.PerspectiveCamera): CameraDirector {
  let from: Pose | null = null;
  let to: Pose | null = null;
  let elapsed = 0;
  let duration = 0;
  let active = false;

  // Reused so a shot allocates nothing per frame.
  const position = new THREE.Vector3();
  const target = new THREE.Vector3();
  const up = new THREE.Vector3();

  function currentPose(): Pose {
    // The camera's look-at target isn't stored on the camera, so derive a point
    // in front of it at roughly the planet's distance to keep the blend stable.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    return {
      position: camera.position.clone(),
      target: camera.position.clone().addScaledVector(forward, camera.position.length()),
      up: camera.up.clone(),
    };
  }

  function playPose(pose: Pose, durationMs = 1600): void {
    from = currentPose();
    to = pose;
    elapsed = 0;
    // Reduced motion still needs the framing -- it just shouldn't be flown to.
    duration = reducedMotion.value ? 0 : Math.max(0, durationMs);
    active = true;
    if (duration === 0) update(0);
  }

  function release(): void {
    active = false;
    from = null;
    to = null;
    camera.up.set(0, 1, 0);
  }

  function update(dtMs: number): void {
    if (!active || !from || !to) return;

    elapsed += dtMs;
    const t = duration === 0 ? 1 : ease(Math.min(1, elapsed / duration));

    position.copy(from.position).lerp(to.position, t);
    target.copy(from.target).lerp(to.target, t);
    up.copy(from.up).lerp(to.up, t).normalize();

    camera.position.copy(position);
    camera.up.copy(up);
    camera.lookAt(target);
  }

  return {
    get active() {
      return active;
    },
    playPose,
    release,
    update,
  };
}

// --- shot composition -----------------------------------------------------

const SATELLITE_RADIUS = altitudeToRadius(550);

/**
 * The uplink shot: camera beside the launch point, looking along the surface,
 * with the radial direction as "up" so the climb to orbit reads as vertical
 * travel rather than as motion towards the viewer.
 */
export function uplinkPose(originDirection: THREE.Vector3): Pose {
  const radial = originDirection.clone().normalize();

  // Any tangent will do; deriving it from the world pole keeps the horizon
  // level, and the fallback covers standing exactly on a pole.
  let tangent = new THREE.Vector3(0, 1, 0).cross(radial);
  if (tangent.lengthSq() < 1e-6) tangent = new THREE.Vector3(1, 0, 0).cross(radial);
  tangent.normalize();

  // Look at the midpoint of the climb so both ends of it are in frame.
  const target = radial.clone().multiplyScalar((EARTH_RADIUS_UNITS + SATELLITE_RADIUS) / 2);
  const position = target.clone().addScaledVector(tangent, 1.15).addScaledVector(radial, 0.05);

  return { position, target, up: radial };
}

/** A closer three-quarter view for the satellite-to-satellite relay. */
export function relayPose(a: THREE.Vector3, b: THREE.Vector3): Pose {
  const midpoint = a.clone().add(b).multiplyScalar(0.5);
  const outward = midpoint.clone().normalize();
  const span = Math.max(1.4, a.distanceTo(b) * 1.1);
  const position = outward.clone().multiplyScalar(SATELLITE_RADIUS + span);
  return { position, target: midpoint, up: new THREE.Vector3(0, 1, 0) };
}

/** Frames a single hop on the ground -- close, but still clearly on a globe. */
export function nodePose(direction: THREE.Vector3): Pose {
  const outward = direction.clone().normalize();
  return {
    position: outward.clone().multiplyScalar(EARTH_RADIUS_UNITS * 2.05),
    target: outward.clone().multiplyScalar(EARTH_RADIUS_UNITS),
    up: new THREE.Vector3(0, 1, 0),
  };
}

/**
 * Pulls back far enough to hold every point of the route at once, looking down
 * the average of them so the whole path sits in frame.
 */
export function overviewPose(points: readonly THREE.Vector3[]): Pose {
  const centroid = new THREE.Vector3();
  for (const point of points) centroid.addScaledVector(point.clone().normalize(), 1);
  if (centroid.lengthSq() < 1e-6) centroid.set(0, 0, 1);
  centroid.normalize();

  // How far around the globe the route reaches decides how far back to stand.
  let widest = 0;
  for (const point of points) {
    widest = Math.max(widest, centroid.angleTo(point.clone().normalize()));
  }
  const distance = EARTH_RADIUS_UNITS * (2.5 + Math.min(1.9, widest * 1.5));

  return {
    position: centroid.clone().multiplyScalar(distance),
    target: new THREE.Vector3(0, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
  };
}
