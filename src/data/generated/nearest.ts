// Shared "which of these points is closest" machinery.
//
// Every one of these searches is a linear scan. They run on selection or on a
// pointer move, over tens of thousands of entries, and cost a fraction of a
// millisecond — a spatial index here would be complexity bought with nothing.

import type { LatLon } from "../types";

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
 * not over-weight east-west gaps near the poles, and wrapped so a point beside
 * the antimeridian does not look half a planet away from its own neighbours.
 */
export function roughDistanceSq(from: LatLon, lat: number, lon: number): number {
  let dLon = lon - from.lon;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  const scaled = dLon * Math.cos(toRadians(from.lat));
  const dLat = lat - from.lat;
  return dLat * dLat + scaled * scaled;
}

/** Index of the entry nearest `to`, or -1 when there are none. */
export function nearestIndex(
  to: LatLon,
  length: number,
  latOf: (index: number) => number,
  lonOf: (index: number) => number,
): number {
  let bestIndex = -1;
  let best = Infinity;
  for (let i = 0; i < length; i++) {
    const d = roughDistanceSq(to, latOf(i), lonOf(i));
    if (d < best) {
      best = d;
      bestIndex = i;
    }
  }
  return bestIndex;
}
