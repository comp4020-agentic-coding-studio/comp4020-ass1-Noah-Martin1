import * as THREE from "three";
import type { PackedCity } from "../data/generated/datasets";
import { reducedMotion } from "../reduced-motion";
import { EARTH_RADIUS_UNITS, PALETTE } from "./constants";

/**
 * The planet: a filled-coastline sphere, an atmospheric halo, and the city
 * sparkle field.
 *
 * The sphere is deliberately *not* lit by a directional light. The reference
 * image shows an evenly-readable globe with city lights across the whole disc,
 * which a day/night terminator would destroy -- half the network would sit in
 * darkness. Shading instead comes from a view-dependent rim, so the planet
 * always reads as a sphere without ever hiding infrastructure.
 */

const EARTH_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalView;
  void main() {
    vUv = uv;
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EARTH_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform vec3 uRimColour;
  varying vec2 vUv;
  varying vec3 vNormalView;

  void main() {
    vec3 base = texture2D(uMap, vUv).rgb;
    // Facing ratio: 1 head-on, 0 at the silhouette.
    float facing = max(0.0, dot(vNormalView, vec3(0.0, 0.0, 1.0)));
    float rim = pow(1.0 - facing, 3.2);
    // Gentle centre-to-limb darkening, then a bright atmospheric edge.
    vec3 shaded = base * (0.86 + 0.14 * facing);
    gl_FragColor = vec4(shaded + uRimColour * rim * 0.38, 1.0);
  }
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uColour;
  varying vec3 vNormalView;
  void main() {
    // Rendered on the inside of a slightly larger sphere, so the strongest
    // value lands just outside the planet's silhouette and falls away.
    float intensity = pow(0.62 - dot(vNormalView, vec3(0.0, 0.0, 1.0)), 3.6);
    intensity = clamp(intensity, 0.0, 1.0);
    gl_FragColor = vec4(uColour * intensity * 0.75, intensity * 0.6);
  }
`;

const CITY_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  uniform float uPixelRatio;
  uniform float uTime;
  uniform float uTwinkle;
  uniform float uScale;
  varying float vAlpha;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float flicker = 1.0 - uTwinkle * 0.3 * (0.5 + 0.5 * sin(uTime * 2.1 + aPhase));
    vAlpha = flicker;
    // Perspective-scaled, then clamped so dense regions stay legible when
    // zoomed right out and don't turn into blobs when zoomed right in.
    float size = aSize * uScale / max(0.001, -mvPosition.z);
    gl_PointSize = clamp(size, 1.0, 9.0) * uPixelRatio;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const CITY_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uColour;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float core = smoothstep(1.0, 0.0, d);
    float alpha = core * core * vAlpha;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColour, alpha);
  }
`;

export interface Earth {
  group: THREE.Group;
  mesh: THREE.Mesh;
  radius: number;
  /** Swaps in a crisper coastline once the higher-detail dataset arrives. */
  setLandTexture(texture: THREE.Texture): void;
  setCities(cities: PackedCity[]): void;
  setPixelRatio(ratio: number): void;
  update(dtMs: number): void;
}

function latLonToVector3(lat: number, lon: number, radius: number, out: THREE.Vector3): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  out.x = -radius * Math.sin(phi) * Math.cos(theta);
  out.y = radius * Math.cos(phi);
  out.z = radius * Math.sin(phi) * Math.sin(theta);
  return out;
}

export function createEarth(): Earth {
  const group = new THREE.Group();
  const radius = EARTH_RADIUS_UNITS;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null },
      uRimColour: { value: new THREE.Color(PALETTE.atmosphere) },
    },
    vertexShader: EARTH_VERTEX,
    fragmentShader: EARTH_FRAGMENT,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 128, 96), material);
  group.add(mesh);

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.13, 64, 48),
    new THREE.ShaderMaterial({
      uniforms: { uColour: { value: new THREE.Color(PALETTE.atmosphere) } },
      vertexShader: EARTH_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  group.add(atmosphere);

  const cityMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColour: { value: new THREE.Color(PALETTE.city) },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uTime: { value: 0 },
      uTwinkle: { value: reducedMotion.value ? 0 : 1 },
      uScale: { value: 9 },
    },
    vertexShader: CITY_VERTEX,
    fragmentShader: CITY_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  let cityPoints: THREE.Points | null = null;

  function setCities(cities: PackedCity[]): void {
    if (cityPoints) {
      group.remove(cityPoints);
      cityPoints.geometry.dispose();
    }

    const positions = new Float32Array(cities.length * 3);
    const sizes = new Float32Array(cities.length);
    const phases = new Float32Array(cities.length);
    const vector = new THREE.Vector3();

    for (let i = 0; i < cities.length; i++) {
      const [lon, lat, popRank] = cities[i];
      // Lifted a hair off the surface so the sphere still occludes the far
      // side, which is what keeps the globe reading as solid.
      latLonToVector3(lat, lon, radius * 1.002, vector);
      positions[i * 3] = vector.x;
      positions[i * 3 + 1] = vector.y;
      positions[i * 3 + 2] = vector.z;
      sizes[i] = 0.6 + (popRank / 10) * 1.8;
      phases[i] = (i * 2.399963) % (Math.PI * 2);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));

    cityPoints = new THREE.Points(geometry, cityMaterial);
    group.add(cityPoints);
  }

  function setLandTexture(texture: THREE.Texture): void {
    const previous = material.uniforms.uMap.value as THREE.Texture | null;
    material.uniforms.uMap.value = texture;
    material.needsUpdate = true;
    if (previous) previous.dispose();
  }

  function setPixelRatio(ratio: number): void {
    cityMaterial.uniforms.uPixelRatio.value = ratio;
  }

  let elapsedSeconds = 0;

  function update(dtMs: number): void {
    const twinkling = !reducedMotion.value;
    cityMaterial.uniforms.uTwinkle.value = twinkling ? 1 : 0;
    if (!twinkling) return;
    elapsedSeconds += dtMs / 1000;
    cityMaterial.uniforms.uTime.value = elapsedSeconds;
  }

  return { group, mesh, radius, setLandTexture, setCities, setPixelRatio, update };
}
