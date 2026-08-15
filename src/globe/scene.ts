import * as THREE from "three";
import { buildAtmosphere, buildCloudTexture, buildPlanetTextures, buildStarfield } from "./textures";

export interface GlobeScene {
  stage: HTMLElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  globeGroup: THREE.Group;
  worldMesh: THREE.Mesh;
  cloudMesh: THREE.Mesh;
  starfield: THREE.Points;
  sphereRadius: number;
  resize(): void;
  render(): void;
}

export function createGlobeScene(stage: HTMLElement): GlobeScene {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 4.5);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  stage.appendChild(renderer.domElement);

  const sphereRadius = 1.6;
  const globeGroup = new THREE.Group();

  const { colorMap, normalMap, roughnessMap, emissiveMap } = buildPlanetTextures();

  const worldMesh = new THREE.Mesh(
    new THREE.SphereGeometry(sphereRadius, 96, 64),
    new THREE.MeshStandardMaterial({
      map: colorMap,
      normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughnessMap,
      roughness: 1,
      metalness: 0,
      emissiveMap,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.5,
    }),
  );
  globeGroup.add(worldMesh);

  const cloudMesh = new THREE.Mesh(
    new THREE.SphereGeometry(sphereRadius * 1.018, 64, 48),
    new THREE.MeshBasicMaterial({ map: buildCloudTexture(), transparent: true, depthWrite: false }),
  );
  globeGroup.add(cloudMesh);

  scene.add(globeGroup);
  scene.add(buildAtmosphere(sphereRadius));

  const starfield = buildStarfield();
  scene.add(starfield);

  const sunLight = new THREE.DirectionalLight(0xfff2df, 2.6);
  sunLight.position.set(5, 2.2, 3.4);
  scene.add(sunLight);

  const fillLight = new THREE.HemisphereLight(0x9fb8ff, 0x14161f, 0.4);
  scene.add(fillLight);

  function resize(): void {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function render(): void {
    renderer.render(scene, camera);
  }

  return { stage, scene, camera, renderer, globeGroup, worldMesh, cloudMesh, starfield, sphereRadius, resize, render };
}
