import * as THREE from "three";
import { CITIES, CITY_BY_ID, GROUND_STATIONS, HUB_EDGES } from "../data/geo";
import { greatCircleArcPoints, latLonToVector3 } from "../globe/geometry";
import type { LayerVisibility } from "../state";
import { EARTH_RADIUS_UNITS, PALETTE } from "./constants";

/**
 * The always-present infrastructure the routes are drawn on top of: the fibre
 * backbone, cell towers, Starlink ground stations and data centres.
 *
 * This layer is deliberately quiet by default. The toggles raise and lower
 * emphasis rather than adding or removing geometry, so turning one on tells you
 * where something is without the globe ever becoming a different picture
 * (CLAUDE.md: "Off = infrastructure remains subtle").
 */

const SURFACE = EARTH_RADIUS_UNITS * 1.006;

/**
 * Marker glyphs. Shape carries the meaning alongside colour so the layers stay
 * distinguishable without relying on hue alone.
 */
const enum Glyph {
  Dot = 0,
  Ring = 1,
  Square = 2,
  Diamond = 3,
}

const MARKER_VERTEX = /* glsl */ `
  uniform float uPixelRatio;
  uniform float uSize;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(uSize * uPixelRatio * (3.0 / max(0.001, -mvPosition.z)), 2.0, 16.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const MARKER_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uColour;
  uniform float uOpacity;
  uniform int uGlyph;

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float alpha = 0.0;

    if (uGlyph == 0) {
      alpha = smoothstep(0.5, 0.1, length(p));
    } else if (uGlyph == 1) {
      float r = length(p);
      alpha = smoothstep(0.5, 0.42, r) * smoothstep(0.24, 0.32, r);
    } else if (uGlyph == 2) {
      vec2 d = abs(p);
      alpha = 1.0 - step(0.36, max(d.x, d.y));
    } else {
      alpha = 1.0 - step(0.44, abs(p.x) + abs(p.y));
    }

    alpha *= uOpacity;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColour, alpha);
  }
`;

interface Markers {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
}

function buildMarkers(
  locations: readonly { lat: number; lon: number }[],
  colour: number,
  glyph: Glyph,
  size: number,
): Markers {
  const positions = new Float32Array(locations.length * 3);
  const vector = new THREE.Vector3();
  locations.forEach((location, index) => {
    latLonToVector3(location, SURFACE, vector);
    positions[index * 3] = vector.x;
    positions[index * 3 + 1] = vector.y;
    positions[index * 3 + 2] = vector.z;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColour: { value: new THREE.Color(colour) },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uOpacity: { value: 0.3 },
      uSize: { value: size },
      uGlyph: { value: glyph },
    },
    vertexShader: MARKER_VERTEX,
    fragmentShader: MARKER_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return { points: new THREE.Points(geometry, material), material };
}

export interface NetworkLayer {
  group: THREE.Group;
  setLayers(layers: LayerVisibility): void;
  setPixelRatio(ratio: number): void;
}

export function createNetworkLayer(): NetworkLayer {
  const group = new THREE.Group();

  // --- fibre backbone: every hub edge flattened into one LineSegments ---

  const vertices: number[] = [];
  const colours: number[] = [];
  const terrestrial = new THREE.Color(PALETTE.cableTerrestrial);
  const submarine = new THREE.Color(PALETTE.cableSubmarine);

  for (const edge of HUB_EDGES) {
    const a = CITY_BY_ID.get(edge.a);
    const b = CITY_BY_ID.get(edge.b);
    if (!a || !b) continue;
    const colour = edge.kind === "submarine" ? submarine : terrestrial;
    const points = greatCircleArcPoints(a, b, EARTH_RADIUS_UNITS * 1.002, 0.012, 64);
    for (let i = 1; i < points.length; i++) {
      vertices.push(points[i - 1].x, points[i - 1].y, points[i - 1].z, points[i].x, points[i].y, points[i].z);
      colours.push(colour.r, colour.g, colour.b, colour.r, colour.g, colour.b);
    }
  }

  const cableGeometry = new THREE.BufferGeometry();
  cableGeometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  cableGeometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  const cableMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  group.add(new THREE.LineSegments(cableGeometry, cableMaterial));

  // --- markers, one Points per layer so a toggle is a single uniform write ---

  const towerCities = CITIES.filter((city) => city.kinds.includes("origin") && !city.kinds.includes("hub"));
  const serverCities = CITIES.filter((city) => city.kinds.includes("server"));

  const towers = buildMarkers(towerCities, PALETTE.routeNode, Glyph.Diamond, 4.5);
  const groundStations = buildMarkers(GROUND_STATIONS, PALETTE.groundStation, Glyph.Ring, 6);
  const servers = buildMarkers(serverCities, PALETTE.satelliteActive, Glyph.Square, 5);

  for (const markers of [towers, groundStations, servers]) group.add(markers.points);

  function setLayers(layers: LayerVisibility): void {
    cableMaterial.opacity = layers.fibre ? 0.85 : 0.28;
    towers.material.uniforms.uOpacity.value = layers.towers ? 0.95 : 0.22;
    groundStations.material.uniforms.uOpacity.value = layers.groundStations ? 0.95 : 0.22;
    servers.material.uniforms.uOpacity.value = layers.servers ? 0.95 : 0.3;
  }

  function setPixelRatio(ratio: number): void {
    for (const markers of [towers, groundStations, servers]) {
      markers.material.uniforms.uPixelRatio.value = ratio;
    }
  }

  return { group, setLayers, setPixelRatio };
}
