import * as THREE from "three";
import type { LatLon } from "../data/types";
import { vector3ToLatLon } from "../globe/geometry";
import { EARTH_RADIUS_UNITS } from "./constants";
import { surfacePointAt } from "./picking";
import type { GlobeScene } from "./scene";

/**
 * The selection cursor: a ring that follows the pointer across the globe,
 * green where a request could actually start and red where it could not, with
 * a "sorry! no connection here" note beside the pointer on red.
 *
 * This is the moment the coverage data becomes visible to the user. Everything
 * else about coverage is invisible modelling; this is where it turns into an
 * answer to "can I start here?" before the user commits to a click.
 */

const RING_COLOUR_OK = new THREE.Color(0x54ff8f);
const RING_COLOUR_BLOCKED = new THREE.Color(0xff5a6a);

const RING_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RING_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uColour;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    // A soft annulus: bright at the rim, faint wash inside, so the ring reads
    // as a target rather than a solid dot obscuring what is underneath.
    float r = length(vUv - 0.5) * 2.0;
    float rim = smoothstep(1.0, 0.86, r) * smoothstep(0.62, 0.82, r);
    float fill = smoothstep(0.82, 0.0, r) * 0.16;
    float alpha = (rim + fill) * uOpacity;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColour, alpha);
  }
`;

export type CoveragePredicate = (location: LatLon) => boolean;

export interface HoverCursor {
  group: THREE.Group;
  /** Only shown while the user is actually being asked to choose a place. */
  setEnabled(enabled: boolean): void;
  setPredicate(predicate: CoveragePredicate | null): void;
  /** Resolves the hovered point to a place name shown beside the cursor. */
  setLabeller(labeller: ((location: LatLon) => string | null) | null): void;
  /** Message shown beside the pointer when the location has no service. */
  setBlockedMessage(message: string): void;
  /** Feed a pointer position; pass null when the pointer leaves the window. */
  track(clientX: number, clientY: number): void;
  clear(): void;
  /** Whether the last tracked point was serviceable. */
  readonly covered: boolean;
  update(dtMs: number): void;
  dispose(): void;
}

export function createHoverCursor(globe: GlobeScene, host: HTMLElement): HoverCursor {
  const group = new THREE.Group();
  group.visible = false;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColour: { value: RING_COLOUR_OK.clone() },
      uOpacity: { value: 1 },
    },
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  // A flat quad laid on the surface and oriented to its normal. Kept small
  // enough to feel like a cursor rather than a region.
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), material);
  group.add(ring);

  const tooltip = document.createElement("div");
  tooltip.className = "hover-tip";
  tooltip.hidden = true;
  tooltip.setAttribute("role", "status");
  tooltip.setAttribute("aria-live", "polite");

  const placeLine = document.createElement("span");
  placeLine.className = "hover-tip-place";
  const statusLine = document.createElement("span");
  statusLine.className = "hover-tip-status";
  tooltip.append(placeLine, statusLine);
  host.append(tooltip);

  let predicate: CoveragePredicate | null = null;
  let labeller: ((location: LatLon) => string | null) | null = null;
  let enabled = false;
  let covered = false;
  let blockedMessage = "sorry! no connection here";
  let pulse = 0;

  const surfaceNormal = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const planeNormal = new THREE.Vector3(0, 0, 1);

  function setEnabled(next: boolean): void {
    enabled = next;
    if (!next) clear();
  }

  function setPredicate(next: CoveragePredicate | null): void {
    predicate = next;
  }

  function setLabeller(next: ((location: LatLon) => string | null) | null): void {
    labeller = next;
  }

  function setBlockedMessage(message: string): void {
    blockedMessage = message;
  }

  function clear(): void {
    group.visible = false;
    tooltip.hidden = true;
    covered = false;
  }

  function track(clientX: number, clientY: number): void {
    if (!enabled) {
      clear();
      return;
    }

    const point = surfacePointAt(globe, clientX, clientY);
    if (!point) {
      clear();
      return;
    }

    const location = vector3ToLatLon(point);
    covered = predicate ? predicate(location) : true;

    // Lift the ring clear of the surface so it never z-fights the terrain.
    surfaceNormal.copy(point).normalize();
    ring.position.copy(surfaceNormal).multiplyScalar(EARTH_RADIUS_UNITS * 1.004);
    quaternion.setFromUnitVectors(planeNormal, surfaceNormal);
    ring.quaternion.copy(quaternion);

    (material.uniforms.uColour.value as THREE.Color).copy(covered ? RING_COLOUR_OK : RING_COLOUR_BLOCKED);
    group.visible = true;

    /*
     * The label rides along with the ring in both states. Knowing *where* you
     * are pointing is what makes the green/red answer mean anything -- "no
     * connection here" is far more informative next to "Coral Sea" than on its
     * own, and on the green side it is the confirmation that you are about to
     * start the request from the place you think you are.
     */
    const place = labeller ? labeller(location) : null;
    placeLine.textContent = place ?? "";
    placeLine.hidden = !place;
    statusLine.textContent = covered ? "" : blockedMessage;
    statusLine.hidden = covered;
    tooltip.classList.toggle("hover-tip-blocked", !covered);

    if (!place && covered) {
      tooltip.hidden = true;
      return;
    }

    tooltip.hidden = false;
    // Offset from the pointer, then flipped near the right/bottom edges so the
    // message never runs off screen on a phone.
    const flipX = clientX > window.innerWidth - 220;
    const flipY = clientY > window.innerHeight - 90;
    tooltip.style.left = `${clientX + (flipX ? -14 : 14)}px`;
    tooltip.style.top = `${clientY + (flipY ? -14 : 18)}px`;
    tooltip.style.transform = `translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`;
  }

  function update(dtMs: number): void {
    if (!group.visible) return;
    pulse += dtMs / 1000;
    material.uniforms.uOpacity.value = 0.75 + 0.25 * Math.sin(pulse * 4.2);
  }

  function dispose(): void {
    ring.geometry.dispose();
    material.dispose();
    tooltip.remove();
  }

  return {
    group,
    setEnabled,
    setPredicate,
    setLabeller,
    setBlockedMessage,
    track,
    clear,
    get covered() {
      return covered;
    },
    update,
    dispose,
  };
}
