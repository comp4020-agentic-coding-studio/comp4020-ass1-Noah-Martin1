// The cell tower layer, and the two lookups the 5G story needs: which tower is
// nearest a chosen point, and what that point is called.
//
// Both are plain linear scans. They run once per selection, not per frame, and
// over tens of thousands of entries that is a fraction of a millisecond — a
// spatial index here would be complexity bought with nothing.

import { dataUrl } from "./datasets";
import { distanceKm, nearestIndex } from "./nearest";
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
      const bestIndex = nearestIndex(
        to,
        towers.length,
        (i) => towers[i][1],
        (i) => towers[i][0],
      );
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
      const bestIndex = nearestIndex(
        at,
        places.length,
        (i) => places[i][1],
        (i) => places[i][0],
      );
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
