import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Route, RouteStep } from "../data/types";
import { latLonToVector3 } from "../globe/geometry";
import { reducedMotion } from "../reduced-motion";
import { EARTH_RADIUS_UNITS, PALETTE, altitudeToRadius } from "./constants";

/**
 * The active traceroute: a glowing path over the globe with a marker at every
 * hop and a packet travelling the segment you're currently reading about.
 *
 * Line width is the reason this uses Line2 rather than THREE.Line -- WebGL
 * clamps native line width to one pixel on most platforms, which would leave
 * the route as a hairline instead of the bright ribbon the reference shows.
 */

const ARC_SEGMENTS = 96;
const SURFACE_RADIUS = EARTH_RADIUS_UNITS * 1.004;
const SATELLITE_RADIUS = altitudeToRadius(550);

const NODE_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aReached;
  uniform float uPixelRatio;
  varying float vReached;
  void main() {
    vReached = aReached;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uPixelRatio * (3.0 / max(0.001, -mvPosition.z)), 3.0, 22.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const NODE_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uColour;
  varying float vReached;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    // A bright core inside a softer ring reads as a lit node rather than a blob.
    float core = smoothstep(0.55, 0.0, d);
    float halo = smoothstep(1.0, 0.35, d) * 0.45;
    float alpha = (core + halo) * mix(0.28, 1.0, vReached);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColour, alpha);
  }
`;

/** Height of a step above the centre of the Earth, in scene units. */
function radiusFor(step: RouteStep): number {
  return step.kind === "satellite" ? SATELLITE_RADIUS : SURFACE_RADIUS;
}

/**
 * Samples the path between two hops. Direction is slerped while radius is
 * interpolated separately, so a climb to orbit curves away from the surface
 * instead of cutting through it, and a fibre hop stays hugging the ground.
 */
function arcBetween(from: THREE.Vector3, to: THREE.Vector3, lift: number): THREE.Vector3[] {
  const fromRadius = from.length();
  const toRadius = to.length();
  const fromDirection = from.clone().normalize();
  const toDirection = to.clone().normalize();
  const angle = fromDirection.angleTo(toDirection);

  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const t = i / ARC_SEGMENTS;
    const direction =
      angle < 1e-6
        ? fromDirection.clone()
        : fromDirection
            .clone()
            .multiplyScalar(Math.sin((1 - t) * angle) / Math.sin(angle))
            .addScaledVector(toDirection, Math.sin(t * angle) / Math.sin(angle))
            .normalize();
    // A gentle bulge at the midpoint keeps long fibre runs off the terrain.
    const radius = fromRadius + (toRadius - fromRadius) * t + Math.sin(t * Math.PI) * lift;
    points.push(direction.multiplyScalar(radius));
  }
  return points;
}

interface Segment {
  line: Line2;
  material: LineMaterial;
  points: THREE.Vector3[];
}

export interface RouteLayer {
  group: THREE.Group;
  setRoute(route: Route | null): void;
  setStage(index: number): void;
  setResolution(width: number, height: number): void;
  setPixelRatio(ratio: number): void;
  update(dtMs: number): void;
}

export function createRouteLayer(): RouteLayer {
  const group = new THREE.Group();
  const segmentGroup = new THREE.Group();
  group.add(segmentGroup);

  let segments: Segment[] = [];
  let resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
  let stageIndex = 0;
  let elapsedMs = 0;

  // --- hop markers ---

  const nodeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColour: { value: new THREE.Color(PALETTE.routeNode) },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: NODE_VERTEX,
    fragmentShader: NODE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  let nodePoints: THREE.Points | null = null;

  // --- the travelling packet ---

  const packetMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColour: { value: new THREE.Color(PALETTE.packet) },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: NODE_VERTEX,
    fragmentShader: NODE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const packetGeometry = new THREE.BufferGeometry();
  packetGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
  packetGeometry.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array([9]), 1));
  packetGeometry.setAttribute("aReached", new THREE.BufferAttribute(new Float32Array([1]), 1));
  const packet = new THREE.Points(packetGeometry, packetMaterial);
  packet.frustumCulled = false;
  packet.visible = false;
  group.add(packet);

  function clear(): void {
    for (const segment of segments) {
      segmentGroup.remove(segment.line);
      segment.line.geometry.dispose();
      segment.material.dispose();
    }
    segments = [];
    if (nodePoints) {
      group.remove(nodePoints);
      nodePoints.geometry.dispose();
      nodePoints = null;
    }
    packet.visible = false;
  }

  function setRoute(route: Route | null): void {
    clear();
    if (!route || route.steps.length < 2) return;

    const positions = route.steps.map((step) => latLonToVector3(step.location, radiusFor(step)));

    for (let i = 1; i < route.steps.length; i++) {
      const step = route.steps[i];
      // Satellite legs already stand off the surface; ground legs get a small
      // bulge so they read as arcs rather than painted lines.
      const lift = step.kind === "satellite" || route.steps[i - 1].kind === "satellite" ? 0 : 0.02;
      const points = arcBetween(positions[i - 1], positions[i], lift);

      const geometry = new LineGeometry();
      geometry.setPositions(points.flatMap((point) => [point.x, point.y, point.z]));

      const material = new LineMaterial({
        color: PALETTE.route,
        linewidth: 3.2,
        transparent: true,
        opacity: 0.18,
        depthTest: true,
      });
      material.resolution.copy(resolution);

      const line = new Line2(geometry, material);
      line.computeLineDistances();
      segmentGroup.add(line);
      segments.push({ line, material, points });
    }

    const nodeGeometry = new THREE.BufferGeometry();
    const nodePositions = new Float32Array(positions.length * 3);
    const nodeSizes = new Float32Array(positions.length);
    positions.forEach((position, index) => {
      nodePositions[index * 3] = position.x;
      nodePositions[index * 3 + 1] = position.y;
      nodePositions[index * 3 + 2] = position.z;
      // Endpoints matter most, so give them a little more presence.
      const isEndpoint = index === 0 || index === positions.length - 1;
      nodeSizes[index] = isEndpoint ? 7.5 : 5.5;
    });
    nodeGeometry.setAttribute("position", new THREE.BufferAttribute(nodePositions, 3));
    nodeGeometry.setAttribute("aSize", new THREE.BufferAttribute(nodeSizes, 1));
    nodeGeometry.setAttribute("aReached", new THREE.BufferAttribute(new Float32Array(positions.length), 1));
    nodePoints = new THREE.Points(nodeGeometry, nodeMaterial);
    nodePoints.frustumCulled = false;
    group.add(nodePoints);

    setStage(stageIndex);
  }

  function setStage(index: number): void {
    stageIndex = index;
    for (let i = 0; i < segments.length; i++) {
      // Segment i carries the request into step i+1, so it is "travelled" once
      // the reader has scrolled past that step.
      segments[i].material.opacity = i < index ? 0.95 : 0.18;
    }
    if (nodePoints) {
      const reached = nodePoints.geometry.getAttribute("aReached") as THREE.BufferAttribute;
      for (let i = 0; i < reached.count; i++) reached.setX(i, i <= index ? 1 : 0);
      reached.needsUpdate = true;
    }
  }

  function setResolution(width: number, height: number): void {
    resolution = new THREE.Vector2(width, height);
    for (const segment of segments) segment.material.resolution.copy(resolution);
  }

  function setPixelRatio(ratio: number): void {
    nodeMaterial.uniforms.uPixelRatio.value = ratio;
    packetMaterial.uniforms.uPixelRatio.value = ratio;
  }

  function update(dtMs: number): void {
    if (!reducedMotion.value) elapsedMs += dtMs;

    // The packet rides the segment the current stage is describing.
    const active = segments[Math.min(segments.length - 1, Math.max(0, stageIndex - 1))];
    if (!active) {
      packet.visible = false;
      return;
    }
    const t = reducedMotion.value ? 0.5 : (elapsedMs % 2400) / 2400;
    const position = active.points[Math.floor(t * (active.points.length - 1))];
    const attribute = packetGeometry.getAttribute("position") as THREE.BufferAttribute;
    attribute.setXYZ(0, position.x, position.y, position.z);
    attribute.needsUpdate = true;
    packet.visible = stageIndex > 0;
  }

  return { group, setRoute, setStage, setResolution, setPixelRatio, update };
}
