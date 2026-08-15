import * as THREE from "three";
import type { LatLon } from "../data/types";
import { latLonToVector3 } from "../globe/geometry";
import { EARTH_RADIUS_UNITS, PALETTE } from "./constants";

/**
 * Concentric rings spreading out from a mast, for the one hop in the whole
 * journey that travels through the air.
 *
 * CLAUDE.md asks for the wireless leg to be unmistakable at a glance —
 * `device → ))) → 5G tower → fibre` — and a green line looks identical whether
 * it is radio or glass. The route model already tagged this step `visual:
 * "radio"`; this is what finally draws it.
 */

const RING_COUNT = 3;
const PERIOD_SECONDS = 1.9;
/** Roughly a 250 km footprint — a mast's reach, not a continent's. */
const MAX_RADIUS = EARTH_RADIUS_UNITS * 0.075;

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uColour;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    float r = length(vUv - 0.5) * 2.0;
    // A thin travelling band rather than a filled disc, so several rings can
    // overlap without the whole area washing out.
    float band = smoothstep(1.0, 0.88, r) * smoothstep(0.7, 0.86, r);
    float alpha = band * uOpacity;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColour, alpha);
  }
`;

export interface RadioWaves {
  group: THREE.Group;
  /** Pass the mast's location to start, or null to stop. */
  showAt(location: LatLon | null): void;
  update(dtMs: number): void;
  dispose(): void;
}

export function createRadioWaves(): RadioWaves {
  const group = new THREE.Group();
  group.visible = false;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const rings: { mesh: THREE.Mesh; material: THREE.ShaderMaterial }[] = [];
  const geometry = new THREE.PlaneGeometry(1, 1);

  for (let i = 0; i < RING_COUNT; i++) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColour: { value: new THREE.Color(PALETTE.route) },
        uOpacity: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    rings.push({ mesh, material });
  }

  const normal = new THREE.Vector3();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const planeNormal = new THREE.Vector3(0, 0, 1);
  let elapsed = 0;

  function layout(): void {
    for (let i = 0; i < rings.length; i++) {
      const { mesh } = rings[i];
      mesh.position.copy(position);
      mesh.quaternion.copy(quaternion);
      /*
       * Reduced motion still has to answer "is this bit wireless?", so the
       * rings stay — they simply sit at fixed radii instead of travelling.
       */
      if (reducedMotion) {
        const scale = MAX_RADIUS * (2 * (i + 1)) / (RING_COUNT + 1);
        mesh.scale.setScalar(scale);
        rings[i].material.uniforms.uOpacity.value = 0.5;
      }
    }
  }

  function showAt(location: LatLon | null): void {
    if (!location) {
      group.visible = false;
      return;
    }
    latLonToVector3(location, EARTH_RADIUS_UNITS * 1.005, position);
    normal.copy(position).normalize();
    quaternion.setFromUnitVectors(planeNormal, normal);
    elapsed = 0;
    group.visible = true;
    layout();
  }

  function update(dtMs: number): void {
    if (!group.visible || reducedMotion) return;
    elapsed += dtMs / 1000;

    for (let i = 0; i < rings.length; i++) {
      // Staggered so one ring is always leaving the mast as another arrives at
      // the edge, which is what reads as "transmitting" rather than "pulsing".
      const phase = (elapsed / PERIOD_SECONDS + i / RING_COUNT) % 1;
      rings[i].mesh.scale.setScalar(Math.max(0.0001, phase * MAX_RADIUS * 2));
      // Fade out as it expands; the leading edge is where the energy is.
      rings[i].material.uniforms.uOpacity.value = (1 - phase) * 0.85;
    }
  }

  function dispose(): void {
    geometry.dispose();
    for (const ring of rings) ring.material.dispose();
  }

  return { group, showAt, update, dispose };
}
