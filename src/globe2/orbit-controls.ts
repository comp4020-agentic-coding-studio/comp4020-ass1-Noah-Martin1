import * as THREE from "three";
import type { LatLon } from "../data/types";
import { reducedMotion } from "../reduced-motion";
import type { GlobeScene } from "./scene";

/**
 * Camera-orbit controls.
 *
 * The camera orbits a stationary planet rather than the planet spinning under a
 * fixed camera. That single change is what makes the sky behave: because the
 * stars, Milky Way, sun and moon live in world space, orbiting the camera
 * sweeps them past exactly the way satellitemap.space does. Spinning the globe
 * instead would leave the background nailed in place and require faking
 * parallax.
 */

/**
 * Idle drift, in radians per millisecond. This is deliberately a tenth of the
 * original 0.00035 -- roughly three minutes per revolution, calm enough to read
 * as "alive" rather than as motion competing with the visualisation.
 */
const IDLE_ROTATION_SPEED = 0.000035;

const TAP_MOVE_THRESHOLD = 6;
const IDLE_DELAY_MS = 1500;
const IDLE_RAMP_MS = 1400;
const DRAG_SENSITIVITY = 0.0052;
const INERTIA_DAMPING = 0.93;
const INERTIA_EPSILON = 0.00004;
const POLAR_LIMIT = 0.12;

export interface OrbitControlsOptions {
  onTap?: (clientX: number, clientY: number) => void;
  minDistance?: number;
  maxDistance?: number;
}

export interface OrbitControls {
  update(dtMs: number): void;
  /** Smoothly brings a location round to face the camera. */
  focusOn(location: LatLon): void;
  /** Re-frames the globe for the current focus rect, unless the user has zoomed. */
  refit(): void;
  dispose(): void;
}

function shortestAngleTo(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export function attachOrbitControls(globe: GlobeScene, options: OrbitControlsOptions = {}): OrbitControls {
  const { canvas, camera } = globe;

  let distance = globe.fittedDistance();
  const minDistance = options.minDistance ?? globe.earthRadius * 1.18;
  const maxDistance = options.maxDistance ?? globe.earthRadius * 9;
  let userHasZoomed = false;

  // Start over the Atlantic so Europe, Africa and the Americas are all in view,
  // which matches the framing of the reference imagery.
  let azimuth = -0.35;
  let polar = Math.PI / 2 - 0.25;

  let velocityAzimuth = 0;
  let velocityPolar = 0;
  let isDragging = false;
  let dragDistance = 0;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let lastInteractionTime = performance.now();
  let idleBlend = 0;

  let focusAzimuth: number | null = null;
  let focusPolar: number | null = null;

  const activePointers = new Map<number, { x: number; y: number }>();
  let lastPinchDistance: number | null = null;

  function applyCamera(): void {
    polar = Math.min(Math.PI - POLAR_LIMIT, Math.max(POLAR_LIMIT, polar));
    const sinPolar = Math.sin(polar);
    camera.position.set(
      distance * sinPolar * Math.sin(azimuth),
      distance * Math.cos(polar),
      distance * sinPolar * Math.cos(azimuth),
    );
    camera.lookAt(0, 0, 0);
  }

  function markInteraction(): void {
    lastInteractionTime = performance.now();
    idleBlend = 0;
  }

  function setDistance(next: number): void {
    distance = Math.min(maxDistance, Math.max(minDistance, next));
    applyCamera();
  }

  // --- pointer: drag to orbit, pinch to zoom, tap to pick ---

  function onPointerDown(event: PointerEvent): void {
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    isDragging = true;
    dragDistance = 0;
    velocityAzimuth = 0;
    velocityPolar = 0;
    focusAzimuth = null;
    focusPolar = null;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    canvas.classList.add("dragging");
    canvas.setPointerCapture(event.pointerId);
    markInteraction();
  }

  function onPointerMove(event: PointerEvent): void {
    if (activePointers.has(event.pointerId)) {
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (activePointers.size === 2) {
      handlePinch();
      return;
    }
    if (!isDragging) return;

    const dx = event.clientX - lastPointerX;
    const dy = event.clientY - lastPointerY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    dragDistance += Math.abs(dx) + Math.abs(dy);

    // Dragging right should send the globe right, i.e. move the camera left.
    velocityAzimuth = -dx * DRAG_SENSITIVITY;
    velocityPolar = dy * DRAG_SENSITIVITY;
    azimuth += velocityAzimuth;
    polar += velocityPolar;
    applyCamera();
    markInteraction();
  }

  function endDrag(event: PointerEvent): void {
    const wasTap = isDragging && dragDistance < TAP_MOVE_THRESHOLD && activePointers.size <= 1;
    isDragging = false;
    canvas.classList.remove("dragging");
    activePointers.delete(event.pointerId);
    lastPinchDistance = null;
    lastInteractionTime = performance.now();
    if (wasTap) options.onTap?.(event.clientX, event.clientY);
  }

  function handlePinch(): void {
    const points = [...activePointers.values()];
    const separation = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    if (lastPinchDistance !== null && separation > 0) {
      userHasZoomed = true;
      setDistance(distance * (lastPinchDistance / separation));
    }
    lastPinchDistance = separation;
    markInteraction();
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    userHasZoomed = true;
    setDistance(distance * (1 + event.deltaY * 0.0012));
    markInteraction();
  }

  // --- keyboard: the globe is focusable, so orbiting must not need a mouse ---

  function onKeyDown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 0.28 : 0.12;
    switch (event.key) {
      case "ArrowLeft":
        azimuth += step;
        break;
      case "ArrowRight":
        azimuth -= step;
        break;
      case "ArrowUp":
        polar -= step;
        break;
      case "ArrowDown":
        polar += step;
        break;
      case "+":
      case "=":
        userHasZoomed = true;
        setDistance(distance * 0.88);
        break;
      case "-":
      case "_":
        userHasZoomed = true;
        setDistance(distance * 1.14);
        break;
      default:
        return;
    }
    event.preventDefault();
    focusAzimuth = null;
    focusPolar = null;
    applyCamera();
    markInteraction();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKeyDown);

  function focusOn(location: LatLon): void {
    const phi = (90 - location.lat) * (Math.PI / 180);
    const theta = (location.lon + 180) * (Math.PI / 180);
    const direction = new THREE.Vector3(
      -Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta),
    );

    focusPolar = Math.acos(THREE.MathUtils.clamp(direction.y, -1, 1));
    focusAzimuth = azimuth + shortestAngleTo(azimuth, Math.atan2(direction.x, direction.z));
    velocityAzimuth = 0;
    velocityPolar = 0;
    markInteraction();

    if (reducedMotion.value) {
      azimuth = focusAzimuth;
      polar = focusPolar;
      focusAzimuth = null;
      focusPolar = null;
      applyCamera();
    }
  }

  function refit(): void {
    if (userHasZoomed) return;
    setDistance(globe.fittedDistance());
  }

  function update(dtMs: number): void {
    if (focusAzimuth !== null && focusPolar !== null) {
      const t = Math.min(1, dtMs * 0.005);
      azimuth += (focusAzimuth - azimuth) * t;
      polar += (focusPolar - polar) * t;
      if (Math.abs(focusAzimuth - azimuth) < 0.002 && Math.abs(focusPolar - polar) < 0.002) {
        azimuth = focusAzimuth;
        polar = focusPolar;
        focusAzimuth = null;
        focusPolar = null;
      }
      applyCamera();
      return;
    }

    if (isDragging || reducedMotion.value) return;

    if (Math.abs(velocityAzimuth) > INERTIA_EPSILON || Math.abs(velocityPolar) > INERTIA_EPSILON) {
      azimuth += velocityAzimuth;
      polar += velocityPolar;
      velocityAzimuth *= INERTIA_DAMPING;
      velocityPolar *= INERTIA_DAMPING;
      applyCamera();
      return;
    }

    velocityAzimuth = 0;
    velocityPolar = 0;

    if (performance.now() - lastInteractionTime > IDLE_DELAY_MS) {
      idleBlend = Math.min(1, idleBlend + dtMs / IDLE_RAMP_MS);
      azimuth -= IDLE_ROTATION_SPEED * dtMs * idleBlend;
      applyCamera();
    }
  }

  function dispose(): void {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", endDrag);
    canvas.removeEventListener("pointercancel", endDrag);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("keydown", onKeyDown);
  }

  applyCamera();

  return { update, focusOn, refit, dispose };
}
