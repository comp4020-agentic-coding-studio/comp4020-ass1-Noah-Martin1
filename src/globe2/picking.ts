import * as THREE from "three";
import { CITIES } from "../data/geo";
import type { City, CityKind, LatLon } from "../data/types";
import { haversineKm, vector3ToLatLon } from "../globe/geometry";
import { EARTH_RADIUS_UNITS } from "./constants";
import type { GlobeScene } from "./scene";

/**
 * Turning a screen position into a point on the planet.
 *
 * This is an analytic ray/sphere intersection rather than a mesh raycast: it
 * runs on every pointer move to drive the hover cursor, and testing thousands
 * of sphere triangles for something with a closed-form answer would be wasteful
 * (and would snag on the tessellation at grazing angles).
 */

const ORIGIN_CITIES = CITIES.filter((city) => city.kinds.includes("origin"));

const ray = new THREE.Ray();
const ndc = new THREE.Vector3();
const scratch = new THREE.Vector3();

/** Where a screen point meets the globe, or null if it misses. */
export function surfacePointAt(globe: GlobeScene, clientX: number, clientY: number): THREE.Vector3 | null {
  // The canvas is full-bleed, so client coordinates map straight onto the
  // window. The camera's view offset is already in its projection matrix, so
  // the off-centre framing is accounted for automatically.
  ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1, 0.5);
  ndc.unproject(globe.camera);

  ray.origin.copy(globe.camera.position);
  ray.direction.copy(ndc.sub(globe.camera.position)).normalize();

  // Solve |o + t·d|² = r² for the near root.
  const origin = ray.origin;
  const direction = ray.direction;
  const b = origin.dot(direction);
  const c = origin.dot(origin) - EARTH_RADIUS_UNITS * EARTH_RADIUS_UNITS;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;

  const t = -b - Math.sqrt(discriminant);
  if (t < 0) return null;

  return scratch.copy(origin).addScaledVector(direction, t).clone();
}

/** Latitude/longitude under a screen point, or null if it isn't over the globe. */
export function locationAt(globe: GlobeScene, clientX: number, clientY: number): LatLon | null {
  const point = surfacePointAt(globe, clientX, clientY);
  return point ? vector3ToLatLon(point) : null;
}

export interface NearestCity {
  city: City;
  distanceKm: number;
}

/**
 * The modelled place a request starting here would enter the network at.
 *
 * There is no cut-off distance: whether a location has service is decided by
 * the coverage model, not by how close it happens to sit to one of the few
 * dozen cities the route graph knows about. Callers get the distance so the
 * interface can be honest about having snapped somewhere.
 */
export function nearestCityWithKind(location: LatLon, kind: CityKind): NearestCity | null {
  const candidates = kind === "origin" ? ORIGIN_CITIES : CITIES.filter((city) => city.kinds.includes(kind));
  let nearest: City | null = null;
  let nearestKm = Number.POSITIVE_INFINITY;
  for (const city of candidates) {
    const distance = haversineKm(location, city);
    if (distance < nearestKm) {
      nearestKm = distance;
      nearest = city;
    }
  }
  return nearest ? { city: nearest, distanceKm: nearestKm } : null;
}

export function nearestOriginCity(location: LatLon): NearestCity | null {
  return nearestCityWithKind(location, "origin");
}
