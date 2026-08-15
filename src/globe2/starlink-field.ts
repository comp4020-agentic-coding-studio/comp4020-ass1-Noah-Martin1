import * as THREE from "three";
import type { LatLon } from "../data/types";
import { latLonToVector3 } from "../globe/geometry";
import { reducedMotion } from "../reduced-motion";
import { EARTH_RADIUS_KM, EARTH_RADIUS_UNITS, ORBIT_TIME_SCALE } from "./constants";
import { buildOrbitSet, dateToJulian, propagate, type OrbitSet } from "./orbits";

/**
 * The whole vendored Starlink catalogue as a single point cloud.
 *
 * Every satellite in the snapshot is drawn -- there is no sampling -- because
 * the density *is* the point: the reference imagery reads as a shell around the
 * planet precisely because it is ten thousand objects rather than a
 * representative few dozen. One BufferGeometry and one draw call makes that
 * affordable; the per-frame cost is the propagation loop, which is a few flops
 * per satellite.
 */

/**
 * Colours follow satellitemap.space's convention of grouping by orbital shell.
 * The shells are inferred from inclination and mean altitude rather than read
 * from a manifest, so this is a reasonable grouping of real elements, not an
 * authoritative Gen1/Gen2 manifest.
 */
const SHELL_COLOURS = {
  gen1: [0.29, 0.64, 1.0],
  gen2: [1.0, 0.48, 0.18],
  gen2Low: [0.88, 0.66, 0.38],
  inclined70: [0.88, 0.25, 0.88],
  sunSynchronous: [1.0, 0.35, 0.5],
  raising: [0.37, 0.82, 0.85],
  other: [0.6, 0.64, 0.72],
} as const;

function shellColour(inclinationDeg: number, altitudeKm: number): readonly number[] {
  // Satellites still raising to their operational shell sit conspicuously low.
  if (altitudeKm < 450) return SHELL_COLOURS.raising;
  if (inclinationDeg >= 90) return SHELL_COLOURS.sunSynchronous;
  if (inclinationDeg >= 60) return SHELL_COLOURS.inclined70;
  if (inclinationDeg >= 50) return altitudeKm >= 535 ? SHELL_COLOURS.gen1 : SHELL_COLOURS.gen2;
  if (inclinationDeg >= 38) return SHELL_COLOURS.gen2;
  if (inclinationDeg >= 20) return SHELL_COLOURS.gen2Low;
  return SHELL_COLOURS.other;
}

const VERTEX = /* glsl */ `
  attribute vec3 aColour;
  uniform float uPixelRatio;
  uniform vec3 uOriginDirection;
  uniform float uConeCos;
  uniform float uHasOrigin;
  uniform float uSize;
  varying vec3 vColour;
  varying float vAlpha;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

    // When an origin is chosen the satellites actually overhead there step
    // forward. The rest stay clearly visible -- the whole constellation is the
    // point of the picture -- they just sit back to about half strength.
    float overhead = step(uConeCos, dot(normalize(position), uOriginDirection));
    float prominence = mix(1.0, mix(0.5, 1.0, overhead), uHasOrigin);

    vColour = aColour;
    vAlpha = prominence;
    float size = uSize * uPixelRatio * mix(0.85, 1.3, prominence);
    gl_PointSize = clamp(size * (8.0 / max(0.001, -mvPosition.z)), 1.5, 5.5);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  varying vec3 vColour;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float core = smoothstep(1.0, 0.1, d);
    float alpha = core * vAlpha;
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(vColour, alpha);
  }
`;

export interface StarlinkField {
  points: THREE.Points;
  count: number;
  setVisible(visible: boolean): void;
  /** Restricts prominence to satellites overhead the given location. */
  setOrigin(location: LatLon | null): void;
  setPixelRatio(ratio: number): void;
  update(dtMs: number): void;
}

/**
 * Central angle within which a satellite is usable from the ground. Derived
 * from the geometric horizon at the shell altitude, tightened to a ~25 degree
 * elevation mask, which is roughly what a user terminal wants.
 */
function usableConeCos(altitudeKm: number): number {
  const elevationMask = THREE.MathUtils.degToRad(25);
  const ratio = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitudeKm);
  const centralAngle = Math.acos(Math.min(1, ratio * Math.cos(elevationMask))) - elevationMask;
  return Math.cos(Math.max(0.05, centralAngle));
}

export function createStarlinkField(records: readonly { line1: string; line2: string }[]): StarlinkField {
  const set: OrbitSet = buildOrbitSet(records);
  const positions = new Float32Array(set.count * 3);
  const colours = new Float32Array(set.count * 3);

  for (let i = 0; i < set.count; i++) {
    const colour = shellColour(set.inclinationDeg[i], set.altitudeKm[i]);
    colours[i * 3] = colour[0];
    colours[i * 3 + 1] = colour[1];
    colours[i * 3 + 2] = colour[2];
  }

  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("aColour", new THREE.BufferAttribute(colours, 3));
  // Positions change every frame, so let three skip its bounds recomputation
  // and use a sphere we know encloses the whole constellation.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), EARTH_RADIUS_UNITS * 2);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uOriginDirection: { value: new THREE.Vector3(1, 0, 0) },
      uConeCos: { value: usableConeCos(550) },
      uHasOrigin: { value: 0 },
      uSize: { value: 2.4 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.visible = false;

  const startJulianDate = dateToJulian(Date.now());
  let simulatedSeconds = 0;
  let visible = false;

  // Seed positions immediately so the first frame after switching Starlink on
  // is already correct rather than showing everything stacked at the origin.
  propagate(set, startJulianDate, EARTH_RADIUS_UNITS / EARTH_RADIUS_KM, positions);
  positionAttribute.needsUpdate = true;

  function setVisible(next: boolean): void {
    visible = next;
    points.visible = next;
  }

  function setOrigin(location: LatLon | null): void {
    if (!location) {
      material.uniforms.uHasOrigin.value = 0;
      return;
    }
    const direction = latLonToVector3(location, 1).normalize();
    (material.uniforms.uOriginDirection.value as THREE.Vector3).copy(direction);
    material.uniforms.uHasOrigin.value = 1;
  }

  function setPixelRatio(ratio: number): void {
    material.uniforms.uPixelRatio.value = ratio;
  }

  function update(dtMs: number): void {
    if (!visible) return;
    if (!reducedMotion.value) simulatedSeconds += (dtMs / 1000) * ORBIT_TIME_SCALE;
    const julianDate = startJulianDate + simulatedSeconds / 86400;
    propagate(set, julianDate, EARTH_RADIUS_UNITS / EARTH_RADIUS_KM, positions);
    positionAttribute.needsUpdate = true;
  }

  return { points, count: set.count, setVisible, setOrigin, setPixelRatio, update };
}
