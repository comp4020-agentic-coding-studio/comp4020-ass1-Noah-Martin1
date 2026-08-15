import { CITY_BY_ID } from "./data/geo";
import { cableSegments, loadCableMeta, loadCables } from "./data/generated/cables";
import { loadCoverage, loadStarlinkGateways, type Coverage } from "./data/generated/coverage";
import { loadCities, loadLand, loadStarlink, type PackedCity } from "./data/generated/datasets";
import type { LatLon, Route } from "./data/types";
import { haversineKm } from "./globe/geometry";
import { createCameraDirector, nodePose, overviewPose, relayPose, uplinkPose, type Pose } from "./globe2/camera-director";
import { createEarth } from "./globe2/earth";
import { createHoverCursor } from "./globe2/hover-cursor";
import { bakeLandTexture } from "./globe2/land-texture";
import { createNetworkLayer } from "./globe2/network";
import { attachOrbitControls } from "./globe2/orbit-controls";
import { locationAt, nearestCityWithKind } from "./globe2/picking";
import { createRouteLayer } from "./globe2/route";
import { createGlobeScene } from "./globe2/scene";
import { createSky } from "./globe2/sky";
import { createStarlinkField, type StarlinkField } from "./globe2/starlink-field";
import { createStoryPanel } from "./scroll/story";
import { setDestination, setOrigin, state, subscribe } from "./state";
import { createControlPanel } from "./ui/panel";
import { createPrompt } from "./ui/prompt";

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
const promptHost = required("prompt-host", HTMLElement);

const panel = createControlPanel();
panelHost.append(panel.el);

const story = createStoryPanel();
storyHost.append(story.el);

const prompt = createPrompt();
promptHost.append(prompt.el);

// --- scene graph ---------------------------------------------------------

const globe = createGlobeScene(canvas);
const sky = createSky(globe.renderer, globe.scene);
const earth = createEarth();
const network = createNetworkLayer();
const route = createRouteLayer();
const hover = createHoverCursor(globe, document.body);
const director = createCameraDirector(globe.camera);

globe.scene.add(sky.group, earth.group, network.group, route.group, hover.group);

let starlink: StarlinkField | null = null;

// --- coverage -------------------------------------------------------------

/**
 * Whether a request could start at a location.
 *
 * Until the coverage masks arrive this falls back to proximity to a populated
 * place, which is the same idea at lower resolution: the model is "people live
 * here, so there is service here", never "every point on Earth is connected".
 */
let citiesForCoverage: PackedCity[] = [];
let coverage: Coverage | null = null;

function fallbackCovered(location: LatLon): boolean {
  if (location.lat < -60) return false; // Antarctica is out either way
  for (const [lon, lat] of citiesForCoverage) {
    if (Math.abs(lat - location.lat) > 3) continue; // cheap reject before the trig
    if (haversineKm(location, { lat, lon }) < 320) return true;
  }
  return false;
}

/**
 * Which model answers depends on the mode the user is in: Starlink is licensed
 * country by country and genuinely unavailable in places with excellent mobile
 * coverage (and vice versa), so the same point can be green in one mode and
 * red in the other. That difference is the point.
 */
function coveredAt(location: LatLon): boolean {
  if (!coverage) return fallbackCovered(location);
  const mask = state.starlinkOn ? coverage.starlink : coverage.mobile;
  return mask.has(location.lat, location.lon);
}

// --- layout ---------------------------------------------------------------

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

// --- camera shots ---------------------------------------------------------

function playShot(pose: Pose, durationMs: number): void {
  controls.suspend();
  director.playPose(pose, durationMs);
}

/** Hands the camera back to the user, from anywhere in the sequence. */
function releaseShot(): void {
  if (!director.active) return;
  director.release();
  controls.resume();
}

// --- the flow -------------------------------------------------------------

type Phase = "choose-origin" | "choose-destination" | "journey";

function phaseFor(originId: string | null, destId: string | null): Phase {
  if (!originId) return "choose-origin";
  if (!destId) return "choose-destination";
  return "journey";
}

let phase: Phase = "choose-origin";

/*
 * A finger cannot hover, so the instruction has to name the gesture the device
 * actually has. The ring still appears on touch — it just appears on press
 * rather than on approach — so the coverage feedback survives the swap.
 */
const coarsePointer = window.matchMedia("(pointer: coarse)");

function applyPhase(next: Phase): void {
  phase = next;
  const choosing = next !== "journey";
  hover.setEnabled(choosing);

  if (next === "choose-origin") {
    const gesture = coarsePointer.matches ? "Press and drag over the globe" : "Hover the globe";
    prompt.show(
      "Where should the request start?",
      state.starlinkOn
        ? `${gesture} — green means Starlink serves that spot. Tap to choose.`
        : `${gesture} — green means there's mobile coverage. Tap to choose.`,
    );
  } else if (next === "choose-destination") {
    prompt.show("Now pick where it's going.", "Choose the server you're trying to reach.");
  } else {
    prompt.show("Scroll to follow the request.", "Each step explains what the network is doing.");
  }
}

const controls = attachOrbitControls(globe, {
  onUserTakeControl: releaseShot,
  onTap(clientX, clientY) {
    if (phase === "journey") return;

    const location = locationAt(globe, clientX, clientY);
    if (!location) return; // tapped empty space, not the planet

    if (!coveredAt(location)) {
      panel.setFeedback("sorry! no connection here — try somewhere more populated.");
      return;
    }

    const kind = phase === "choose-origin" ? "origin" : "server";
    const nearest = nearestCityWithKind(location, kind);
    if (!nearest) return;

    // Snapping is honest rather than silent: the route graph models a few dozen
    // places, so say when the chosen point was attached to one further away.
    panel.setFeedback(
      nearest.distanceKm > 400
        ? `Nearest modelled network entry: ${nearest.city.name} (${Math.round(nearest.distanceKm)} km away).`
        : null,
    );

    controls.focusOn(nearest.city);
    if (phase === "choose-origin") setOrigin(nearest.city.id);
    else setDestination(nearest.city.id);
  },
});

canvas.addEventListener("pointermove", (event) => hover.track(event.clientX, event.clientY));
canvas.addEventListener("pointerleave", () => hover.clear());

window.addEventListener("resize", reframe);
new ResizeObserver(reframe).observe(focusAnchor);
reframe();
applyPhase("choose-origin");

// --- the journey ----------------------------------------------------------

/**
 * The camera beat for a stage.
 *
 * The uplink is the one shot that has to be composed rather than merely
 * pointed: seen from directly above, a climb to orbit is a dot getting
 * brighter, so the camera moves beside the launch point with the radial
 * direction running up the screen and the climb reads as vertical travel.
 */
function playBeat(current: Route, stageIndex: number): void {
  const hops = route.hopPositions();
  if (hops.length === 0) return;

  const index = Math.max(0, Math.min(current.steps.length - 1, stageIndex - 1));
  const step = current.steps[index];
  const isFinal = index >= current.steps.length - 1;

  // Slow the constellation to real time while the request is up there. At 10x
  // a relay hop is over before it can be followed.
  const inSpace = step.kind === "satellite" || step.infra === "satellite-uplink" || step.infra === "ground-link";
  starlink?.setTimeScale(inSpace ? 0.1 : 1);

  // Relay legs need the other satellites back on screen — they are what the
  // signal is hopping between.
  starlink?.setIsolated(state.starlinkOn && step.infra !== "satellite-link");

  let pose: Pose;
  if (isFinal) {
    pose = overviewPose(hops);
  } else if (step.infra === "satellite-uplink") {
    pose = uplinkPose(hops[Math.max(0, index - 1)]);
  } else if (step.infra === "satellite-link") {
    pose = relayPose(hops[Math.max(0, index - 1)], hops[index]);
  } else {
    pose = nodePose(hops[index]);
  }

  playShot(pose, isFinal ? 2400 : 1700);
}

// --- the reply ------------------------------------------------------------

type ReplyState = "idle" | "waiting" | "running" | "done";

let replyState: ReplyState = "idle";
let replyTimerMs = 0;
let replyProgress = 0;

function resetReply(): void {
  replyState = "idle";
  replyTimerMs = 0;
  replyProgress = 0;
  route.setReturnProgress(null);
}

function updateReply(dtMs: number): void {
  if (replyState === "waiting") {
    replyTimerMs -= dtMs;
    if (replyTimerMs <= 0) {
      replyState = "running";
      replyProgress = 0;
      prompt.show("And the reply comes back.", "The response retraces the path in blue.");
    }
    return;
  }
  if (replyState !== "running") return;

  replyProgress = Math.min(1, replyProgress + dtMs / 4200);
  route.setReturnProgress(replyProgress);
  if (replyProgress >= 1) replyState = "done";
}

// --- state ----------------------------------------------------------------

let lastRoute: Route | null = null;
let lastStage = -1;
let lastFocusId: string | null = null;

subscribe((s) => {
  if (s.route !== lastRoute) {
    lastRoute = s.route;
    lastStage = -1;
    route.setRoute(s.route);
    resetReply();
  }

  route.setStage(s.stageIndex);
  network.setLayers(s.layers);

  const origin = s.originId ? (CITY_BY_ID.get(s.originId) ?? null) : null;
  starlink?.setVisible(s.starlinkOn);
  starlink?.setOrigin(origin);

  /*
   * Swing the globe to whatever was just chosen, however it was chosen. Tapping
   * the globe used to be the only path that did this, so picking Sydney from the
   * From menu left the camera over the Americas with Sydney's satellites arcing
   * in from behind the planet -- the selection was invisible at the moment it
   * mattered most.
   *
   * Only while choosing: once both ends are set the camera director owns the
   * camera, and a focus call here would fight it.
   */
  if (s.originId && s.originId !== lastFocusId && phaseFor(s.originId, s.destId) !== "journey") {
    const city = CITY_BY_ID.get(s.originId);
    if (city) controls.focusOn(city);
  }
  lastFocusId = s.originId;

  const nextPhase = phaseFor(s.originId, s.destId);
  if (nextPhase !== phase) {
    applyPhase(nextPhase);
    // Choosing an origin is what collapses the constellation to the satellites
    // that can actually serve it.
    if (nextPhase !== "choose-origin") starlink?.setIsolated(s.starlinkOn);
    if (nextPhase === "journey") releaseShot();
  }

  if (s.route && s.stageIndex !== lastStage) {
    lastStage = s.stageIndex;
    playBeat(s.route, s.stageIndex);

    const atEnd = s.stageIndex >= s.route.steps.length;
    if (atEnd && replyState === "idle") {
      replyState = "waiting";
      replyTimerMs = 1400;
    } else if (!atEnd && replyState !== "idle") {
      resetReply();
    }
  }
});

// --- data -----------------------------------------------------------------

// The blanket disclaimer lives in the markup so it is on screen from the first
// paint; these are the per-dataset attributions, appended as each source loads.
const notes: string[] = [];

function publishNotes(): void {
  dataNote.textContent = notes.join(" ");
}
publishNotes();

const anisotropy = globe.renderer.capabilities.getMaxAnisotropy();

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
  .then((cities) => {
    citiesForCoverage = cities;
    earth.setCities(cities);
    hover.setPredicate(coveredAt);
  })
  .catch(() => undefined);

loadCoverage()
  .then((loaded) => {
    coverage = loaded;
    hover.setPredicate(coveredAt);
  })
  .catch(() => {
    notes.push("Coverage data failed to load — falling back to a coarser model.");
    publishNotes();
  });

// Real cable geography, and the attribution its licence requires.
loadCables()
  .then((collection) => {
    network.setCables(collection.features.flatMap((feature) => cableSegments(feature)));
    return loadCableMeta();
  })
  .then((meta) => {
    // The licence text in the metadata is a paragraph; the credit it requires
    // is a line. Keep the attribution, not the legalese.
    notes.push(
      `Submarine cables: ${meta.cableCount} systems, © TeleGeography (CC BY-SA 4.0) — ` +
        `routes are stylised, not surveyed seabed paths.`,
    );
    publishNotes();
  })
  .catch(() => undefined);

loadStarlinkGateways()
  .then((gateways) => {
    network.setGateways(gateways);
    notes.push(`Ground stations: ${gateways.length} reported Starlink gateway sites.`);
    publishNotes();
  })
  .catch(() => undefined);

loadStarlink()
  .then(({ meta, satellites }) => {
    starlink = createStarlinkField(satellites);
    globe.scene.add(starlink.points, starlink.tracks);
    starlink.setVisible(state.starlinkOn);
    starlink.setPixelRatio(globe.renderer.getPixelRatio());
    if (state.originId) {
      starlink.setOrigin(CITY_BY_ID.get(state.originId) ?? null);
      starlink.setIsolated(state.starlinkOn);
    }

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

  director.update(dtMs);
  controls.update(dtMs);
  sky.update(dtMs);
  earth.update(dtMs);
  route.update(dtMs);
  hover.update(dtMs);
  starlink?.update(dtMs);
  updateReply(dtMs);
  globe.render();
  globe.notifyFrame(elapsed);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
