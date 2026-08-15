// The vendored submarine cable network, and how to load it.
//
// Produced by scripts/fetch-cables.ts from TeleGeography's Submarine Cable Map
// — the same dataset geotraceroute.com uses for its cable paths. Nothing here is
// hand-maintained, and nothing the app draws reaches a third-party host at
// runtime.
//
// URLs resolve through `dataUrl()` from ./datasets for the same reason
// everything else does: vite `base` is "./" so an absolute "/data/x" fetch
// breaks the moment the site is deployed to a GitHub Pages subpath.
//
// Two things the UI must respect when drawing these:
//
//  1. The routes are stylised. TeleGeography draws them to be legible, not to
//     survey the seabed, so they are indicative geography — never label a line
//     as the exact physical path of a packet.
//  2. The licence (CC BY-SA 4.0) requires crediting TeleGeography. `loadCableMeta`
//     exists so the attribution can come from the data rather than a hard-coded
//     string that drifts out of date.

import { dataUrl } from "./datasets";

/** What scripts/fetch-cables.ts records about the snapshot on disk. */
export type CableMeta = {
  source: string;
  sourceUrl: string;
  /** ISO 8601 UTC. The network is a snapshot from this moment, not a live feed. */
  fetchedAt: string;
  cableCount: number;
  landingCount: number;
  /** Publisher's licence terms — surface this wherever the cables are credited. */
  licence: string;
  note: string;
  geotracerouteFinding: string;
};

/**
 * One cable system. `id`/`name` are TeleGeography's, `color` is their map
 * styling — useful for telling adjacent systems apart, but the app's own
 * infrastructure palette should win where the two disagree.
 */
export type CableFeature = {
  type: "Feature";
  properties: { id: string; name: string; color?: string; feature_id?: string };
  geometry:
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "MultiLineString"; coordinates: [number, number][][] };
};

/** Cable routes: a GeoJSON FeatureCollection, coordinates `[lon, lat]` in degrees. */
export type CableCollection = { type: "FeatureCollection"; features: CableFeature[] };

/**
 * A cable landing point as a packed pair: `[lon, lat]` in degrees rounded to
 * 2 dp. Names are not carried — the globe draws points where cables meet the
 * shore, not labels.
 */
export type PackedLanding = [lon: number, lat: number];

async function fetchJson<T>(file: string): Promise<T> {
  const response = await fetch(dataUrl(file));
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** The full published network (~724 systems, ~740 KB). */
export function loadCables(): Promise<CableCollection> {
  return fetchJson<CableCollection>("cables.geojson");
}

/** Where those cables come ashore (~1900 points), de-duplicated at 2 dp. */
export function loadCableLandings(): Promise<PackedLanding[]> {
  return fetchJson<PackedLanding[]>("cable-landings.json");
}

/** Provenance and licence for the snapshot — needed for the CC BY-SA credit. */
export function loadCableMeta(): Promise<CableMeta> {
  return fetchJson<CableMeta>("cables.meta.json");
}

/** Every segment of a cable as a flat list, so callers need not branch on geometry type. */
export function cableSegments(feature: CableFeature): [number, number][][] {
  return feature.geometry.type === "LineString" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
}
