import * as THREE from "three";

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}

const stage = required(document.querySelector<HTMLDivElement>("#globe-stage"), "#globe-stage not found");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const TEXTURE_WIDTH = 512;
const TEXTURE_HEIGHT = 256;

const OCEAN_SHALLOW = [56, 150, 199] as const;
const OCEAN_DEEP = [24, 90, 138] as const;
const BORDER_COLOR = [255, 255, 255] as const;
const COASTLINE_COLOR = [24, 60, 90] as const;

const COUNTRY_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [247, 199, 90], // gold
  [239, 131, 84], // coral
  [244, 166, 198], // pink
  [149, 213, 178], // mint
  [201, 173, 167], // clay
  [255, 180, 162], // peach
  [132, 169, 140], // sage
  [224, 122, 95], // terracotta
  [242, 204, 143], // sand
  [168, 178, 222], // periwinkle
  [163, 196, 226], // sky
  [214, 164, 216], // lilac
];

interface ContinentBlob {
  dx: number;
  dy: number;
  r: number;
}

interface Continent {
  seedCount: number;
  blobs: ContinentBlob[];
}

// Fractional (0..1) coordinates over the equirectangular canvas. Loosely
// evocative of real continents, not a literal atlas -- this is a toy globe.
const CONTINENTS: Continent[] = [
  {
    seedCount: 9,
    blobs: [
      { dx: 0.14, dy: 0.22, r: 0.085 },
      { dx: 0.2, dy: 0.3, r: 0.075 },
      { dx: 0.13, dy: 0.36, r: 0.065 },
      { dx: 0.22, dy: 0.42, r: 0.055 },
      { dx: 0.09, dy: 0.3, r: 0.06 },
    ],
  },
  {
    seedCount: 6,
    blobs: [
      { dx: 0.26, dy: 0.58, r: 0.055 },
      { dx: 0.29, dy: 0.68, r: 0.05 },
      { dx: 0.28, dy: 0.78, r: 0.042 },
      { dx: 0.31, dy: 0.86, r: 0.032 },
    ],
  },
  {
    seedCount: 5,
    blobs: [
      { dx: 0.47, dy: 0.2, r: 0.045 },
      { dx: 0.52, dy: 0.24, r: 0.04 },
    ],
  },
  {
    seedCount: 7,
    blobs: [
      { dx: 0.5, dy: 0.5, r: 0.06 },
      { dx: 0.53, dy: 0.6, r: 0.058 },
      { dx: 0.51, dy: 0.7, r: 0.05 },
      { dx: 0.55, dy: 0.78, r: 0.04 },
    ],
  },
  {
    seedCount: 10,
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
    seedCount: 4,
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

interface Seed {
  x: number;
  y: number;
  color: readonly [number, number, number];
}

function scatterSeeds(mask: Uint8Array, width: number, height: number): Seed[] {
  const random = mulberry32(1337);
  const seeds: Seed[] = [];
  let colorIndex = 0;
  for (const continent of CONTINENTS) {
    const bounds = continent.blobs.reduce(
      (acc, blob) => ({
        minX: Math.min(acc.minX, (blob.dx - blob.r) * width),
        maxX: Math.max(acc.maxX, (blob.dx + blob.r) * width),
        minY: Math.min(acc.minY, (blob.dy - blob.r) * height),
        maxY: Math.max(acc.maxY, (blob.dy + blob.r) * height),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
    );

    let placed = 0;
    let attempts = 0;
    while (placed < continent.seedCount && attempts < continent.seedCount * 40) {
      attempts++;
      const x = bounds.minX + random() * (bounds.maxX - bounds.minX);
      const y = bounds.minY + random() * (bounds.maxY - bounds.minY);
      const px = Math.round(x);
      const py = Math.round(y);
      if (px < 0 || px >= width || py < 0 || py >= height) continue;
      if (mask[py * width + px] !== 1) continue;
      seeds.push({ x, y, color: COUNTRY_PALETTE[colorIndex % COUNTRY_PALETTE.length] });
      colorIndex++;
      placed++;
    }
  }
  return seeds;
}

function nearestSeedIndex(x: number, y: number, seeds: Seed[]): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < seeds.length; i++) {
    const dx = seeds[i].x - x;
    const dy = seeds[i].y - y;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function buildWorldTexture(): THREE.Texture {
  const width = TEXTURE_WIDTH;
  const height = TEXTURE_HEIGHT;
  const mask = buildLandMask(width, height);
  const seeds = scatterSeeds(mask, width, height);

  const seedOf = new Int16Array(width * height).fill(-1);
  const imageData = new ImageData(width, height);
  const pixels = imageData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] === 1) {
        const seedIndex = nearestSeedIndex(x, y, seeds);
        seedOf[i] = seedIndex;
        const [r, g, b] = seeds[seedIndex].color;
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

  // Border pass: country borders where neighbouring land pixels belong to a
  // different seed, coastlines where land meets ocean.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] !== 1) continue;
      const right = x + 1 < width ? i + 1 : -1;
      const down = y + 1 < height ? i + width : -1;
      let isBorder = false;
      let isCoast = false;
      if (right >= 0) {
        if (mask[right] === 1 && seedOf[right] !== seedOf[i]) isBorder = true;
        if (mask[right] === 0) isCoast = true;
      }
      if (down >= 0) {
        if (mask[down] === 1 && seedOf[down] !== seedOf[i]) isBorder = true;
        if (mask[down] === 0) isCoast = true;
      }
      if (isBorder) {
        pixels[i * 4] = BORDER_COLOR[0];
        pixels[i * 4 + 1] = BORDER_COLOR[1];
        pixels[i * 4 + 2] = BORDER_COLOR[2];
      } else if (isCoast) {
        pixels[i * 4] = COASTLINE_COLOR[0];
        pixels[i * 4 + 1] = COASTLINE_COLOR[1];
        pixels[i * 4 + 2] = COASTLINE_COLOR[2];
      }
    }
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
  const clumpCount = 26;
  for (let c = 0; c < clumpCount; c++) {
    const cx = random() * width;
    const cy = height * 0.12 + random() * height * 0.76;
    const puffCount = 3 + Math.floor(random() * 4);
    for (let p = 0; p < puffCount; p++) {
      const px = cx + (random() - 0.5) * width * 0.06;
      const py = cy + (random() - 0.5) * height * 0.05;
      const radius = (width * 0.012 + random() * width * 0.022) * (0.7 + random() * 0.6);
      const gradient = ctx.createRadialGradient(px, py, 0, px, py, radius);
      const alpha = 0.3 + random() * 0.35;
      gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
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
