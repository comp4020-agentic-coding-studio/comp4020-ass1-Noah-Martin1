// The data centre layer, and the lookup the destination picker snaps with.

import type { LatLon } from "../types";
import { dataUrl } from "./datasets";
import { distanceKm, nearestIndex } from "./nearest";

/** `[lon, lat, tier, name]`; tier 2 = major, 1 = significant, 0 = regional. */
export type PackedDataCentre = [lon: number, lat: number, tier: number, name: string];

export interface DataCentreMeta {
  source: string;
  licence: string;
  fetchedAt: string;
  rejectedSource: string;
  count: number;
  tiers: { major: number; significant: number; regional: number };
  method: string;
  caveats: string[];
}

export interface DataCentre extends LatLon {
  index: number;
  tier: number;
  name: string;
}

export interface DataCentreIndex {
  centres: readonly PackedDataCentre[];
  meta: DataCentreMeta;
  /**
   * Nearest data centre to a point, but only within `maxKm`. The cap is what
   * keeps the destination cursor from snapping across an ocean, and what keeps
   * a drag over empty sea from feeling like it is being grabbed at.
   */
  nearest(to: LatLon, maxKm: number): { centre: DataCentre; distanceKm: number } | null;
  at(index: number): DataCentre;
}

export function createDataCentreIndex(
  centres: readonly PackedDataCentre[],
  meta: DataCentreMeta,
): DataCentreIndex {
  function at(index: number): DataCentre {
    const [lon, lat, tier, name] = centres[index];
    return { index, lat, lon, tier, name };
  }

  return {
    centres,
    meta,
    at,
    nearest(to: LatLon, maxKm: number) {
      const index = nearestIndex(
        to,
        centres.length,
        (i) => centres[i][1],
        (i) => centres[i][0],
      );
      if (index < 0) return null;
      const centre = at(index);
      const km = distanceKm(to, centre);
      return km <= maxKm ? { centre, distanceKm: km } : null;
    },
  };
}

async function fetchJson<T>(file: string): Promise<T> {
  const response = await fetch(dataUrl(file));
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function loadDataCentres(): Promise<DataCentreIndex> {
  const [centres, meta] = await Promise.all([
    fetchJson<PackedDataCentre[]>("datacentres.json"),
    fetchJson<DataCentreMeta>("datacentres.meta.json"),
  ]);
  return createDataCentreIndex(centres, meta);
}
