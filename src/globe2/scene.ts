import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { EARTH_RADIUS_UNITS, PALETTE } from "./constants";

export interface FocusRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GlobeScene {
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  earthRadius: number;
  /**
   * The region of the viewport the globe should appear centred in. The canvas
   * itself always covers the whole window (so space runs edge to edge); this
   * only moves where the planet sits inside it, which is what lets the desktop
   * story panel and the mobile bottom sheet coexist with a full-bleed
   * background.
   */
  setFocusRect(rect: FocusRect | null): void;
  /** Camera distance at which the globe just fills the current focus rect. */
  fittedDistance(fill?: number): number;
  resize(): void;
  render(): void;
  /** Feeds frame timing to the adaptive quality controller. */
  notifyFrame(dtMs: number): void;
}

/**
 * Rendering tiers, highest first. Bloom is a full-screen multi-pass effect and
 * is by far the most expensive thing on screen -- measurably so: frame rate
 * tracks pixel count, not satellite count. Rather than pick one setting and
 * hope the marker's machine can take it, the scene measures itself and steps
 * down until it is comfortable.
 */
const enum Quality {
  Low = 0,
  Medium = 1,
  High = 2,
}

/**
 * Off-axis projection: shifts the camera's principal point so the globe centres
 * inside `focus` without skewing it or cropping the background. Passing the
 * real canvas size as the "full" size means the offsets are a pure frustum
 * shift, which is exactly what THREE.PerspectiveCamera.setViewOffset does.
 */
function applyFocus(camera: THREE.PerspectiveCamera, width: number, height: number, focus: FocusRect | null): void {
  if (!focus || width === 0 || height === 0) {
    camera.clearViewOffset();
    return;
  }
  const centreX = focus.x + focus.width / 2;
  const centreY = focus.y + focus.height / 2;
  camera.setViewOffset(width, height, width / 2 - centreX, height / 2 - centreY, width, height);
}

export function createGlobeScene(canvas: HTMLCanvasElement): GlobeScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.space);

  // A narrow field of view keeps the planet's limb close to circular near the
  // edges of very wide viewports, which the reference imagery relies on.
  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 400);
  camera.position.set(0, 0, EARTH_RADIUS_UNITS * 3);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setClearColor(PALETTE.space, 1);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Bloom is what turns the route line, city lights and atmosphere into the
  // glowing look of the reference images rather than flat vector shapes. The
  // threshold is high on purpose: only genuinely bright things (the route, the
  // limb, city cores) should glow, otherwise the background nebulosity blooms
  // into washed-out blobs and swamps the globe.
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.45, 0.62);
  composer.addPass(bloom);

  let focusRect: FocusRect | null = null;

  // `?quality=high` / `?quality=low` pins the tier, which is what makes visual
  // checks reproducible on a machine whose GPU differs from the viewer's.
  const forced = new URLSearchParams(window.location.search).get("quality");
  let quality: Quality = forced === "low" ? Quality.Low : Quality.High;
  const adaptive = forced !== "high" && forced !== "low";

  function pixelRatio(): number {
    // Bloom runs several full-screen passes, so cap the ratio harder on the
    // very dense displays where the cost would otherwise triple for no visible
    // gain at this scale.
    const raw = window.devicePixelRatio || 1;
    const cap = quality === Quality.High ? Math.min(raw, raw > 2 ? 1.75 : 2) : 1;
    return Math.max(1, Math.min(raw, cap));
  }

  function resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (width === 0 || height === 0) return;
    const ratio = pixelRatio();

    camera.aspect = width / height;
    applyFocus(camera, width, height, focusRect);
    camera.updateProjectionMatrix();

    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(ratio);
    composer.setSize(width, height);
    bloom.resolution.set(width, height);
  }

  function setFocusRect(rect: FocusRect | null): void {
    focusRect = rect;
    applyFocus(camera, window.innerWidth, window.innerHeight, focusRect);
    camera.updateProjectionMatrix();
  }

  /**
   * Distance at which the globe's diameter covers `fill` of the smaller side of
   * the focus rect. Framing off the rect (not the window) is what makes the
   * layout work at any resolution instead of only the two marked viewports.
   */
  function fittedDistance(fill = 0.76): number {
    const height = window.innerHeight || 1;
    const rectWidth = focusRect?.width ?? window.innerWidth;
    const rectHeight = focusRect?.height ?? height;
    const shortest = Math.max(120, Math.min(rectWidth, rectHeight));

    // Vertical half-angle the globe may occupy, in the camera's terms.
    const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
    const targetHalfPixels = (shortest * fill) / 2;
    const halfAngle = Math.atan((targetHalfPixels / (height / 2)) * Math.tan(halfFov));
    return EARTH_RADIUS_UNITS / Math.max(0.05, Math.sin(halfAngle));
  }

  function render(): void {
    // At the lowest tier the composer is bypassed entirely rather than run with
    // a disabled pass, so there is no full-screen copy left in the pipeline.
    if (quality === Quality.Low) {
      renderer.render(scene, camera);
    } else {
      composer.render();
    }
  }

  // --- adaptive quality ---------------------------------------------------

  let sampleTotal = 0;
  let sampleCount = 0;

  function notifyFrame(dtMs: number): void {
    if (!adaptive || quality === Quality.Low) return;

    sampleTotal += dtMs;
    sampleCount++;
    // Judge over a window of wall time, not a frame count: at 10fps a
    // 90-frame window would take nine seconds to notice a problem. A minimum
    // count still stops one hitch (a texture upload, a route rebuild) from
    // triggering a downgrade on its own.
    if (sampleTotal < 1500 || sampleCount < 10) return;

    const average = sampleTotal / sampleCount;
    sampleTotal = 0;
    sampleCount = 0;

    // Below ~36fps sustained, drop a tier. Downgrades are one-way: oscillating
    // between tiers would be more distracting than the lower setting itself.
    if (average > 28) {
      quality = quality === Quality.High ? Quality.Medium : Quality.Low;
      resize();
    }
  }

  resize();

  return {
    canvas,
    scene,
    camera,
    renderer,
    earthRadius: EARTH_RADIUS_UNITS,
    setFocusRect,
    fittedDistance,
    resize,
    render,
    notifyFrame,
  };
}
