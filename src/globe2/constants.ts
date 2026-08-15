/**
 * Shared scale for the rebuilt globe.
 *
 * Everything spatial is expressed in "units", where the Earth's radius is
 * EARTH_RADIUS_UNITS. Real-world distances convert through kmToUnits(), which
 * keeps orbital altitudes honest relative to the planet instead of being
 * eyeballed: a 550 km Starlink shell really does sit at 550/6371 of a radius
 * above the surface.
 */
export const EARTH_RADIUS_KM = 6371;
export const EARTH_RADIUS_UNITS = 1.6;

export function kmToUnits(km: number): number {
  return (km / EARTH_RADIUS_KM) * EARTH_RADIUS_UNITS;
}

/** Radius of a shell at the given altitude above sea level, in units. */
export function altitudeToRadius(altitudeKm: number): number {
  return EARTH_RADIUS_UNITS + kmToUnits(altitudeKm);
}

/**
 * The visualisation runs orbital motion at 10x real time so that orbital
 * movement is visible on a human timescale (CLAUDE.md). This is a deliberate,
 * disclosed exaggeration -- the positions themselves come from published
 * orbital elements.
 */
export const ORBIT_TIME_SCALE = 10;

/** Palette lifted from the reference imagery, kept in one place so the
 *  infrastructure layers stay visually consistent. */
export const PALETTE = {
  space: 0x03050c,
  ocean: 0x121b33,
  land: 0x3a4a6b,
  landEdge: 0x8aa4d4,
  atmosphere: 0x4c9bff,
  city: 0xdce8ff,
  route: 0x54ff8f,
  /** The reply travelling back. Deliberately a different hue from the request
   *  so the two directions are never confused for one another. */
  routeReturn: 0x4fa8ff,
  routeNode: 0xffb347,
  packet: 0xffffff,
  cableTerrestrial: 0x3b5580,
  cableSubmarine: 0x2f6d8f,
  satellite: 0x9fc4ff,
  satelliteActive: 0x8affc1,
  groundStation: 0xc08bff,
} as const;
