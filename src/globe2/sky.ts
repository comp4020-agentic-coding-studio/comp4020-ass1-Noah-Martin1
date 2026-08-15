import * as THREE from "three";
import { reducedMotion } from "../reduced-motion";

/**
 * The space background: a Milky Way band, a star field, a sun and a moon.
 *
 * Everything here lives in world space and never follows the camera, which is
 * the whole point -- because the camera orbits the planet rather than the
 * planet spinning under a fixed camera, dragging sweeps the stars past exactly
 * the way it does on satellitemap.space.
 *
 * The nebulosity is baked once into an equirectangular texture instead of being
 * evaluated per-pixel every frame: it is low-frequency, so a texture is
 * indistinguishable from live fbm, and it turns a multi-octave noise field per
 * pixel into a single cheap sample. Stars stay real geometry so they stay sharp
 * at any zoom and can twinkle.
 */

const SKY_RADIUS = 90;
const STAR_COUNT = 9000;

/** Tilt of the galactic plane, chosen to sit diagonally across the frame. */
const GALACTIC_NORMAL = new THREE.Vector3(0.36, 0.86, -0.36).normalize();

const NEBULA_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uGalacticNormal;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }

  float fbm(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 6; i++) {
      sum += amp * noise(p);
      p *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }

  void main() {
    // Invert three.js's equirect convention so this texture can be used
    // directly as scene.background.
    float phi = (vUv.x - 0.5) * 6.2831853;
    float theta = (vUv.y - 0.5) * 3.14159265;
    float cosT = cos(theta);
    vec3 dir = normalize(vec3(cosT * cos(phi), sin(theta), cosT * sin(phi)));

    // Distance from the galactic plane drives a soft gaussian band.
    float t = dot(dir, uGalacticNormal);
    float band = exp(-(t * t) / (2.0 * 0.20 * 0.20));

    // Patchiness along the band, so it never reads as a painted stripe.
    float clumps = fbm(dir * 3.1 + 11.0);
    float density = band * (0.35 + 0.95 * clumps);

    // Dark dust lanes bite into the brightest part of the band.
    float lanes = smoothstep(0.42, 0.78, fbm(dir * 5.7 - 4.0));
    density *= 1.0 - 0.7 * lanes * exp(-(t * t) / (2.0 * 0.10 * 0.10));

    // Faint high-altitude cirrus keeps the rest of the sky from being flat.
    float cirrus = smoothstep(0.62, 0.98, fbm(dir * 1.7 + 30.0)) * 0.02;

    vec3 cool = vec3(0.13, 0.17, 0.30);
    vec3 warm = vec3(0.34, 0.24, 0.20);
    vec3 tint = mix(cool, warm, smoothstep(0.15, 0.85, fbm(dir * 2.0 + 5.0)));

    // Kept deliberately dim. The background has to stay secondary to the globe,
    // and anything brighter than this starts to bloom.
    vec3 base = vec3(0.004, 0.006, 0.013);
    vec3 colour = base + tint * (density * 0.20 + cirrus);

    gl_FragColor = vec4(colour, 1.0);
  }
`;

const STAR_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColour;
  uniform float uPixelRatio;
  uniform float uTime;
  uniform float uTwinkle;
  varying vec3 vColour;
  varying float vBrightness;

  void main() {
    vColour = aColour;
    // Each star drifts on its own phase, so the field shimmers instead of
    // pulsing in unison.
    float twinkle = 1.0 - uTwinkle * 0.35 * (0.5 + 0.5 * sin(uTime * 1.7 + aPhase));
    vBrightness = twinkle;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio * twinkle;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  precision mediump float;
  varying vec3 vColour;
  varying float vBrightness;

  void main() {
    // A tight core with a soft halo reads as a star rather than a disc.
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float core = smoothstep(1.0, 0.0, d);
    float alpha = core * core * core;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(vColour * vBrightness, alpha);
  }
`;

export interface Sky {
  group: THREE.Group;
  /** Direction the sun sits in, for lighting the moon and any lens effects. */
  sunDirection: THREE.Vector3;
  setPixelRatio(ratio: number): void;
  update(dtMs: number): void;
  dispose(): void;
}

function bakeNebula(renderer: THREE.WebGLRenderer): THREE.Texture {
  const width = 2048;
  const height = 1024;
  const target = new THREE.WebGLRenderTarget(width, height, {
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.colorSpace = THREE.SRGBColorSpace;

  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: { uGalacticNormal: { value: GALACTIC_NORMAL } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: NEBULA_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quadScene.add(quad);

  const previousTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(quadScene, quadCamera);
  renderer.setRenderTarget(previousTarget);

  quad.geometry.dispose();
  material.dispose();

  target.texture.mapping = THREE.EquirectangularReflectionMapping;
  return target.texture;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildStars(): { points: THREE.Points; material: THREE.ShaderMaterial } {
  const random = mulberry32(20260815);
  const positions = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);
  const phases = new Float32Array(STAR_COUNT);
  const colours = new Float32Array(STAR_COUNT * 3);

  const direction = new THREE.Vector3();
  const tangentA = new THREE.Vector3();
  const tangentB = new THREE.Vector3();
  tangentA.set(1, 0, 0).cross(GALACTIC_NORMAL).normalize();
  tangentB.copy(GALACTIC_NORMAL).cross(tangentA).normalize();

  for (let i = 0; i < STAR_COUNT; i++) {
    // A third of the stars cluster towards the galactic plane, which is what
    // makes the band read as stars rather than only as painted nebulosity.
    if (i % 3 === 0) {
      const angle = random() * Math.PI * 2;
      // Gaussian-ish offset from the plane via summed uniforms.
      const spread = (random() + random() + random() - 1.5) * 0.22;
      direction
        .copy(tangentA)
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(tangentB, Math.sin(angle))
        .addScaledVector(GALACTIC_NORMAL, spread)
        .normalize();
    } else {
      const u = random() * 2 - 1;
      const angle = random() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      direction.set(r * Math.cos(angle), u, r * Math.sin(angle));
    }

    positions[i * 3] = direction.x * SKY_RADIUS;
    positions[i * 3 + 1] = direction.y * SKY_RADIUS;
    positions[i * 3 + 2] = direction.z * SKY_RADIUS;

    // Skew towards faint stars so a handful of bright ones stand out.
    const magnitude = random() ** 3.2;
    sizes[i] = 0.7 + magnitude * 2.6;
    phases[i] = random() * Math.PI * 2;

    const warmth = random();
    const brightness = 0.55 + magnitude * 0.45;
    if (warmth > 0.86) {
      colours[i * 3] = 1.0 * brightness;
      colours[i * 3 + 1] = 0.83 * brightness;
      colours[i * 3 + 2] = 0.68 * brightness;
    } else if (warmth < 0.16) {
      colours[i * 3] = 0.72 * brightness;
      colours[i * 3 + 1] = 0.82 * brightness;
      colours[i * 3 + 2] = 1.0 * brightness;
    } else {
      colours[i * 3] = 0.94 * brightness;
      colours[i * 3 + 1] = 0.96 * brightness;
      colours[i * 3 + 2] = 1.0 * brightness;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("aColour", new THREE.BufferAttribute(colours, 3));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uTime: { value: 0 },
      uTwinkle: { value: reducedMotion.value ? 0 : 1 },
    },
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return { points: new THREE.Points(geometry, material), material };
}

function buildSun(direction: THREE.Vector3): THREE.Group {
  const group = new THREE.Group();
  group.position.copy(direction).multiplyScalar(62);

  // Bright core -- deliberately over-bright so the bloom pass gives it a
  // corona rather than us faking one with extra geometry.
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff6e2, toneMapped: false }),
  );
  group.add(core);

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 24, 16),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      vertexShader: /* glsl */ `
        varying vec3 vNormalView;
        void main() {
          vNormalView = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        varying vec3 vNormalView;
        void main() {
          float rim = pow(max(0.0, dot(vNormalView, vec3(0.0, 0.0, 1.0))), 2.4);
          gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * rim * 0.32, rim * 0.32);
        }
      `,
    }),
  );
  group.add(glow);
  return group;
}

function buildMoon(sunDirection: THREE.Vector3): THREE.Mesh {
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 32, 24),
    new THREE.ShaderMaterial({
      uniforms: { uSunDirection: { value: sunDirection.clone() } },
      vertexShader: /* glsl */ `
        varying vec3 vWorldNormal;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform vec3 uSunDirection;
        varying vec3 vWorldNormal;
        varying vec2 vUv;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        void main() {
          // Real phase: the lit fraction follows the sun's actual direction.
          float lit = smoothstep(-0.08, 0.22, dot(normalize(vWorldNormal), normalize(uSunDirection)));
          // Coarse mare mottling so it doesn't read as a plain grey ball.
          float mottle = 0.88 + 0.12 * hash(floor(vUv * 26.0));
          vec3 colour = vec3(0.78, 0.79, 0.82) * mottle * lit;
          gl_FragColor = vec4(colour, 1.0);
        }
      `,
    }),
  );
  moon.position.set(-26, 11, -22);
  return moon;
}

export function createSky(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Sky {
  const group = new THREE.Group();

  const nebula = bakeNebula(renderer);
  scene.background = nebula;

  const { points: stars, material: starMaterial } = buildStars();
  group.add(stars);

  const sunDirection = new THREE.Vector3(0.62, 0.34, 0.71).normalize();
  group.add(buildSun(sunDirection));
  group.add(buildMoon(sunDirection));

  let elapsedSeconds = 0;

  function setPixelRatio(ratio: number): void {
    starMaterial.uniforms.uPixelRatio.value = ratio;
  }

  function update(dtMs: number): void {
    const twinkling = !reducedMotion.value;
    starMaterial.uniforms.uTwinkle.value = twinkling ? 1 : 0;
    if (!twinkling) return;
    elapsedSeconds += dtMs / 1000;
    starMaterial.uniforms.uTime.value = elapsedSeconds;
  }

  function dispose(): void {
    nebula.dispose();
    stars.geometry.dispose();
    starMaterial.dispose();
  }

  return { group, sunDirection, setPixelRatio, update, dispose };
}
