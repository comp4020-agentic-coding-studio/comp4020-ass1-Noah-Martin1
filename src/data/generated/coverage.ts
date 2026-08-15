// The coverage masks, and how to ask them a question.
//
// Everything here lives in public/data/ and is produced by
// scripts/fetch-coverage.ts — nothing in this file is hand-maintained, and
// nothing the app draws reaches a third-party host at runtime.
//
// The globe needs to answer "can a request start here?" for whatever lat/lon is
// under the pointer, on every move, so it can colour the hover cursor. Testing
// a point against coastline polygons at that rate is not affordable. Instead
// each mask is a 1440 × 720 equirectangular bitmap — 0.25° per cell, one bit
// per cell — and `has()` is two divisions and a bit test. See decodeMask().
//
// Both masks are simplified educational models, not operator coverage maps.
// coverage.meta.json spells out how each was built and what it does not claim;
// read it before writing any UI copy that sounds like a promise about a real
// address.
//
// Vite is configured with `base: "./"`, so always route through `dataUrl()`.
import { dataUrl } from "./datasets";

/** The wire format of coverage.json: the shared grid, plus one base64 mask each. */
export type CoverageFile = {
  width: number;
  height: number;
  masks: { mobile: string; starlink: string };
};

/** One Starlink gateway as `[lon, lat]` in degrees, rounded to 2 dp. */
export type Gateway = [lon: number, lat: number];

/**
 * A decoded mask. `has()` is the whole point: a pure, allocation-free lookup
 * cheap enough to call once per pointer-move frame.
 */
export interface CoverageMask {
  width: number;
  height: number;
  has(lat: number, lon: number): boolean;
}

/** Both masks, decoded and ready to query. */
export type Coverage = {
  width: number;
  height: number;
  /** Where the simplified 5G/mobile model says a request can begin. */
  mobile: CoverageMask;
  /** Where Starlink is licensed and within the consumer service band. */
  starlink: CoverageMask;
};

/**
 * Unpacks a base64 bit mask into something you can query by lat/lon.
 *
 * The grid is equirectangular: row 0 is +90° latitude, column 0 is -180°
 * longitude, cells run row-major, and within a byte the first cell is the most
 * significant bit. Decoding walks the whole buffer once, up front; after that
 * `has()` allocates nothing and branches only on bounds, so it is safe to call
 * from a pointermove handler or a render loop.
 *
 * Latitude outside ±90° reads as uncovered. Longitude wraps, so a globe that
 * hands back 190° or -190° after a drag still gets a sensible answer.
 */
export function decodeMask(width: number, height: number, base64: string): CoverageMask {
  const binary = atob(base64);
  const expected = (width * height) / 8;
  if (binary.length !== expected) {
    throw new Error(`coverage mask is ${binary.length} bytes, expected ${expected}`);
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  // Hoisted so has() does no arithmetic it can avoid.
  const rowsPerDegree = height / 180;
  const colsPerDegree = width / 360;

  return {
    width,
    height,
    has(lat: number, lon: number): boolean {
      const row = Math.floor((90 - lat) * rowsPerDegree);
      if (row < 0 || row >= height) return false;
      // `% width` then a second add keeps the wrap correct for negative input.
      const col = (((Math.floor((lon + 180) * colsPerDegree) % width) + width) % width) | 0;
      const bit = row * width + col;
      return (bytes[bit >> 3] & (0x80 >> (bit & 7))) !== 0;
    },
  };
}

async function fetchJson<T>(file: string): Promise<T> {
  const response = await fetch(dataUrl(file));
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Loads coverage.json and decodes both masks. ~460 KB over the wire, once. */
export async function loadCoverage(): Promise<Coverage> {
  const file = await fetchJson<CoverageFile>("coverage.json");
  return {
    width: file.width,
    height: file.height,
    mobile: decodeMask(file.width, file.height, file.masks.mobile),
    starlink: decodeMask(file.width, file.height, file.masks.starlink),
  };
}

/**
 * Community-mapped Starlink gateway sites. Unofficial and incomplete — see the
 * `gateways` block in coverage.meta.json for where they come from and what they
 * leave out.
 */
export function loadStarlinkGateways(): Promise<Gateway[]> {
  return fetchJson<Gateway[]>("starlink-gateways.json");
}
