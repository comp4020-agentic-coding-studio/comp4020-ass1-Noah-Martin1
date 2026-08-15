import * as THREE from "three";
import type { LatLon } from "../data/types";
import { reducedMotion } from "../reduced-motion";
import { latLonToVector3 } from "./geometry";
import type { GlobeScene } from "./scene";

export interface GlobeControlsOptions {
  /** Called on a pointerup that didn't drag beyond a small threshold -- a tap/click, for location picking. */
  onTap?: (clientX: number, clientY: number) => void;
  minDistance?: number;
  maxDistance?: number;
}

export interface GlobeControls {
  update(dtMs: number): void;
  /** Smoothly rotates the globe so the given location faces the camera. */
  focusOn(latLon: LatLon): void;
}

const TAP_MOVE_THRESHOLD = 6;

export function attachGlobeControls(globe: GlobeScene, options: GlobeControlsOptions = {}): GlobeControls {
  const { stage, renderer, camera, globeGroup, cloudMesh, starfield } = globe;
  const minDistance = options.minDistance ?? 2.4;
  const maxDistance = options.maxDistance ?? 9;

  const orientation = new THREE.Quaternion();
  const worldX = new THREE.Vector3(1, 0, 0);
  const worldY = new THREE.Vector3(0, 1, 0);
  const dragSensitivity = 0.006;
  const inertiaDamping = 0.94;
  const inertiaEpsilon = 0.00005;
  const idleDelayMs = 1200;
  const idleRampMs = 900;
  const autoRotateSpeed = 0.00035;
  const cloudDriftSpeed = 0.00006;
  const starParallax = 0.12;

  let isDragging = false;
  let dragDistance = 0;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let velocityYaw = 0;
  let velocityPitch = 0;
  let lastInteractionTime = performance.now();
  let autoRotateBlend = 0;
  let cameraDistance = camera.position.length();
  let focusTarget: THREE.Quaternion | null = null;
  const focusSlerpSpeed = 0.004;

  function applyRotation(yaw: number, pitch: number): void {
    const qYaw = new THREE.Quaternion().setFromAxisAngle(worldY, -yaw);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(worldX, -pitch);
    orientation.premultiply(qYaw);
    orientation.premultiply(qPitch);
    globeGroup.quaternion.copy(orientation);
    starfield.rotation.y += yaw * starParallax;
    starfield.rotation.x += pitch * starParallax;
  }

  function onPointerDown(event: PointerEvent): void {
    isDragging = true;
    dragDistance = 0;
    velocityYaw = 0;
    velocityPitch = 0;
    autoRotateBlend = 0;
    focusTarget = null;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    stage.classList.add("dragging");
    renderer.domElement.setPointerCapture(event.pointerId);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
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
    const yaw = dx * dragSensitivity;
    const pitch = dy * dragSensitivity;
    applyRotation(yaw, pitch);
    velocityYaw = yaw;
    velocityPitch = pitch;
  }

  function endDrag(event: PointerEvent): void {
    const wasTap = isDragging && dragDistance < TAP_MOVE_THRESHOLD && activePointers.size <= 1;
    isDragging = false;
    stage.classList.remove("dragging");
    lastInteractionTime = performance.now();
    activePointers.delete(event.pointerId);
    lastPinchDistance = null;
    if (wasTap) options.onTap?.(event.clientX, event.clientY);
  }

  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerup", endDrag);
  renderer.domElement.addEventListener("pointercancel", endDrag);

  // --- zoom: mouse wheel + touch pinch, clamped to a sensible range ---

  const activePointers = new Map<number, { x: number; y: number }>();
  let lastPinchDistance: number | null = null;

  function setDistance(distance: number): void {
    cameraDistance = Math.min(maxDistance, Math.max(minDistance, distance));
    camera.position.set(0, 0, cameraDistance);
  }

  function handlePinch(): void {
    const points = [...activePointers.values()];
    const dx = points[0].x - points[1].x;
    const dy = points[0].y - points[1].y;
    const distance = Math.hypot(dx, dy);
    if (lastPinchDistance !== null) {
      const scale = lastPinchDistance / distance;
      setDistance(cameraDistance * scale);
    }
    lastPinchDistance = distance;
    lastInteractionTime = performance.now();
  }

  renderer.domElement.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      event.preventDefault();
      setDistance(cameraDistance * (1 + event.deltaY * 0.0012));
      lastInteractionTime = performance.now();
    },
    { passive: false },
  );

  const resizeObserver = new ResizeObserver(() => globe.resize());
  resizeObserver.observe(stage);
  globe.resize();

  function focusOn(latLon: LatLon): void {
    const point = latLonToVector3(latLon, 1).normalize();
    const front = new THREE.Vector3(0, 0, 1);
    focusTarget = new THREE.Quaternion().setFromUnitVectors(point, front);
    lastInteractionTime = performance.now();
    autoRotateBlend = 0;
    velocityYaw = 0;
    velocityPitch = 0;
    if (reducedMotion.value) {
      orientation.copy(focusTarget);
      globeGroup.quaternion.copy(orientation);
      focusTarget = null;
    }
  }

  function update(dtMs: number): void {
    const now = performance.now();

    if (focusTarget) {
      const t = Math.min(1, dtMs * focusSlerpSpeed);
      orientation.slerp(focusTarget, t);
      globeGroup.quaternion.copy(orientation);
      if (orientation.angleTo(focusTarget) < 0.001) focusTarget = null;
    } else if (!isDragging && !reducedMotion.value) {
      if (Math.abs(velocityYaw) > inertiaEpsilon || Math.abs(velocityPitch) > inertiaEpsilon) {
        applyRotation(velocityYaw, velocityPitch);
        velocityYaw *= inertiaDamping;
        velocityPitch *= inertiaDamping;
      } else {
        velocityYaw = 0;
        velocityPitch = 0;
        const idleFor = now - lastInteractionTime;
        if (idleFor > idleDelayMs) {
          autoRotateBlend = Math.min(1, autoRotateBlend + dtMs / idleRampMs);
          applyRotation(autoRotateSpeed * dtMs * autoRotateBlend, 0);
        }
      }
    }

    if (!reducedMotion.value) {
      cloudMesh.rotation.y += cloudDriftSpeed * dtMs;
    }
  }

  return { update, focusOn };
}
