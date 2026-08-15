import * as THREE from "three";
import type { LandCollection } from "../data/generated/datasets";
import { PALETTE } from "./constants";

/**
 * Bakes Natural Earth land polygons into an equirectangular texture for the
 * globe.
 *
 * Drawing coastlines into a texture once beats carrying them as thousands of
 * line segments on the GPU every frame, and it is the only practical way to get
 * *filled* landmasses with a bright edge -- the look of the reference image --
 * without triangulating every polygon.
 */

const WIDTH = 4096;
const HEIGHT = 2048;

function hex(colour: number): string {
  return `#${colour.toString(16).padStart(6, "0")}`;
}

/**
 * Polygons that straddle the antimeridian (Russia, Fiji, Antarctica's seam)
 * arrive with a longitude jump from +179 to -179. Drawn naively that becomes a
 * band smeared right across the map, so the ring is broken into sub-paths at
 * any jump wider than half the world.
 */
function strokeAndFillRing(context: CanvasRenderingContext2D, ring: [number, number][]): void {
  let previousX: number | null = null;
  context.beginPath();
  for (const [lon, lat] of ring) {
    const x = ((lon + 180) / 360) * WIDTH;
    const y = ((90 - lat) / 180) * HEIGHT;
    if (previousX !== null && Math.abs(x - previousX) > WIDTH / 2) {
      context.closePath();
      context.fill();
      context.stroke();
      context.beginPath();
      context.moveTo(x, y);
    } else if (previousX === null) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
    previousX = x;
  }
  context.closePath();
  context.fill();
  context.stroke();
}

function ringsOf(collection: LandCollection): [number, number][][] {
  const rings: [number, number][][] = [];
  for (const feature of collection.features) {
    const { geometry } = feature;
    if (geometry.type === "Polygon") {
      rings.push(...geometry.coordinates);
    } else {
      for (const polygon of geometry.coordinates) rings.push(...polygon);
    }
  }
  return rings;
}

export function bakeLandTexture(collection: LandCollection, anisotropy = 1): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas context unavailable for the land texture");

  // Ocean, with a faint latitude shading so the sphere doesn't read as one
  // flat colour under the atmosphere.
  const ocean = context.createLinearGradient(0, 0, 0, HEIGHT);
  ocean.addColorStop(0, "#101832");
  ocean.addColorStop(0.5, hex(PALETTE.ocean));
  ocean.addColorStop(1, "#101832");
  context.fillStyle = ocean;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  context.fillStyle = hex(PALETTE.land);
  context.strokeStyle = hex(PALETTE.landEdge);
  context.lineWidth = 2.2;
  context.lineJoin = "round";

  for (const ring of ringsOf(collection)) strokeAndFillRing(context, ring);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}
