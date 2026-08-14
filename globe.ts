import * as THREE from "three";
import { LAND_RINGS } from "./land-outlines";

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}

const stage = required(document.querySelector<HTMLDivElement>("#globe-stage"), "#globe-stage not found");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const TEXTURE_WIDTH = 1024;
const TEXTURE_HEIGHT = 512;
const CLOUD_WIDTH = 1024;
const CLOUD_HEIGHT = 512;

type RGB = readonly [number, number, number];

const OCEAN_SHALLOW: RGB = [47, 161, 224];
const OCEAN_DEEP: RGB = [16, 76, 138];
const FOREST_LOW: RGB = [52, 108, 54];
const FOREST_HIGH: RGB = [122, 176, 88];
const DESERT: RGB = [200, 168, 104];
const ROCK: RGB = [123, 112, 101];
const SNOW: RGB = [246, 248, 250];

// --- small deterministic PRNG + 3D value noise, seamless in longitude -------
// Longitude is sampled on a circle (cos/sin) rather than a raw 0..1 coordinate
// so the noise field wraps cleanly at the antimeridian instead of showing a seam.

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

function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ ix, 0x27d4eb2d);
  h = Math.imul(h ^ iy, 0x165667b1);
  h = Math.imul(h ^ iz, 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep01(t: number): number {
  return fade(clamp01(t));
}

function bell(x: number, center: number, width: number): number {
  const d = (x - center) / width;
  return Math.exp(-d * d);
}

function mix3(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const xf = fade(x - x0);
  const yf = fade(y - y0);
  const zf = fade(z - z0);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;
  const c000 = hash3(x0, y0, z0, seed);
  const c100 = hash3(x1, y0, z0, seed);
  const c010 = hash3(x0, y1, z0, seed);
  const c110 = hash3(x1, y1, z0, seed);
  const c001 = hash3(x0, y0, z1, seed);
  const c101 = hash3(x1, y0, z1, seed);
  const c011 = hash3(x0, y1, z1, seed);
  const c111 = hash3(x1, y1, z1, seed);
  const x00 = lerp(c000, c100, xf);
  const x10 = lerp(c010, c110, xf);
  const x01 = lerp(c001, c101, xf);
  const x11 = lerp(c011, c111, xf);
  const y0i = lerp(x00, x10, yf);
  const y1i = lerp(x01, x11, yf);
  return lerp(y0i, y1i, zf);
}

function fbm3(x: number, y: number, z: number, seed: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// Samples a noise field on a circle in x/z so it tiles seamlessly around the
// sphere's longitude; `y` (latitude-ish) never wraps so it needs no such trick.
function sphereNoise(u: number, v: number, freq: number, seed: number, octaves: number): number {
  // True 3D unit-sphere embedding (not a flat circle of constant radius): lines
  // of longitude must converge to a point at the poles, or noise there aliases
  // into radial streaks since far-apart longitudes would otherwise map to
  // near-identical points on the globe but distant points in noise-space.
  const theta = u * Math.PI * 2;
  const phi = (v - 0.5) * Math.PI;
  const cosPhi = Math.cos(phi);
  const nx = Math.cos(theta) * cosPhi * freq;
  const nz = Math.sin(theta) * cosPhi * freq;
  const ny = Math.sin(phi) * freq;
  return fbm3(nx, ny, nz, seed, octaves);
}

// --- coastline rasterization ------------------------------------------------

interface Point {
  x: number;
  y: number;
}

function unwrapRing(ring: readonly (readonly [number, number])[], width: number, height: number): Point[] {
  const points: Point[] = [];
  let unwrappedLon = 0;
  let prevLon: number | null = null;
  for (const [lon, lat] of ring) {
    if (prevLon === null) {
      unwrappedLon = lon;
    } else {
      let delta = lon - prevLon;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      unwrappedLon += delta;
    }
    prevLon = lon;
    points.push({ x: ((unwrappedLon + 180) / 360) * width, y: ((90 - lat) / 180) * height });
  }
  return points;
}

// A landmass whose ring crosses the antimeridian needs to paint on both edges
// of the canvas, so each ring is traced three times, shifted a full texture
// width left/right -- whichever copy lands in bounds fills the seam correctly.
//
// A ring that encircles a pole (Antarctica's coastline sweeps a full 360deg of
// longitude without its data ever reaching lat -90, since the real South Pole
// is deep inland) unwraps to a start/end point a full canvas width apart even
// though their raw lon/lat are identical. Closing that with a straight line
// cuts across the canvas at the ring's own latitude instead of through the
// pole, leaving the whole polar cap outside the fill. Route the closing edge
// through the pole's canvas edge (y=0 north, y=height south) instead.
function traceRingWrapped(ctx: CanvasRenderingContext2D, points: Point[], width: number, height: number): void {
  const first = points[0];
  const last = points[points.length - 1];
  const spansPole = Math.abs(last.x - first.x) > width * 0.9;
  const avgY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  const poleY = avgY > height / 2 ? height : 0;
  for (const offset of [-width, 0, width]) {
    ctx.moveTo(first.x + offset, first.y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x + offset, points[i].y);
    if (spansPole) {
      ctx.lineTo(last.x + offset, poleY);
      ctx.lineTo(first.x + offset, poleY);
    }
    ctx.closePath();
  }
}

function buildLandMask(width: number, height: number): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = required(canvas.getContext("2d"), "2d context unavailable");
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  for (const ring of LAND_RINGS) {
    traceRingWrapped(ctx, unwrapRing(ring, width, height), width, height);
  }
  ctx.fill();

  const mask = new Uint8Array(width * height);
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4] > 128 ? 1 : 0;
  return mask;
}

function buildCoastMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const coast = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] !== 1) continue;
      const left = mask[y * width + ((x - 1 + width) % width)];
      const right = mask[y * width + ((x + 1) % width)];
      const up = y > 0 ? mask[i - width] : mask[i];
      const down = y + 1 < height ? mask[i + width] : mask[i];
      if (left === 0 || right === 0 || up === 0 || down === 0) coast[i] = 1;
    }
  }
  return coast;
}

function buildElevationField(width: number, height: number): Float32Array {
  const field = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      field[y * width + x] = sphereNoise(x / width, v, 3.4, 1337, 4);
    }
  }
  return field;
}

// --- biome coloring ----------------------------------------------------------

function landColor(elevation: number, absLat: number): RGB {
  let color = mix3(FOREST_LOW, FOREST_HIGH, clamp01(elevation * 1.3));

  const desert = bell(absLat, 25, 9) * (0.55 + 0.45 * elevation);
  color = mix3(color, DESERT, clamp01(desert));

  const rocky = smoothstep01((elevation - 0.58) / 0.22);
  color = mix3(color, ROCK, rocky * 0.85);

  const snowByLatitude = smoothstep01((absLat - 60) / 20);
  const snowByAltitude = smoothstep01((elevation - 0.78) / 0.12);
  color = mix3(color, SNOW, Math.max(snowByLatitude, snowByAltitude));

  return color;
}

function oceanColor(absLat: number, elevation: number): RGB {
  const depth = clamp01((absLat / 90) * 0.6 + (elevation - 0.5) * 0.15);
  return mix3(OCEAN_SHALLOW, OCEAN_DEEP, depth);
}

// --- texture builders ---------------------------------------------------------

interface PlanetTextures {
  colorMap: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  emissiveMap: THREE.Texture;
}

function canvasFromImageData(imageData: ImageData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = required(canvas.getContext("2d"), "2d context unavailable");
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function makeCanvasTexture(source: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(source);
  // A sphere's UV mapping pinches at the poles (many U values collapse to one
  // vertex); mipmapping averages across that pinch into a blurry dark spot.
  // Plain bilinear sampling avoids it, and the globe is never small enough
  // on screen for the aliasing mipmaps would otherwise prevent to matter.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function buildColorAndRoughness(
  mask: Uint8Array,
  elevation: Float32Array,
  coast: Uint8Array,
  width: number,
  height: number,
): { colorMap: THREE.Texture; roughnessMap: THREE.Texture } {
  const colorData = new ImageData(width, height);
  const roughData = new ImageData(width, height);
  const cp = colorData.data;
  const rp = roughData.data;

  for (let y = 0; y < height; y++) {
    const lat = 90 - (y / height) * 180;
    const absLat = Math.abs(lat);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const t = elevation[i];
      const isLand = mask[i] === 1;
      let color = isLand ? landColor(t, absLat) : oceanColor(absLat, t);

      // Coast pixels get a soft darkening rather than a bold cartoon outline.
      if (coast[i] === 1) color = [color[0] * 0.78, color[1] * 0.78, color[2] * 0.78];

      const roughness = isLand ? 232 : 40;
      const o = i * 4;
      cp[o] = color[0];
      cp[o + 1] = color[1];
      cp[o + 2] = color[2];
      cp[o + 3] = 255;
      rp[o] = roughness;
      rp[o + 1] = roughness;
      rp[o + 2] = roughness;
      rp[o + 3] = 255;
    }
  }

  const colorMap = makeCanvasTexture(canvasFromImageData(colorData));
  colorMap.colorSpace = THREE.SRGBColorSpace;
  colorMap.needsUpdate = true;

  const roughnessMap = makeCanvasTexture(canvasFromImageData(roughData));
  roughnessMap.needsUpdate = true;

  return { colorMap, roughnessMap };
}

function buildNormalMap(elevation: Float32Array, mask: Uint8Array, width: number, height: number): THREE.Texture {
  const imageData = new ImageData(width, height);
  const data = imageData.data;
  const strength = 2.4;

  for (let y = 0; y < height; y++) {
    const yUp = Math.max(0, y - 1);
    const yDown = Math.min(height - 1, y + 1);
    const latRad = ((0.5 - y / height) * Math.PI);
    const cosLat = Math.cos(latRad);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      if (mask[i] !== 1) {
        data[o] = 128;
        data[o + 1] = 128;
        data[o + 2] = 255;
        data[o + 3] = 255;
        continue;
      }
      const xLeft = (x - 1 + width) % width;
      const xRight = (x + 1) % width;
      // Longitude lines converge at the poles, so a fixed pixel step in x covers
      // a vanishing real-world distance there; without this the pole renders as
      // a spurious radial starburst of steep normals.
      const dx = (elevation[y * width + xRight] - elevation[y * width + xLeft]) * strength * cosLat;
      const dy = (elevation[yDown * width + x] - elevation[yUp * width + x]) * strength;
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      data[o] = Math.round((nx / len) * 0.5 * 255 + 127.5);
      data[o + 1] = Math.round((ny / len) * 0.5 * 255 + 127.5);
      data[o + 2] = Math.round((nz / len) * 0.5 * 255 + 127.5);
      data[o + 3] = 255;
    }
  }

  const texture = makeCanvasTexture(canvasFromImageData(imageData));
  texture.needsUpdate = true;
  return texture;
}

function buildCityLights(mask: Uint8Array, coast: Uint8Array, width: number, height: number): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = required(canvas.getContext("2d"), "2d context unavailable");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  const random = mulberry32(20260814);
  const candidates = 6000;
  for (let n = 0; n < candidates; n++) {
    const x = Math.floor(random() * width);
    const y = Math.floor(random() * height);
    const i = y * width + x;
    if (mask[i] !== 1) continue;

    const absLat = Math.abs(90 - (y / height) * 180);
    let coastal = false;
    for (let oy = -3; oy <= 3 && !coastal; oy++) {
      const yy = y + oy;
      if (yy < 0 || yy >= height) continue;
      for (let ox = -3; ox <= 3; ox++) {
        const xx = (x + ox + width) % width;
        if (coast[yy * width + xx] === 1) {
          coastal = true;
          break;
        }
      }
    }

    const density = bell(absLat, 38, 26) * (coastal ? 1 : 0.2);
    if (random() > density * 0.9) continue;

    const radius = (0.7 + random() * 1.3) * (width / TEXTURE_WIDTH);
    const brightness = 0.5 + random() * 0.5;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * 3);
    gradient.addColorStop(0, `rgba(255, ${Math.round(205 * brightness)}, ${Math.round(120 * brightness)}, ${brightness})`);
    gradient.addColorStop(1, "rgba(255, 180, 90, 0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = makeCanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function buildPlanetTextures(): PlanetTextures {
  const width = TEXTURE_WIDTH;
  const height = TEXTURE_HEIGHT;
  const mask = buildLandMask(width, height);
  const coast = buildCoastMask(mask, width, height);
  const elevation = buildElevationField(width, height);

  const { colorMap, roughnessMap } = buildColorAndRoughness(mask, elevation, coast, width, height);
  const normalMap = buildNormalMap(elevation, mask, width, height);
  const emissiveMap = buildCityLights(mask, coast, width, height);

  return { colorMap, normalMap, roughnessMap, emissiveMap };
}

function buildCloudTexture(): THREE.Texture {
  const width = CLOUD_WIDTH;
  const height = CLOUD_HEIGHT;
  const imageData = new ImageData(width, height);
  const data = imageData.data;

  for (let y = 0; y < height; y++) {
    const v = y / height;
    const latFade = 1 - Math.min(1, Math.abs(v * 2 - 1) * 1.1);
    for (let x = 0; x < width; x++) {
      const n = sphereNoise(x / width, v, 3.4, 8080, 5);
      const detail = sphereNoise(x / width, v, 11, 4040, 2);
      const coverage = clamp01((n - 0.58) * 3.6 + (detail - 0.5) * 0.35) * (0.45 + 0.55 * latFade);
      const o = (y * width + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(coverage * 255);
    }
  }

  const texture = makeCanvasTexture(canvasFromImageData(imageData));
  texture.needsUpdate = true;
  return texture;
}

function buildStarfield(): THREE.Points {
  const random = mulberry32(9001);
  const starCount = 900;
  const positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    const r = 40 + random() * 20;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.13,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
  });
  return new THREE.Points(geometry, material);
}

function buildAtmosphere(radius: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(radius * 1.025, 48, 32);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color(0x6fb2ff) },
      power: { value: 4.5 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      uniform vec3 glowColor;
      uniform float power;
      void main() {
        vec3 viewDir = normalize(vViewPosition);
        float rim = pow(1.0 - max(dot(normalize(vNormal), viewDir), 0.0), power);
        gl_FragColor = vec4(glowColor, rim * 0.55);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geometry, material);
}

// --- scene setup --------------------------------------------------------------

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 4.5);

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
} catch {
  stage.textContent = "This browser can't display the WebGL globe.";
  throw new Error("WebGL unavailable");
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
stage.appendChild(renderer.domElement);

const sphereRadius = 1.6;
const globeGroup = new THREE.Group();

const { colorMap, normalMap, roughnessMap, emissiveMap } = buildPlanetTextures();

const worldMesh = new THREE.Mesh(
  new THREE.SphereGeometry(sphereRadius, 96, 64),
  new THREE.MeshStandardMaterial({
    map: colorMap,
    normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughnessMap,
    roughness: 1,
    metalness: 0,
    emissiveMap,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.5,
  }),
);
globeGroup.add(worldMesh);

const cloudMesh = new THREE.Mesh(
  new THREE.SphereGeometry(sphereRadius * 1.018, 64, 48),
  new THREE.MeshBasicMaterial({ map: buildCloudTexture(), transparent: true, depthWrite: false }),
);
globeGroup.add(cloudMesh);

scene.add(globeGroup);
scene.add(buildAtmosphere(sphereRadius));
scene.add(buildStarfield());

const sunLight = new THREE.DirectionalLight(0xfff2df, 2.6);
sunLight.position.set(5, 2.2, 3.4);
scene.add(sunLight);

const fillLight = new THREE.HemisphereLight(0x9fb8ff, 0x14161f, 0.4);
scene.add(fillLight);

// --- interaction (drag, inertia, idle auto-rotate) -----------------------------

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

let isDragging = false;
let lastPointerX = 0;
let lastPointerY = 0;
let velocityYaw = 0;
let velocityPitch = 0;
let lastInteractionTime = performance.now();
let autoRotateBlend = 0;

function applyRotation(yaw: number, pitch: number): void {
  const qYaw = new THREE.Quaternion().setFromAxisAngle(worldY, -yaw);
  const qPitch = new THREE.Quaternion().setFromAxisAngle(worldX, -pitch);
  orientation.premultiply(qYaw);
  orientation.premultiply(qPitch);
  globeGroup.quaternion.copy(orientation);
}

function onPointerDown(event: PointerEvent): void {
  isDragging = true;
  velocityYaw = 0;
  velocityPitch = 0;
  autoRotateBlend = 0;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  stage.classList.add("dragging");
  renderer.domElement.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (!isDragging) return;
  const dx = event.clientX - lastPointerX;
  const dy = event.clientY - lastPointerY;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  const yaw = dx * dragSensitivity;
  const pitch = dy * dragSensitivity;
  applyRotation(yaw, pitch);
  velocityYaw = yaw;
  velocityPitch = pitch;
}

function endDrag(): void {
  isDragging = false;
  stage.classList.remove("dragging");
  lastInteractionTime = performance.now();
}

renderer.domElement.addEventListener("pointerdown", onPointerDown);
renderer.domElement.addEventListener("pointermove", onPointerMove);
renderer.domElement.addEventListener("pointerup", endDrag);
renderer.domElement.addEventListener("pointercancel", endDrag);

const resizeObserver = new ResizeObserver(() => {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (width === 0 || height === 0) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
});
resizeObserver.observe(stage);

let lastFrameTime = performance.now();

function animate(): void {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = now - lastFrameTime;
  lastFrameTime = now;

  if (!isDragging && !reducedMotion) {
    if (Math.abs(velocityYaw) > inertiaEpsilon || Math.abs(velocityPitch) > inertiaEpsilon) {
      applyRotation(velocityYaw, velocityPitch);
      velocityYaw *= inertiaDamping;
      velocityPitch *= inertiaDamping;
    } else {
      velocityYaw = 0;
      velocityPitch = 0;
      const idleFor = now - lastInteractionTime;
      if (idleFor > idleDelayMs) {
        autoRotateBlend = Math.min(1, autoRotateBlend + dt / idleRampMs);
        applyRotation(autoRotateSpeed * dt * autoRotateBlend, 0);
      }
    }
  }

  if (!reducedMotion) {
    cloudMesh.rotation.y += cloudDriftSpeed * dt;
  }

  renderer.render(scene, camera);
}

animate();
