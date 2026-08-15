import * as THREE from "three";
import { CITIES } from "../data/geo";
import type { City } from "../data/types";
import { haversineKm, vector3ToLatLon } from "./geometry";
import type { GlobeScene } from "./scene";

const SELECTABLE = CITIES.filter((c) => c.kinds.includes("origin"));
const MAX_SNAP_KM = 900;

export interface PickResult {
  city: City | null;
}

/** Raycasts a screen point onto the globe and snaps to the nearest selectable city. */
export function pickCityAt(globe: GlobeScene, clientX: number, clientY: number): PickResult {
  const rect = globe.stage.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, globe.camera);
  const hits = raycaster.intersectObject(globe.worldMesh, false);
  if (hits.length === 0) return { city: null };

  // The hit point is in world space; the globe's own rotation is undone so
  // latLon math (which assumes an unrotated sphere) sees the sphere's surface.
  const localPoint = globe.globeGroup.worldToLocal(hits[0].point.clone());
  const latLon = vector3ToLatLon(localPoint);

  let nearest: City | null = null;
  let nearestDist = Infinity;
  for (const city of SELECTABLE) {
    const d = haversineKm(latLon, city);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = city;
    }
  }

  return { city: nearestDist <= MAX_SNAP_KM ? nearest : null };
}
