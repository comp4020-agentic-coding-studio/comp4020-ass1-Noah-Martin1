import * as THREE from "three";
import type { LatLon } from "../data/types";

/** Converts a lat/lon (degrees) to a point on a sphere of the given radius. */
export function latLonToVector3({ lat, lon }: LatLon, radius: number, out = new THREE.Vector3()): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  out.x = -radius * Math.sin(phi) * Math.cos(theta);
  out.y = radius * Math.cos(phi);
  out.z = radius * Math.sin(phi) * Math.sin(theta);
  return out;
}

/** Inverse of latLonToVector3: a point on (or near) the unit sphere back to lat/lon. */
export function vector3ToLatLon(point: THREE.Vector3): LatLon {
  const normalized = point.clone().normalize();
  const lat = 90 - (Math.acos(normalized.y) * 180) / Math.PI;
  let lon = (Math.atan2(normalized.z, -normalized.x) * 180) / Math.PI - 180;
  if (lon < -180) lon += 360;
  if (lon > 180) lon -= 360;
  return { lat, lon };
}

const EARTH_RADIUS_KM = 6371;

/** Spherical midpoint between two lat/lon points (via unit-vector averaging). */
export function midpointLatLon(a: LatLon, b: LatLon): LatLon {
  const va = latLonToVector3(a, 1);
  const vb = latLonToVector3(b, 1);
  const mid = va.add(vb);
  if (mid.lengthSq() < 1e-9) mid.set(0, 1, 0); // antipodal fallback
  return vector3ToLatLon(mid.normalize());
}

export function haversineKm(a: LatLon, b: LatLon): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A great-circle arc between two lat/lon points, lifted off the surface at
 * its midpoint so routes read as paths in space rather than lines painted on
 * the sphere (and so two arcs sharing endpoints don't z-fight the terrain).
 */
export function greatCircleArcPoints(a: LatLon, b: LatLon, radius: number, lift: number, segments = 48): THREE.Vector3[] {
  const start = latLonToVector3(a, radius);
  const end = latLonToVector3(b, radius);
  const angle = start.angleTo(end);
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let point: THREE.Vector3;
    if (angle < 1e-6) {
      point = start.clone().lerp(end, t);
    } else {
      const sinAngle = Math.sin(angle);
      const factorA = Math.sin((1 - t) * angle) / sinAngle;
      const factorB = Math.sin(t * angle) / sinAngle;
      point = start.clone().multiplyScalar(factorA).add(end.clone().multiplyScalar(factorB));
    }
    const bulge = 1 + Math.sin(t * Math.PI) * lift;
    point.normalize().multiplyScalar(radius * bulge);
    points.push(point);
  }
  return points;
}
