import { CITY_BY_ID } from "./data/geo";
import { loadCities, loadLand, loadStarlink } from "./data/generated/datasets";
import type { Route } from "./data/types";
import { createEarth } from "./globe2/earth";
import { bakeLandTexture } from "./globe2/land-texture";
import { createNetworkLayer } from "./globe2/network";
import { attachOrbitControls } from "./globe2/orbit-controls";
import { pickCityAt } from "./globe2/picking";
import { createRouteLayer } from "./globe2/route";
import { createGlobeScene } from "./globe2/scene";
import { createSky } from "./globe2/sky";
import { createStarlinkField, type StarlinkField } from "./globe2/starlink-field";
import { createStoryPanel } from "./scroll/story";
import { setDestination, setOrigin, state, subscribe } from "./state";
import { createControlPanel } from "./ui/panel";

/** Looks up a required element and narrows it, so the rest of the module (and
 *  every closure in it) can treat these as non-null. */
function required<T extends Element>(id: string, constructor: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected #${id} in index.html`);
  }
  return element;
}

const canvas = required("globe-canvas", HTMLCanvasElement);
const focusAnchor = required("globe-focus", HTMLElement);
const panelHost = required("control-panel-host", HTMLElement);
const storyHost = required("story-host", HTMLElement);
const dataNote = required("data-note", HTMLElement);

const panel = createControlPanel();
panelHost.append(panel.el);

const story = createStoryPanel();
storyHost.append(story.el);

// --- scene graph ---------------------------------------------------------

const globe = createGlobeScene(canvas);
const sky = createSky(globe.renderer, globe.scene);
const earth = createEarth();
const network = createNetworkLayer();
const route = createRouteLayer();

globe.scene.add(sky.group, earth.group, network.group, route.group);

let starlink: StarlinkField | null = null;

// --- layout ---------------------------------------------------------------

/**
 * Reframes on every layout change. The canvas always fills the window, so this
 * only moves where the planet sits within it and how large it is drawn --
 * which is what lets one layout work from a phone to an ultrawide rather than
 * being tuned to two fixed viewports.
 */
function reframe(): void {
  globe.resize();
  const rect = focusAnchor.getBoundingClientRect();
  globe.setFocusRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  controls.refit();

  const ratio = globe.renderer.getPixelRatio();
  sky.setPixelRatio(ratio);
  earth.setPixelRatio(ratio);
  network.setPixelRatio(ratio);
  route.setPixelRatio(ratio);
  route.setResolution(window.innerWidth, window.innerHeight);
  starlink?.setPixelRatio(ratio);
}

// --- interaction ----------------------------------------------------------

let pickPhase: "origin" | "destination" = "origin";

const controls = attachOrbitControls(globe, {
  onTap(clientX, clientY) {
    const { city, location } = pickCityAt(globe, earth.mesh, clientX, clientY);
    if (!location) return; // tapped empty space, not the planet
    if (!city) {
      panel.setFeedback("No modelled coverage there — try a populated area.");
      return;
    }
    panel.setFeedback(null);
    controls.focusOn(city);
    if (pickPhase === "origin") {
      setOrigin(city.id);
      pickPhase = "destination";
    } else {
      setDestination(city.id);
      pickPhase = "origin";
    }
  },
});

window.addEventListener("resize", reframe);
new ResizeObserver(reframe).observe(focusAnchor);
reframe();

// --- state ----------------------------------------------------------------

let lastRoute: Route | null = null;
let lastStage = -1;

subscribe((s) => {
  const routeChanged = s.route !== lastRoute;
  if (routeChanged) {
    lastRoute = s.route;
    lastStage = -1;
    route.setRoute(s.route);
  }
  route.setStage(s.stageIndex);
  network.setLayers(s.layers);
  starlink?.setVisible(s.starlinkOn);
  starlink?.setOrigin(s.originId ? (CITY_BY_ID.get(s.originId) ?? null) : null);

  // Turn the globe to whichever hop is being read about. Without this the
  // route regularly sits on the far side of the planet and the story describes
  // something the reader cannot see -- the camera is part of the explanation,
  // not just a viewport.
  if (s.route && s.stageIndex !== lastStage) {
    lastStage = s.stageIndex;
    const index = Math.max(0, Math.min(s.route.steps.length - 1, s.stageIndex - 1));
    controls.focusOn(s.route.steps[index].location);
  }
});

// --- data -----------------------------------------------------------------

const notes: string[] = ["Routes are simplified illustrations of real infrastructure, not live traceroutes."];

function publishNotes(): void {
  dataNote.textContent = notes.join(" ");
}
publishNotes();

const anisotropy = globe.renderer.capabilities.getMaxAnisotropy();

// Coarse coastlines first so the planet is readable almost immediately, then
// the finer set once it arrives -- a 1.2 MB download shouldn't hold up a globe.
loadLand("110m")
  .then((land) => {
    earth.setLandTexture(bakeLandTexture(land, anisotropy));
    return loadLand("50m");
  })
  .then((land) => earth.setLandTexture(bakeLandTexture(land, anisotropy)))
  .catch(() => {
    notes.push("Coastline data failed to load.");
    publishNotes();
  });

loadCities()
  .then((cities) => earth.setCities(cities))
  .catch(() => undefined);

loadStarlink()
  .then(({ meta, satellites }) => {
    starlink = createStarlinkField(satellites);
    globe.scene.add(starlink.points);
    starlink.setVisible(state.starlinkOn);
    starlink.setPixelRatio(globe.renderer.getPixelRatio());
    if (state.originId) starlink.setOrigin(CITY_BY_ID.get(state.originId) ?? null);

    const snapshot = new Date(meta.fetchedAt).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    notes.push(
      `Starlink: all ${starlink.count.toLocaleString("en-AU")} satellites in the public CelesTrak catalogue ` +
        `(snapshot ${snapshot}), propagated with a simplified model and shown at 10× speed.`,
    );
    publishNotes();
  })
  .catch(() => {
    notes.push("Starlink orbital data failed to load.");
    publishNotes();
  });

// --- frame loop -----------------------------------------------------------

let lastTime = performance.now();

function frame(now: number): void {
  const elapsed = now - lastTime;
  lastTime = now;
  // Animation uses a clamped delta so a background tab or a long stall doesn't
  // teleport everything; the quality controller needs the real number.
  const dtMs = Math.min(64, elapsed);

  controls.update(dtMs);
  sky.update(dtMs);
  earth.update(dtMs);
  route.update(dtMs);
  starlink?.update(dtMs);
  globe.render();
  globe.notifyFrame(elapsed);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
