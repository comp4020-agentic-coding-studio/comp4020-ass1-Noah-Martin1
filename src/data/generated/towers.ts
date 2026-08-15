// The cell tower layer, and the two lookups the 5G story needs: which tower is
// nearest a chosen point, and what that point is called.
//
// Both are plain linear scans. They run once per selection, not per frame, and
// over tens of thousands of entries that is a fraction of a millisecond — a
// spatial index here would be complexity bought with nothing.

import { dataUrl } from "./datasets";
import type { LatLon } from "../types";

/** `[lon, lat, towersInBlock]` — see scripts/fetch-towers.ts for what a point means. */
export type PackedTower = [lon: number, lat: number, towers: number];

/** `[lon, lat, name, region, country]` from Natural Earth's populated places. */
export type PackedPlace = [lon: number, lat: number, name: string, region: string, country: string];

export interface TowerMeta {
  source: string;
  sourceUrl: string;
  landingPage: string;
  upstream: string;
  licence: string;
  snapshot: string;
  towerPoints: number;
  populatedBlocks: number;
  recordedTowersRepresented: number;
  method: string;
  caveats: string[];
}

export interface Tower extends LatLon {
  /** Recorded towers in this marker's whole block, not at this exact point. */
  towers: number;
}

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: LatLon, b: LatLon): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRadians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Cheap ranking proxy for "which of these is nearest": monotonic in true
 * distance, but without the trig. Longitude is scaled by cos(lat) so it does
 * not over-weight east-west gaps near the poles.
 */
function roughDistanceSq(from: LatLon, lat: number, lon: number): number {
  let dLon = lon - from.lon;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  const scaled = dLon * Math.cos(toRadians(from.lat));
  const dLat = lat - from.lat;
  return dLat * dLat + scaled * scaled;
}

export interface TowerIndex {
  towers: readonly PackedTower[];
  meta: TowerMeta;
  /** Nearest tower marker to a point, or null if the dataset is empty. */
  nearest(to: LatLon): { tower: Tower; distanceKm: number } | null;
}

export function createTowerIndex(towers: readonly PackedTower[], meta: TowerMeta): TowerIndex {
  return {
    towers,
    meta,
    nearest(to: LatLon) {
      let bestIndex = -1;
      let best = Infinity;
      for (let i = 0; i < towers.length; i++) {
        const d = roughDistanceSq(to, towers[i][1], towers[i][0]);
        if (d < best) {
          best = d;
          bestIndex = i;
        }
      }
      if (bestIndex < 0) return null;
      const [lon, lat, count] = towers[bestIndex];
      const tower: Tower = { lat, lon, towers: count };
      return { tower, distanceKm: distanceKm(to, tower) };
    },
  };
}

export interface PlaceLabel {
  /** What to show beside the cursor. */
  text: string;
  /** The named place it was derived from, and how far away it actually is. */
  place: PackedPlace;
  distanceKm: number;
}

/**
 * Natural Earth carries ~7,300 places, so a remote point's nearest named place
 * can be a long way off. Rather than pretend, the label leads with the region
 * (which *is* right at that distance) and states the gap to the nearest town.
 */
const NEARBY_KM = 25;

export interface PlaceIndex {
  places: readonly PackedPlace[];
  label(at: LatLon): PlaceLabel | null;
}

export function createPlaceIndex(places: readonly PackedPlace[]): PlaceIndex {
  return {
    places,
    label(at: LatLon) {
      let bestIndex = -1;
      let best = Infinity;
      for (let i = 0; i < places.length; i++) {
        const d = roughDistanceSq(at, places[i][1], places[i][0]);
        if (d < best) {
          best = d;
          bestIndex = i;
        }
      }
      if (bestIndex < 0) return null;

      const place = places[bestIndex];
      const [lon, lat, name, region, country] = place;
      const km = distanceKm(at, { lat, lon });
      const area = [region, country].filter(Boolean).join(", ");

      if (km <= NEARBY_KM) {
        return { text: [name, area].filter(Boolean).join(", "), place, distanceKm: km };
      }
      const gap = `${Math.round(km)} km from ${name}`;
      return { text: area ? `${area} · ${gap}` : gap, place, distanceKm: km };
    },
  };
}

async function fetchJson<T>(file: string): Promise<T> {
  const response = await fetch(dataUrl(file));
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function loadTowers(): Promise<TowerIndex> {
  const [towers, meta] = await Promise.all([
    fetchJson<PackedTower[]>("towers.json"),
    fetchJson<TowerMeta>("towers.meta.json"),
  ]);
  return createTowerIndex(towers, meta);
}

export async function loadPlaces(): Promise<PlaceIndex> {
  return createPlaceIndex(await fetchJson<PackedPlace[]>("places.json"));
}
