import * as THREE from "three";

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}

const stage = required(document.querySelector<HTMLDivElement>("#globe-stage"), "#globe-stage not found");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const TEXTURE_WIDTH = 512;
const TEXTURE_HEIGHT = 256;

const OCEAN_SHALLOW = [47, 161, 224] as const;
const OCEAN_DEEP = [21, 108, 176] as const;
const LAND_GREEN_A = [96, 191, 110] as const;
const LAND_GREEN_B = [76, 168, 96] as const;
const OUTLINE_COLOR = [20, 56, 42] as const;
const OUTLINE_THICKNESS = 2;

interface ContinentBlob {
  dx: number;
  dy: number;
  r: number;
}

interface Continent {
  blobs: ContinentBlob[];
}

// Fractional (0..1) coordinates over the equirectangular canvas. Loosely
// evocative of real continents, not a literal atlas -- this is a toy globe.
const CONTINENTS: Continent[] = [
  {
    blobs: [
      { dx: 0.14, dy: 0.22, r: 0.085 },
      { dx: 0.2, dy: 0.3, r: 0.075 },
      { dx: 0.13, dy: 0.36, r: 0.065 },
      { dx: 0.22, dy: 0.42, r: 0.055 },
      { dx: 0.09, dy: 0.3, r: 0.06 },
    ],
  },
  {
    blobs: [
      { dx: 0.26, dy: 0.58, r: 0.055 },
      { dx: 0.29, dy: 0.68, r: 0.05 },
      { dx: 0.28, dy: 0.78, r: 0.042 },
      { dx: 0.31, dy: 0.86, r: 0.032 },
    ],
  },
  {
    blobs: [
      { dx: 0.47, dy: 0.2, r: 0.045 },
      { dx: 0.52, dy: 0.24, r: 0.04 },
    ],
  },
  {
    blobs: [
      { dx: 0.5, dy: 0.5, r: 0.06 },
      { dx: 0.53, dy: 0.6, r: 0.058 },
      { dx: 0.51, dy: 0.7, r: 0.05 },
      { dx: 0.55, dy: 0.78, r: 0.04 },
    ],
  },
  {
    blobs: [
      { dx: 0.62, dy: 0.22, r: 0.07 },
      { dx: 0.7, dy: 0.18, r: 0.075 },
      { dx: 0.78, dy: 0.24, r: 0.07 },
      { dx: 0.66, dy: 0.3, r: 0.065 },
      { dx: 0.74, dy: 0.34, r: 0.06 },
      { dx: 0.84, dy: 0.32, r: 0.05 },
    ],
  },
  {
    blobs: [
      { dx: 0.82, dy: 0.66, r: 0.05 },
      { dx: 0.87, dy: 0.7, r: 0.038 },
    ],
  },
];

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

function buildLandMask(width: number, height: number): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = required(canvas.getContext("2d"), "2d context unavailable");
  ctx.fillStyle = "#fff";
  for (const continent of CONTINENTS) {
    for (const blob of continent.blobs) {
      ctx.beginPath();
      ctx.arc(blob.dx * width, blob.dy * height, blob.r * width, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const mask = new Uint8Array(width * height);
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4] > 128 ? 1 : 0;
  }
  return mask;
}

function continentIndexAt(x: number, y: number, width: number, height: number): number {
  for (let c = 0; c < CONTINENTS.length; c++) {
    for (const blob of CONTINENTS[c].blobs) {
      const dx = x - blob.dx * width;
      const dy = y - blob.dy * height;
      const r = blob.r * width;
      if (dx * dx + dy * dy <= r * r) return c;
    }
  }
  return -1;
}

function buildWorldTexture(): THREE.Texture {
  const width = TEXTURE_WIDTH;
  const height = TEXTURE_HEIGHT;
  const mask = buildLandMask(width, height);

  const imageData = new ImageData(width, height);
  const pixels = imageData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] === 1) {
        const continentIndex = continentIndexAt(x, y, width, height);
        const [r, g, b] = continentIndex % 2 === 0 ? LAND_GREEN_A : LAND_GREEN_B;
        pixels[i * 4] = r;
        pixels[i * 4 + 1] = g;
        pixels[i * 4 + 2] = b;
        pixels[i * 4 + 3] = 255;
      } else {
        const t = Math.abs(y / height - 0.5) * 2;
        pixels[i * 4] = OCEAN_SHALLOW[0] + (OCEAN_DEEP[0] - OCEAN_SHALLOW[0]) * t;
        pixels[i * 4 + 1] = OCEAN_SHALLOW[1] + (OCEAN_DEEP[1] - OCEAN_SHALLOW[1]) * t;
        pixels[i * 4 + 2] = OCEAN_SHALLOW[2] + (OCEAN_DEEP[2] - OCEAN_SHALLOW[2]) * t;
        pixels[i * 4 + 3] = 255;
      }
    }
  }

  // Coastline pass: any land pixel touching ocean (on any of the 4 sides) is
  // an edge; dilate a few times so the outline reads as a thick cartoon
  // stroke rather than a hairline.
  let coast = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] !== 1) continue;
      const left = x > 0 ? mask[i - 1] : 0;
      const right = x + 1 < width ? mask[i + 1] : 0;
      const up = y > 0 ? mask[i - width] : 0;
      const down = y + 1 < height ? mask[i + width] : 0;
      if (left === 0 || right === 0 || up === 0 || down === 0) coast[i] = 1;
    }
  }
  for (let pass = 1; pass < OUTLINE_THICKNESS; pass++) {
    const next = new Uint8Array(coast);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (mask[i] !== 1 || coast[i] === 1) continue;
        const left = x > 0 ? coast[i - 1] : 0;
        const right = x + 1 < width ? coast[i + 1] : 0;
        const up = y > 0 ? coast[i - width] : 0;
        const down = y + 1 < height ? coast[i + width] : 0;
        if (left === 1 || right === 1 || up === 1 || down === 1) next[i] = 1;
      }
    }
    coast = next;
  }
  for (let i = 0; i < coast.length; i++) {
    if (coast[i] !== 1) continue;
    pixels[i * 4] = OUTLINE_COLOR[0];
    pixels[i * 4 + 1] = OUTLINE_COLOR[1];
    pixels[i * 4 + 2] = OUTLINE_COLOR[2];
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = required(canvas.getContext("2d"), "2d context unavailable");
  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function buildCloudTexture(): THREE.Texture {
  const width = TEXTURE_WIDTH;
  const height = TEXTURE_HEIGHT;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = required(canvas.getContext("2d"), "2d context unavailable");
  ctx.clearRect(0, 0, width, height);

  const random = mulberry32(4242);
  const clumpCount = 16;
  for (let c = 0; c < clumpCount; c++) {
    const cx = random() * width;
    const cy = height * 0.14 + random() * height * 0.72;
    const puffCount = 4 + Math.floor(random() * 4);
    const puffs: { px: number; py: number; radius: number }[] = [];
    for (let p = 0; p < puffCount; p++) {
      puffs.push({
        px: cx + (random() - 0.5) * width * 0.09,
        py: cy + (random() - 0.5) * height * 0.06,
        radius: (width * 0.018 + random() * width * 0.026) * (0.7 + random() * 0.6),
      });
    }

    // Outline pass: a slightly larger, pale rim behind each puff.
    ctx.fillStyle = "rgba(214, 234, 250, 0.85)";
    for (const puff of puffs) {
      ctx.beginPath();
      ctx.arc(puff.px, puff.py, puff.radius * 1.18, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fill pass: solid white on top, giving the rim a visible edge.
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    for (const puff of puffs) {
      ctx.beginPath();
      ctx.arc(puff.px, puff.py, puff.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 4.4);

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

const worldMesh = new THREE.Mesh(
  new THREE.SphereGeometry(sphereRadius, 64, 48),
  new THREE.MeshBasicMaterial({ map: buildWorldTexture() }),
);
globeGroup.add(worldMesh);

const cloudMesh = new THREE.Mesh(
  new THREE.SphereGeometry(sphereRadius * 1.015, 64, 48),
  new THREE.MeshBasicMaterial({ map: buildCloudTexture(), transparent: true, depthWrite: false }),
);
globeGroup.add(cloudMesh);

scene.add(globeGroup);

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
