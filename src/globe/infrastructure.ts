import * as THREE from "three";
import { CITIES, CITY_BY_ID, GROUND_STATIONS, HUB_EDGES } from "../data/geo";
import type { LatLon, Route } from "../data/types";
import { reducedMotion } from "../reduced-motion";
import { greatCircleArcPoints, latLonToVector3 } from "./geometry";
import type { LayerVisibility } from "../state";

const FIBRE_COLOR = new THREE.Color(0xff8a5c);
const SUBMARINE_COLOR = new THREE.Color(0x5cc9ff);
const TOWER_COLOR = new THREE.Color(0xffc266);
const GROUND_STATION_COLOR = new THREE.Color(0xb98bff);
const SERVER_COLOR = new THREE.Color(0x5cffb0);
const ROUTE_COLOR = new THREE.Color(0xffffff);

const TOWER_CITIES = CITIES.filter((c) => c.kinds.includes("origin") && !c.kinds.includes("hub"));
const SERVER_CITIES = CITIES.filter((c) => c.kinds.includes("server"));
const ORIGIN_CITIES = CITIES.filter((c) => c.kinds.includes("origin"));

function markerMesh(geometry: THREE.BufferGeometry, color: THREE.Color, position: THREE.Vector3): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 }));
  mesh.position.copy(position);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), position.clone().normalize());
  return mesh;
}

function arcLine(a: LatLon, b: LatLon, radius: number, lift: number, color: THREE.Color): THREE.Line {
  const points = greatCircleArcPoints(a, b, radius, lift);
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.16 });
  return new THREE.Line(geometry, material);
}

export interface InfrastructureLayer {
  group: THREE.Group;
  setRoute(route: Route | null): void;
  setStageAndLayers(index: number, layers: LayerVisibility): void;
  update(dtMs: number): void;
}

export function buildInfrastructureLayer(sphereRadius: number): InfrastructureLayer {
  const group = new THREE.Group();

  // --- baseline: subtle sparkling city points, always on (geography aid, not a toggle) ---
  const cityPositions = new Float32Array(ORIGIN_CITIES.length * 3);
  ORIGIN_CITIES.forEach((city, i) => {
    const v = latLonToVector3(city, sphereRadius * 1.002);
    cityPositions[i * 3] = v.x;
    cityPositions[i * 3 + 1] = v.y;
    cityPositions[i * 3 + 2] = v.z;
  });
  const cityGeometry = new THREE.BufferGeometry();
  cityGeometry.setAttribute("position", new THREE.BufferAttribute(cityPositions, 3));
  const cityPoints = new THREE.Points(
    cityGeometry,
    new THREE.PointsMaterial({ color: 0xdfe7ff, size: 0.02, sizeAttenuation: true, transparent: true, opacity: 0.55 }),
  );
  group.add(cityPoints);

  // --- fibre backbone: one arc per hub edge ---
  const backboneLines = HUB_EDGES.map((edge) => {
    const a = CITY_BY_ID.get(edge.a)!;
    const b = CITY_BY_ID.get(edge.b)!;
    const color = edge.kind === "submarine" ? SUBMARINE_COLOR : FIBRE_COLOR;
    const line = arcLine(a, b, sphereRadius, 0.05, color);
    line.userData.edge = edge;
    group.add(line);
    return line;
  });

  // --- 5G towers: small cones over non-hub origin cities ---
  const towerMeshes = TOWER_CITIES.map((city) => {
    const position = latLonToVector3(city, sphereRadius * 1.01);
    const mesh = markerMesh(new THREE.ConeGeometry(0.014, 0.05, 6), TOWER_COLOR, position);
    mesh.userData.cityId = city.id;
    group.add(mesh);
    return mesh;
  });

  // --- Starlink ground stations ---
  const groundStationMeshes = GROUND_STATIONS.map((gs) => {
    const position = latLonToVector3(gs, sphereRadius * 1.01);
    const mesh = markerMesh(new THREE.OctahedronGeometry(0.02), GROUND_STATION_COLOR, position);
    mesh.userData.gsId = gs.id;
    group.add(mesh);
    return mesh;
  });

  // --- major servers / data centres ---
  const serverMeshes = SERVER_CITIES.map((city) => {
    const position = latLonToVector3(city, sphereRadius * 1.012);
    const mesh = markerMesh(new THREE.IcosahedronGeometry(0.024), SERVER_COLOR, position);
    mesh.userData.cityId = city.id;
    group.add(mesh);
    return mesh;
  });

  // --- dynamic route overlay, rebuilt whenever the route changes ---
  const routeGroup = new THREE.Group();
  group.add(routeGroup);

  let currentRoute: Route | null = null;
  let segments: { kind: "arc" | "radio" | "radial"; object: THREE.Object3D; from: THREE.Vector3; to: THREE.Vector3 }[] = [];
  let pulse: THREE.Mesh | null = null;
  let elapsedMs = 0;

  function shellPoint(location: LatLon): THREE.Vector3 {
    return latLonToVector3(location, sphereRadius * 1.35);
  }

  function surfacePoint(location: LatLon): THREE.Vector3 {
    return latLonToVector3(location, sphereRadius * 1.006);
  }

  function clearRoute(): void {
    while (routeGroup.children.length > 0) routeGroup.remove(routeGroup.children[0]);
    segments = [];
    pulse = null;
  }

  function addArcSegment(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color): void {
    const geometry = new THREE.BufferGeometry().setFromPoints(sampleArcBetween(a, b));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    routeGroup.add(line);
    segments.push({ kind: "arc", object: line, from: a, to: b });
  }

  function sampleArcBetween(a: THREE.Vector3, b: THREE.Vector3, segmentsCount = 32): THREE.Vector3[] {
    const angle = a.angleTo(b);
    const points: THREE.Vector3[] = [];
    const radius = a.length();
    for (let i = 0; i <= segmentsCount; i++) {
      const t = i / segmentsCount;
      let point: THREE.Vector3;
      if (angle < 1e-6) {
        point = a.clone().lerp(b, t);
      } else {
        const s = Math.sin(angle);
        point = a
          .clone()
          .multiplyScalar(Math.sin((1 - t) * angle) / s)
          .add(b.clone().multiplyScalar(Math.sin(t * angle) / s));
      }
      point.normalize().multiplyScalar(radius);
      points.push(point);
    }
    return points;
  }

  function addRadialSegment(surface: THREE.Vector3, shell: THREE.Vector3, color: THREE.Color): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([surface, shell]);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    routeGroup.add(line);
    segments.push({ kind: "radial", object: line, from: surface, to: shell });
  }

  function addRipple(at: THREE.Vector3): void {
    const geometry = new THREE.RingGeometry(0.02, 0.026, 32);
    const material = new THREE.MeshBasicMaterial({
      color: TOWER_COLOR,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(geometry, material);
    ring.position.copy(at);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), at.clone().normalize());
    routeGroup.add(ring);
    segments.push({ kind: "radio", object: ring, from: at, to: at });
  }

  function addPulseMarker(at: THREE.Vector3, color: THREE.Color): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.028, 12, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
    );
    mesh.position.copy(at);
    routeGroup.add(mesh);
    return mesh;
  }

  function setRoute(route: Route | null): void {
    currentRoute = route;
    clearRoute();
    if (!route) return;

    for (let i = 1; i < route.steps.length; i++) {
      const prev = route.steps[i - 1];
      const curr = route.steps[i];
      switch (curr.infra) {
        case "wireless":
          addRipple(surfacePoint(curr.location));
          break;
        case "fibre-terrestrial":
          addArcSegment(surfacePoint(prev.location), surfacePoint(curr.location), FIBRE_COLOR);
          break;
        case "fibre-submarine":
          addArcSegment(surfacePoint(prev.location), surfacePoint(curr.location), SUBMARINE_COLOR);
          break;
        case "satellite-uplink":
          addRadialSegment(surfacePoint(prev.location), shellPoint(curr.location), ROUTE_COLOR);
          break;
        case "satellite-link":
          addArcSegment(shellPoint(prev.location), shellPoint(curr.location), ROUTE_COLOR);
          break;
        case "ground-link":
          addArcSegment(shellPoint(prev.location), shellPoint(curr.location), ROUTE_COLOR);
          addRadialSegment(surfacePoint(curr.location), shellPoint(curr.location), ROUTE_COLOR);
          break;
        default:
          break;
      }
    }

    pulse = addPulseMarker(surfacePoint(route.steps[0].location), ROUTE_COLOR);
  }

  function updateLayerEmphasis(layers: LayerVisibility): void {
    for (const line of backboneLines) {
      const material = line.material as THREE.LineBasicMaterial;
      material.opacity = layers.fibre ? 0.75 : 0.16;
    }
    for (const mesh of towerMeshes) {
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity = layers.towers ? 0.9 : 0.35;
    }
    for (const mesh of groundStationMeshes) {
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity = layers.groundStations ? 0.9 : 0.3;
    }
    for (const mesh of serverMeshes) {
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity = layers.servers ? 0.95 : 0.45;
    }
  }

  let lastLayers: LayerVisibility | null = null;
  let stageIndex = 0;

  function setStageAndLayers(index: number, layers: LayerVisibility): void {
    stageIndex = index;
    if (lastLayers !== layers) {
      lastLayers = layers;
      updateLayerEmphasis(layers);
    }
  }

  function update(dtMs: number): void {
    if (!reducedMotion.value) elapsedMs += dtMs;

    // Reveal route segments up to the current scroll stage; keep the rest dim.
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const reached = i < stageIndex;
      if (seg.kind === "radio") {
        const mesh = seg.object as THREE.Mesh;
        mesh.visible = reached || i === stageIndex - 1;
        if (!mesh.visible) continue;
        const cycle = reducedMotion.value ? 0.5 : (elapsedMs % 1600) / 1600;
        const scale = 1 + cycle * 3.2;
        mesh.scale.set(scale, scale, scale);
        (mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - cycle);
      } else {
        const line = seg.object as THREE.Line;
        const material = line.material as THREE.LineBasicMaterial;
        material.opacity = reached ? 0.95 : 0.12;
      }
    }

    if (pulse && currentRoute) {
      const active = segments[Math.max(0, Math.min(segments.length, stageIndex) - 1)];
      if (active && (active.kind === "arc" || active.kind === "radial")) {
        const t = reducedMotion.value ? 0.5 : (elapsedMs % 2200) / 2200;
        pulse.position.copy(active.from).lerp(active.to, t);
        pulse.visible = true;
      } else if (stageIndex === 0) {
        pulse.position.copy(surfacePoint(currentRoute.steps[0].location));
        pulse.visible = true;
      } else {
        pulse.visible = false;
      }
    }
  }

  return { group, setRoute, setStageAndLayers, update };
}
