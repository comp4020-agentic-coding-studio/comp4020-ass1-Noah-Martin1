import * as THREE from "three";

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}

const stage = required(document.querySelector<HTMLDivElement>("#globe-stage"), "#globe-stage not found");

const palette = {
  bg: 0x070b14,
  accent: 0xff8a5c,
  grid: 0xe9edf6,
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function createDotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.6, "rgba(255,255,255,0.85)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function fibonacciSpherePoints(count: number, radius: number): Float32Array {
  const positions = new Float32Array(count * 3);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * i;
    positions[i * 3] = Math.cos(theta) * radiusAtY * radius;
    positions[i * 3 + 1] = y * radius;
    positions[i * 3 + 2] = Math.sin(theta) * radiusAtY * radius;
  }
  return positions;
}

function meridianGeometry(radius: number, rotationY: number, segments = 96): THREE.BufferGeometry {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const x = radius * Math.sin(t);
    const y = radius * Math.cos(t);
    points.push(new THREE.Vector3(x * Math.cos(rotationY), y, -x * Math.sin(rotationY)));
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}

function parallelGeometry(radius: number, polarAngle: number, segments = 96): THREE.BufferGeometry {
  const y = radius * Math.cos(polarAngle);
  const r = radius * Math.sin(polarAngle);
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(r * Math.cos(t), y, r * Math.sin(t)));
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}

function buildGraticule(radius: number): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial({ color: palette.grid, transparent: true, opacity: 0.45 });

  const meridianCount = 6;
  for (let i = 0; i < meridianCount; i++) {
    const rotationY = (i / meridianCount) * Math.PI;
    group.add(new THREE.LineLoop(meridianGeometry(radius, rotationY), material));
  }

  const latitudeDegrees = [30, 60, 90, 120, 150];
  for (const degrees of latitudeDegrees) {
    const polarAngle = (degrees * Math.PI) / 180;
    const opacity = degrees === 90 ? 0.6 : 0.45;
    const lineMaterial =
      opacity === 0.45 ? material : new THREE.LineBasicMaterial({ color: palette.grid, transparent: true, opacity });
    group.add(new THREE.LineLoop(parallelGeometry(radius, polarAngle), lineMaterial));
  }

  return group;
}

function buildDots(radius: number): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(fibonacciSpherePoints(1400, radius), 3));
  const material = new THREE.PointsMaterial({
    color: palette.accent,
    size: 0.045,
    map: createDotTexture(),
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
  });
  return new THREE.Points(geometry, material);
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
globeGroup.add(buildGraticule(sphereRadius));
globeGroup.add(buildDots(sphereRadius * 1.01));
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

  renderer.render(scene, camera);
}

animate();
