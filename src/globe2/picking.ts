import * as THREE from "three";
import { CITIES } from "../data/geo";
import type { City, LatLon } from "../data/types";
import { haversineKm, vector3ToLatLon } from "../globe/geometry";
import type { GlobeScene } from "./scene";

/**
 * Turns a tap on the globe into a selectable place.
 *
 * The raycast lands on bare geography, so it is snapped to the nearest city
 * that can actually originate a request. Anything further than the snap radius
 * from one -- open ocean, Antarctica, deep wilderness -- returns null, which is
 * how the interface avoids implying that every point on Earth has coverage.
 */

const SNAP_RADIUS_KM = 1100;

const ORIGIN_CITIES = CITIES.filter((city) => city.kinds.includes("origin"));

export interface PickResult {
  city: City | null;
  /** Where the ray actually hit, whether or not a city was close enough. */
  location: LatLon | null;
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

export function pickCityAt(globe: GlobeScene, target: THREE.Mesh, clientX: number, clientY: number): PickResult {
  // Normalised device coordinates over the whole window, since the canvas is
  // full-bleed. The camera's view offset is already baked into its projection
  // matrix, so the raycaster accounts for the off-centre framing for free.
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(pointer, globe.camera);
  const [hit] = raycaster.intersectObject(target, false);
  if (!hit) return { city: null, location: null };

  const location = vector3ToLatLon(hit.point);

  let nearest: City | null = null;
  let nearestKm = Number.POSITIVE_INFINITY;
  for (const city of ORIGIN_CITIES) {
    const distance = haversineKm(location, city);
    if (distance < nearestKm) {
      nearestKm = distance;
      nearest = city;
    }
  }

  return { city: nearestKm <= SNAP_RADIUS_KM ? nearest : null, location };
}
