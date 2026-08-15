import * as THREE from "three";
import type { LatLon } from "../data/types";
import { latLonToVector3 } from "../globe/geometry";
import { reducedMotion } from "../reduced-motion";
import { EARTH_RADIUS_KM, EARTH_RADIUS_UNITS, ORBIT_TIME_SCALE, PALETTE } from "./constants";
import { buildOrbitSet, dateToJulian, orbitTrack, propagate, type OrbitSet } from "./orbits";

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
  uniform float uIsolate;
  uniform float uSize;
  varying vec3 vColour;
  varying float vAlpha;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

    // When an origin is chosen the satellites actually overhead there step
    // forward. The rest stay clearly visible -- the whole constellation is the
    // point of the picture -- they just sit back to about half strength.
    // Isolating goes further and removes them outright, which is what makes
    // "only the satellites that can serve you" legible.
    float overhead = step(uConeCos, dot(normalize(position), uOriginDirection));
    float dimmed = mix(1.0, mix(0.5, 1.0, overhead), uHasOrigin);
    float prominence = mix(dimmed, overhead, uIsolate);

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
  /** Faint pulsing orbit rings for the satellites currently serving the origin. */
  tracks: THREE.LineSegments;
  count: number;
  setVisible(visible: boolean): void;
  /** Restricts prominence to satellites overhead the given location. */
  setOrigin(location: LatLon | null): void;
  /**
   * Hides everything that cannot serve the origin and draws orbit rings for
   * what remains, rather than merely dimming the rest.
   */
  setIsolated(isolated: boolean): void;
  /**
   * Multiplier on the 10x default, so 1 is the browsing speed and 0.1 is real
   * time — which is what makes a single relay hop readable.
   */
  setTimeScale(scale: number): void;
  /** Indices of the satellites currently overhead the origin, nearest zenith first. */
  servingSatellites(): number[];
  /** Current world position of one satellite, for aiming the camera at it. */
  positionOf(index: number, out: THREE.Vector3): THREE.Vector3;
  setPixelRatio(ratio: number): void;
  update(dtMs: number): void;
}

/** How many orbit rings to draw at once. Every serving satellite would be a
 *  thicket; a handful reads as "these are the ones that can see you". */
const MAX_TRACKS = 8;

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
      uIsolate: { value: 0 },
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

  // --- orbit rings for the serving satellites ---

  const TRACK_SAMPLES = 128;
  const trackPositions = new Float32Array(MAX_TRACKS * TRACK_SAMPLES * 2 * 3);
  const trackGeometry = new THREE.BufferGeometry();
  const trackAttribute = new THREE.BufferAttribute(trackPositions, 3);
  trackAttribute.setUsage(THREE.DynamicDrawUsage);
  trackGeometry.setAttribute("position", trackAttribute);

  // Position along each ring, 0..1. Fixed for the life of the buffer: every
  // ring has the same sample count, so a vertex's phase never changes even as
  // the positions are rewritten for a different satellite.
  const trackPhases = new Float32Array(MAX_TRACKS * TRACK_SAMPLES * 2);
  for (let ring = 0; ring < MAX_TRACKS; ring++) {
    for (let i = 0; i < TRACK_SAMPLES; i++) {
      const base = (ring * TRACK_SAMPLES + i) * 2;
      trackPhases[base] = i / TRACK_SAMPLES;
      trackPhases[base + 1] = (i + 1) / TRACK_SAMPLES;
    }
  }
  trackGeometry.setAttribute("aPhase", new THREE.BufferAttribute(trackPhases, 1));
  trackGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), EARTH_RADIUS_UNITS * 2);

  /*
   * The pulse travels around the ring rather than fading the whole thing in and
   * out. A global blink reads as "this line is highlighted"; a bright arc
   * sweeping the loop reads as something going round, which is what an orbit
   * is. `aPhase` is each vertex's position along its own ring, 0..1.
   */
  const trackMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColour: { value: new THREE.Color(PALETTE.orbitTrack) },
      uOpacity: { value: 0 },
      uSweep: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      varying float vPhase;
      void main() {
        vPhase = aPhase;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform vec3 uColour;
      uniform float uOpacity;
      uniform float uSweep;
      varying float vPhase;
      void main() {
        // Distance around the loop from the sweep head, wrapped so the band
        // crosses the seam without a seam.
        float d = abs(fract(vPhase - uSweep + 0.5) - 0.5);
        float head = smoothstep(0.16, 0.0, d);
        float alpha = uOpacity * (0.45 + 0.55 * head);
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uColour, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const tracks = new THREE.LineSegments(trackGeometry, trackMaterial);
  tracks.frustumCulled = false;
  tracks.visible = false;

  const startJulianDate = dateToJulian(Date.now());
  const unitsPerKm = EARTH_RADIUS_UNITS / EARTH_RADIUS_KM;
  let simulatedSeconds = 0;
  let visible = false;
  let isolated = false;
  let timeScale = 1;
  let originDirection: THREE.Vector3 | null = null;
  let serving: number[] = [];
  let pulseSeconds = 0;

  // Seed positions immediately so the first frame after switching Starlink on
  // is already correct rather than showing everything stacked at the origin.
  propagate(set, startJulianDate, unitsPerKm, positions);
  positionAttribute.needsUpdate = true;

  function currentJulianDate(): number {
    return startJulianDate + simulatedSeconds / 86400;
  }

  function setVisible(next: boolean): void {
    visible = next;
    points.visible = next;
    tracks.visible = next && isolated;
  }

  function setOrigin(location: LatLon | null): void {
    if (!location) {
      originDirection = null;
      serving = [];
      material.uniforms.uHasOrigin.value = 0;
      return;
    }
    originDirection = latLonToVector3(location, 1).normalize();
    (material.uniforms.uOriginDirection.value as THREE.Vector3).copy(originDirection);
    material.uniforms.uHasOrigin.value = 1;
    recomputeServing();
  }

  /** Satellites inside the usable cone, ordered by how close to overhead they are. */
  function recomputeServing(): void {
    if (!originDirection) {
      serving = [];
      return;
    }
    const coneCos = material.uniforms.uConeCos.value as number;
    const found: { index: number; alignment: number }[] = [];
    for (let i = 0; i < set.count; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const length = Math.hypot(x, y, z) || 1;
      const alignment = (x * originDirection.x + y * originDirection.y + z * originDirection.z) / length;
      if (alignment >= coneCos) found.push({ index: i, alignment });
    }
    found.sort((a, b) => b.alignment - a.alignment);
    serving = found.map((entry) => entry.index);
  }

  function rebuildTracks(): void {
    const julianDate = currentJulianDate();
    const chosen = serving.slice(0, MAX_TRACKS);
    let cursor = 0;

    for (const index of chosen) {
      const ring = orbitTrack(set, index, julianDate, unitsPerKm, TRACK_SAMPLES);
      // Expand the polyline into discrete segments so every ring lives in the
      // one LineSegments buffer and costs a single draw call.
      for (let i = 0; i < TRACK_SAMPLES; i++) {
        trackPositions[cursor++] = ring[i * 3];
        trackPositions[cursor++] = ring[i * 3 + 1];
        trackPositions[cursor++] = ring[i * 3 + 2];
        trackPositions[cursor++] = ring[(i + 1) * 3];
        trackPositions[cursor++] = ring[(i + 1) * 3 + 1];
        trackPositions[cursor++] = ring[(i + 1) * 3 + 2];
      }
    }
    trackPositions.fill(0, cursor);
    trackAttribute.needsUpdate = true;
    trackGeometry.setDrawRange(0, (cursor / 3) | 0);
  }

  function setIsolated(next: boolean): void {
    isolated = next;
    material.uniforms.uIsolate.value = next ? 1 : 0;
    tracks.visible = visible && next;
    if (next) {
      recomputeServing();
      rebuildTracks();
    }
  }

  function setTimeScale(scale: number): void {
    timeScale = Math.max(0, scale);
  }

  function servingSatellites(): number[] {
    return serving;
  }

  function positionOf(index: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
  }

  function setPixelRatio(ratio: number): void {
    material.uniforms.uPixelRatio.value = ratio;
  }

  let sinceServingRefresh = 0;

  function update(dtMs: number): void {
    if (!visible) return;

    if (!reducedMotion.value) {
      simulatedSeconds += (dtMs / 1000) * ORBIT_TIME_SCALE * timeScale;
      pulseSeconds += dtMs / 1000;
    }
    propagate(set, currentJulianDate(), unitsPerKm, positions);
    positionAttribute.needsUpdate = true;

    if (!isolated) return;

    // Which satellites can see the origin genuinely changes as they move, so
    // the set is refreshed periodically rather than frozen at selection time.
    sinceServingRefresh += dtMs;
    if (sinceServingRefresh > 900) {
      sinceServingRefresh = 0;
      recomputeServing();
      rebuildTracks();
    }

    // Steady base brightness with the sweep supplying the motion, so the ring
    // is always readable and the pulse stays a hint rather than a flash.
    trackMaterial.uniforms.uOpacity.value = 0.42;
    trackMaterial.uniforms.uSweep.value = reducedMotion.value ? 0 : (pulseSeconds * 0.22) % 1;
  }

  return {
    points,
    tracks,
    count: set.count,
    setVisible,
    setOrigin,
    setIsolated,
    setTimeScale,
    servingSatellites,
    positionOf,
    setPixelRatio,
    update,
  };
}
