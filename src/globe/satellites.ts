import * as THREE from "three";
import type { LatLon } from "../data/types";
import { reducedMotion } from "../reduced-motion";
import { haversineKm, vector3ToLatLon } from "./geometry";

// A handful of approximate real Starlink shell inclinations (degrees), each
// populated with several orbital planes (right ascensions) of evenly-spaced
// satellites. This is a visually-believable distribution, not a live
// ephemeris -- see CLAUDE.md "Avoid fake precision".
const SHELLS = [
  { inclinationDeg: 53.2, planes: 6, perPlane: 9 },
  { inclinationDeg: 70, planes: 4, perPlane: 8 },
  { inclinationDeg: 97.6, planes: 5, perPlane: 8 },
  { inclinationDeg: 33, planes: 3, perPlane: 6 },
];

// Real LEO orbital period is roughly 95 minutes; the visualisation runs at
// 10x that rate so motion is visible on a human timescale (CLAUDE.md).
const REAL_PERIOD_SECONDS = 95 * 60;
const SPEED_MULTIPLIER = 10;
const BASE_ANGULAR_SPEED = (2 * Math.PI) / REAL_PERIOD_SECONDS;

// The relevance radius approximates a LEO satellite's ground-visibility cone.
const RELEVANCE_RADIUS_KM = 2200;

interface SatelliteDef {
  inclination: number;
  raan: number;
  phase0: number;
  speedScale: number;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildDefinitions(): SatelliteDef[] {
  const random = mulberry32(424242);
  const defs: SatelliteDef[] = [];
  for (const shell of SHELLS) {
    for (let p = 0; p < shell.planes; p++) {
      const raan = (p / shell.planes) * Math.PI * 2 + random() * 0.3;
      for (let s = 0; s < shell.perPlane; s++) {
        defs.push({
          inclination: (shell.inclinationDeg * Math.PI) / 180,
          raan,
          phase0: (s / shell.perPlane) * Math.PI * 2 + random() * 0.2,
          // Slight per-satellite speed variation so the shell doesn't move as one rigid, obviously-synchronised body.
          speedScale: 0.94 + random() * 0.12,
        });
      }
    }
  }
  return defs;
}

export interface SatelliteField {
  points: THREE.Points;
  update(dtMs: number, originLatLon: LatLon | null, starlinkOn: boolean): void;
}

export function buildSatelliteField(sphereRadius: number): SatelliteField {
  const defs = buildDefinitions();
  const count = defs.length;
  const orbitRadius = sphereRadius * 1.35;

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const worldPos = new THREE.Vector3();

  function satellitePosition(def: SatelliteDef, angle: number, out: THREE.Vector3): THREE.Vector3 {
    // Orbit in its own plane (radius, angle), then tilt by inclination and spin by RAAN.
    const x = Math.cos(angle) * orbitRadius;
    const y = Math.sin(angle) * orbitRadius;
    out.set(x, y, 0);
    out.applyAxisAngle(new THREE.Vector3(1, 0, 0), def.inclination);
    out.applyAxisAngle(new THREE.Vector3(0, 1, 0), def.raan);
    return out;
  }

  for (let i = 0; i < count; i++) {
    satellitePosition(defs[i], defs[i].phase0, worldPos);
    positions[i * 3] = worldPos.x;
    positions[i * 3 + 1] = worldPos.y;
    positions[i * 3 + 2] = worldPos.z;
    colors[i * 3] = 0.65;
    colors[i * 3 + 1] = 0.78;
    colors[i * 3 + 2] = 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 0.045,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.visible = false;

  let elapsedSeconds = 0;

  function update(dtMs: number, originLatLon: LatLon | null, starlinkOn: boolean): void {
    points.visible = starlinkOn;
    if (!starlinkOn) return;

    if (!reducedMotion.value) elapsedSeconds += (dtMs / 1000) * SPEED_MULTIPLIER;

    const posAttr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const colorAttr = geometry.getAttribute("color") as THREE.BufferAttribute;

    for (let i = 0; i < count; i++) {
      const def = defs[i];
      const angle = def.phase0 + BASE_ANGULAR_SPEED * def.speedScale * elapsedSeconds;
      satellitePosition(def, angle, worldPos);
      posAttr.setXYZ(i, worldPos.x, worldPos.y, worldPos.z);

      let relevant = true;
      if (originLatLon) {
        const subSatellite = vector3ToLatLon(worldPos);
        relevant = haversineKm(subSatellite, originLatLon) <= RELEVANCE_RADIUS_KM;
      }
      if (relevant) {
        colorAttr.setXYZ(i, 0.68, 0.85, 1);
      } else {
        colorAttr.setXYZ(i, 0.16, 0.2, 0.28);
      }
    }
    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }

  return { points, update };
}
