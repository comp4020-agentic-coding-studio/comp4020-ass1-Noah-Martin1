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
  varying float vFacing;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    // Markers sit just above a sphere centred on the origin, and additive
    // blending ignores the depth buffer, so the far hemisphere would otherwise
    // shine straight through the planet. Facing < 0 means the globe is between
    // this marker and the eye.
    vFacing = dot(normalize(world.xyz), normalize(cameraPosition - world.xyz));
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
  varying float vFacing;

  void main() {
    if (vFacing < 0.0) discard;

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

/**
 * Data centres carry a per-point size because tier matters here: a hyperscale
 * campus and a single regional facility should not look identical when the user
 * is choosing between them as a destination.
 */
const DC_VERTEX = /* glsl */ `
  attribute float aSize;
  uniform float uPixelRatio;
  uniform float uScale;
  varying float vFacing;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vFacing = dot(normalize(world.xyz), normalize(cameraPosition - world.xyz));
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uScale * uPixelRatio * (3.0 / max(0.001, -mvPosition.z)), 3.0, 22.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const DC_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uColour;
  uniform float uOpacity;
  varying float vFacing;

  void main() {
    if (vFacing < 0.0) discard;
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p) * 2.0;
    // A filled core inside a ring: reads as a facility marker at a glance and
    // stays distinguishable from the plain dots the towers use.
    float core = smoothstep(0.55, 0.3, r);
    float ring = smoothstep(1.0, 0.86, r) * smoothstep(0.66, 0.8, r);
    float alpha = (core * 0.85 + ring) * uOpacity;
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
  /** Swaps the schematic backbone for the real submarine cable network. */
  setCables(segments: readonly (readonly [number, number][])[]): void;
  /** Swaps the modelled ground stations for real Starlink gateway sites. */
  setGateways(points: readonly (readonly [number, number])[]): void;
  /** Adds the real cell tower field, drawn under the "5G towers" toggle. */
  setTowers(points: readonly (readonly [number, number, number])[]): void;
  /** Adds the data centre field, drawn under the "Servers" toggle. */
  setDataCentres(points: readonly (readonly [number, number, number, string])[]): void;
  /**
   * Forces the data centres bright regardless of the toggle. The destination
   * step has to show what can be chosen, whether or not the layer is switched
   * on — the toggle is a browsing preference, not a veto on the interaction.
   */
  setDataCentreEmphasis(on: boolean): void;
  /** Rings the data centre under the cursor, or clears it with null. */
  highlightDataCentre(location: { lat: number; lon: number } | null): void;
  /**
   * Marks the origin the user already committed to. Without this the chosen
   * starting point vanishes while they pick a destination — there is no route
   * to draw yet, so nothing else on the globe remembers the choice.
   */
  markOrigin(location: { lat: number; lon: number } | null): void;
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
  /*
   * The real cable network carries no per-vertex colour, and a vertexColors
   * material with no colour attribute reads WebGL's default (0,0,0) — which
   * drew the whole submarine network as black scribble over the globe. It gets
   * its own flat material, tinted submarine blue.
   */
  const realCableMaterial = new THREE.LineBasicMaterial({
    color: PALETTE.cableSubmarine,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  // The schematic backbone stands in until the real cable network loads.
  const schematicCables = new THREE.LineSegments(cableGeometry, cableMaterial);
  group.add(schematicCables);

  // --- markers, one Points per layer so a toggle is a single uniform write ---

  const towerCities = CITIES.filter((city) => city.kinds.includes("origin") && !city.kinds.includes("hub"));
  const serverCities = CITIES.filter((city) => city.kinds.includes("server"));

  const towers = buildMarkers(towerCities, PALETTE.routeNode, Glyph.Diamond, 4.5);
  let groundStations = buildMarkers(GROUND_STATIONS, PALETTE.groundStation, Glyph.Ring, 6);
  const servers = buildMarkers(serverCities, PALETTE.satelliteActive, Glyph.Square, 5);

  for (const markers of [towers, groundStations, servers]) group.add(markers.points);

  let layerState: LayerVisibility = { fibre: false, towers: false, groundStations: false, servers: false };
  let pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  // --- real submarine cables, once they load ---

  let realCables: THREE.LineSegments | null = null;

  /**
   * Replaces the schematic hub-to-hub arcs with the published cable network.
   * The arcs stay in the scene graph but are hidden: they still describe which
   * hops a route may take, whereas these lines describe where cable actually
   * runs, and the two should never be confused for each other.
   */
  function setCables(segments: readonly (readonly [number, number][])[]): void {
    if (realCables) {
      group.remove(realCables);
      realCables.geometry.dispose();
    }

    const points: number[] = [];
    const vector = new THREE.Vector3();
    const radius = EARTH_RADIUS_UNITS * 1.0015;

    for (const line of segments) {
      for (let i = 1; i < line.length; i++) {
        const [lonA, latA] = line[i - 1];
        const [lonB, latB] = line[i];
        latLonToVector3({ lat: latA, lon: lonA }, radius, vector);
        points.push(vector.x, vector.y, vector.z);
        latLonToVector3({ lat: latB, lon: lonB }, radius, vector);
        points.push(vector.x, vector.y, vector.z);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    realCables = new THREE.LineSegments(geometry, realCableMaterial);
    group.add(realCables);

    schematicCables.visible = false;
  }

  /*
   * 91k towers as a single Points cloud: one draw call, one buffer, a handful
   * of flops each. The measured cost on this scene is fill-rate, not object
   * count (see CLAUDE.md), and these are 2 px dots -- the constellation showed
   * 10.7k satellites are effectively free, and this behaves the same way.
   *
   * They stay dim until the toggle is switched on. At this density a bright
   * default would draw a second coastline over the real one.
   */
  let towerField: THREE.Points | null = null;
  let towerMaterial: THREE.ShaderMaterial | null = null;

  function setTowers(points: readonly (readonly [number, number, number])[]): void {
    if (towerField) {
      group.remove(towerField);
      towerField.geometry.dispose();
    }

    const positions = new Float32Array(points.length * 3);
    const vector = new THREE.Vector3();
    for (let i = 0; i < points.length; i++) {
      latLonToVector3({ lat: points[i][1], lon: points[i][0] }, SURFACE, vector);
      positions[i * 3] = vector.x;
      positions[i * 3 + 1] = vector.y;
      positions[i * 3 + 2] = vector.z;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    towerMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColour: { value: new THREE.Color(PALETTE.cellTower) },
        uPixelRatio: { value: pixelRatio },
        uOpacity: { value: 0.3 },
        uSize: { value: 2.6 },
        uGlyph: { value: Glyph.Dot },
      },
      vertexShader: MARKER_VERTEX,
      fragmentShader: MARKER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    towerField = new THREE.Points(geometry, towerMaterial);
    group.add(towerField);
    setLayers(layerState);
  }

  // --- data centres ---------------------------------------------------------

  let dataCentreField: THREE.Points | null = null;
  let dataCentreMaterial: THREE.ShaderMaterial | null = null;
  let dataCentreEmphasis = false;

  /** Point size per tier: regional, significant, major. */
  const TIER_SIZE = [4.2, 5.6, 7.4];

  function setDataCentres(points: readonly (readonly [number, number, number, string])[]): void {
    if (dataCentreField) {
      group.remove(dataCentreField);
      dataCentreField.geometry.dispose();
    }

    const positions = new Float32Array(points.length * 3);
    const sizes = new Float32Array(points.length);
    const vector = new THREE.Vector3();
    for (let i = 0; i < points.length; i++) {
      latLonToVector3({ lat: points[i][1], lon: points[i][0] }, SURFACE, vector);
      positions[i * 3] = vector.x;
      positions[i * 3 + 1] = vector.y;
      positions[i * 3 + 2] = vector.z;
      sizes[i] = TIER_SIZE[points[i][2]] ?? TIER_SIZE[0];
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));

    dataCentreMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColour: { value: new THREE.Color(PALETTE.dataCentre) },
        uPixelRatio: { value: pixelRatio },
        uOpacity: { value: 0.3 },
        uScale: { value: 1 },
      },
      vertexShader: DC_VERTEX,
      fragmentShader: DC_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    dataCentreField = new THREE.Points(geometry, dataCentreMaterial);
    group.add(dataCentreField);
    setLayers(layerState);
  }

  function setDataCentreEmphasis(on: boolean): void {
    dataCentreEmphasis = on;
    setLayers(layerState);
  }

  // The ring that marks the data centre the cursor has snapped to.
  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: PALETTE.dataCentreActive,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const highlight = new THREE.Mesh(new THREE.RingGeometry(0.028, 0.038, 32), highlightMaterial);
  highlight.visible = false;
  group.add(highlight);

  const highlightNormal = new THREE.Vector3();
  const highlightQuat = new THREE.Quaternion();
  const highlightPlane = new THREE.Vector3(0, 0, 1);

  function highlightDataCentre(location: { lat: number; lon: number } | null): void {
    if (!location) {
      highlight.visible = false;
      return;
    }
    latLonToVector3(location, EARTH_RADIUS_UNITS * 1.012, highlight.position);
    highlightNormal.copy(highlight.position).normalize();
    highlightQuat.setFromUnitVectors(highlightPlane, highlightNormal);
    highlight.quaternion.copy(highlightQuat);
    highlight.visible = true;
  }

  const originMaterial = new THREE.MeshBasicMaterial({
    color: PALETTE.route,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const originMarker = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.032, 28), originMaterial);
  originMarker.visible = false;
  group.add(originMarker);

  function markOrigin(location: { lat: number; lon: number } | null): void {
    if (!location) {
      originMarker.visible = false;
      return;
    }
    latLonToVector3(location, EARTH_RADIUS_UNITS * 1.012, originMarker.position);
    highlightNormal.copy(originMarker.position).normalize();
    highlightQuat.setFromUnitVectors(highlightPlane, highlightNormal);
    originMarker.quaternion.copy(highlightQuat);
    originMarker.visible = true;
  }

  function setGateways(gateways: readonly (readonly [number, number])[]): void {
    group.remove(groundStations.points);
    groundStations.points.geometry.dispose();
    groundStations.material.dispose();

    groundStations = buildMarkers(
      gateways.map(([lon, lat]) => ({ lat, lon })),
      PALETTE.groundStation,
      Glyph.Ring,
      5.5,
    );
    groundStations.material.uniforms.uPixelRatio.value = pixelRatio;
    group.add(groundStations.points);
    setLayers(layerState);
  }

  function setLayers(layers: LayerVisibility): void {
    layerState = layers;
    cableMaterial.opacity = layers.fibre ? 0.9 : 0.24;
    // 724 systems is a lot of line; the "on" state has to read as emphasis, not
    // as a mesh that swallows the coastlines underneath it.
    realCableMaterial.opacity = layers.fibre ? 0.55 : 0.14;
    towers.material.uniforms.uOpacity.value = layers.towers ? 0.95 : 0.22;
    // Much lower than the other layers at both ends: 91k additive dots reach
    // the same visual weight as a few dozen markers at a fraction of the alpha.
    if (towerMaterial) towerMaterial.uniforms.uOpacity.value = layers.towers ? 0.5 : 0.1;
    groundStations.material.uniforms.uOpacity.value = layers.groundStations ? 0.95 : 0.22;
    servers.material.uniforms.uOpacity.value = layers.servers ? 0.95 : 0.3;

    if (dataCentreMaterial) {
      // Emphasis outranks the toggle: during destination selection the user has
      // to be able to see what they are choosing between.
      const bright = dataCentreEmphasis || layers.servers;
      dataCentreMaterial.uniforms.uOpacity.value = bright ? 0.85 : 0.16;
      dataCentreMaterial.uniforms.uScale.value = dataCentreEmphasis ? 1.25 : 1;
    }
  }

  function setPixelRatio(ratio: number): void {
    pixelRatio = ratio;
    for (const markers of [towers, groundStations, servers]) {
      markers.material.uniforms.uPixelRatio.value = ratio;
    }
    if (towerMaterial) towerMaterial.uniforms.uPixelRatio.value = ratio;
    if (dataCentreMaterial) dataCentreMaterial.uniforms.uPixelRatio.value = ratio;
  }

  return {
    group,
    setLayers,
    setCables,
    setGateways,
    setTowers,
    setDataCentres,
    setDataCentreEmphasis,
    highlightDataCentre,
    markOrigin,
    setPixelRatio,
  };
}
