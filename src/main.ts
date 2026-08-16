import { createCablePathIndex } from "./data/cable-paths";
import { cableSegments, loadCableMeta, loadCables } from "./data/generated/cables";
import { loadCoverage, loadStarlinkGateways, type Coverage } from "./data/generated/coverage";
import { loadDataCentres, type DataCentreIndex } from "./data/generated/datacentres";
import { loadCities, loadLand, loadStarlink, type PackedCity } from "./data/generated/datasets";
import { loadPlaces, loadTowers, type PlaceIndex } from "./data/generated/towers";
import type { LatLon, Route, RouteDestination, RouteOrigin } from "./data/types";
import { haversineKm } from "./globe/geometry";
import {
  createCameraDirector,
  groundLegPose,
  nodePose,
  overviewPose,
  relayPose,
  uplinkPose,
  type Pose,
} from "./globe2/camera-director";
import { createEarth } from "./globe2/earth";
import { createHoverCursor } from "./globe2/hover-cursor";
import { bakeLandTexture } from "./globe2/land-texture";
import { createNetworkLayer } from "./globe2/network";
import { attachOrbitControls } from "./globe2/orbit-controls";
import { createRadioWaves } from "./globe2/radio-waves";
import { locationAt } from "./globe2/picking";
import { createRouteLayer } from "./globe2/route";
import { createGlobeScene } from "./globe2/scene";
import { createSky } from "./globe2/sky";
import { createStarlinkField, type StarlinkField } from "./globe2/starlink-field";
import { reducedMotion } from "./reduced-motion";
import { createStoryPanel } from "./scroll/story";
import { setDestination, setOrigin, setTowerLookup, state, subscribe } from "./state";
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
const heroCta = required("hero-cta", HTMLButtonElement);

// The hero is the only element in normal document flow -- scrolling past its
// one-viewport height is what reveals the already-rendered fixed globe below.
heroCta.addEventListener("click", () => {
  window.scrollTo({ top: window.innerHeight, behavior: reducedMotion.value ? "auto" : "smooth" });
});

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
const radio = createRadioWaves();
const director = createCameraDirector(globe.camera);

globe.scene.add(sky.group, earth.group, network.group, route.group, hover.group, radio.group);

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

let places: PlaceIndex | null = null;
let dataCentres: DataCentreIndex | null = null;

/**
 * How far the destination cursor will reach to grab a data centre.
 *
 * Deliberately small. The brief asks for the cursor to snap, but a generous
 * radius turns the whole globe into one big button and the user loses the
 * ability to drag and spin without accidentally selecting something. 350 km is
 * roughly a marker's own visual footprint at the default zoom.
 */
const SNAP_KM = 350;

function snapToDataCentre(location: LatLon): RouteDestination | null {
  const found = dataCentres?.nearest(location, SNAP_KM);
  if (!found) return null;
  const { centre } = found;
  const where = places?.label(centre)?.text;
  // A mapped site without a name still needs to be nameable, so fall back to
  // where it is rather than showing an empty label.
  const label = centre.name || (where ? `Data centre near ${where}` : "Data centre");
  return { lat: centre.lat, lon: centre.lon, label, cityId: null };
}

/**
 * What to call a bare lat/lon. Natural Earth carries ~7,300 places, so a remote
 * point's nearest named town can be a hundred kilometres off; the label says so
 * rather than pretending the request starts in that town.
 */
function labelFor(location: LatLon): string {
  const label = places?.label(location);
  if (label) return label.text;
  const ns = location.lat >= 0 ? "N" : "S";
  const ew = location.lon >= 0 ? "E" : "W";
  return `${Math.abs(location.lat).toFixed(1)}°${ns}, ${Math.abs(location.lon).toFixed(1)}°${ew}`;
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

function phaseFor(origin: RouteOrigin | null, destination: RouteDestination | null): Phase {
  if (!origin) return "choose-origin";
  if (!destination) return "choose-destination";
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

  /*
   * Two different questions, so two different cursors. Choosing an origin asks
   * "is there service at this exact point?", and the ring follows the pointer
   * freely. Choosing a destination asks "which data centre?", so the ring snaps
   * to the nearest one and the field is forced bright regardless of the Servers
   * toggle — you cannot pick from a set you cannot see.
   */
  const pickingDestination = next === "choose-destination";
  network.setDataCentreEmphasis(pickingDestination);
  // Keep the committed origin on screen while the second end is being chosen.
  network.markOrigin(pickingDestination ? state.origin : null);
  hover.setSnap(pickingDestination ? (location) => dataCentres?.nearest(location, SNAP_KM)?.centre ?? null : null);
  hover.setPredicate(pickingDestination ? null : coveredAt);
  hover.setBlockedMessage(pickingDestination ? "no data centre here" : "sorry! no connection here");
  if (!pickingDestination) network.highlightDataCentre(null);

  if (next === "choose-origin") {
    const gesture = coarsePointer.matches ? "Press and drag over the globe" : "Hover the globe";
    prompt.show(
      "Where should the request start?",
      state.starlinkOn
        ? `${gesture} — green means Starlink serves that spot. Tap to choose.`
        : `${gesture} — green means there's mobile coverage. Tap to choose.`,
    );
  } else if (next === "choose-destination") {
    prompt.show(
      "Now pick where it's going.",
      "The cyan markers are real data centres — the cursor snaps to the nearest one. Tap to choose.",
    );
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

    if (phase === "choose-origin") {
      if (!coveredAt(location)) {
        panel.setFeedback("sorry! no connection here — try somewhere more populated.");
        return;
      }
      /*
       * The origin is the point that was tapped, full stop. It used to snap to
       * the nearest modelled city, which quietly moved a request from White
       * Cliffs to Sydney and threw away the whole reason the 5G leg exists.
       */
      panel.setFeedback(null);
      controls.focusOn(location);
      setOrigin({ ...location, label: labelFor(location), cityId: null });
      return;
    }

    /*
     * The destination is a different kind of choice: a request ends at a real
     * data centre, not at an arbitrary field. So this one snaps — but only
     * within SNAP_KM, so a tap on open ocean is a miss rather than a silent
     * jump to a facility on another continent.
     */
    const snapped = snapToDataCentre(location);
    if (!snapped) {
      panel.setFeedback("No data centre near there — the highlighted markers are the ones you can pick.");
      return;
    }
    panel.setFeedback(null);
    controls.focusOn(snapped);
    setDestination(snapped);
  },
});

canvas.addEventListener("pointermove", (event) => {
  hover.track(event.clientX, event.clientY);
  if (phase === "choose-destination") network.highlightDataCentre(hover.snapped);
});
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

  // The one hop that travels through the air gets rings spreading off the mast,
  // sized to the distance the radio actually covered.
  const reach = index > 0 ? hops[index - 1].distanceTo(hops[index]) : undefined;
  radio.showAt(step.visual === "radio" ? step.location : null, reach);

  let pose: Pose;
  if (isFinal) {
    pose = overviewPose(hops);
  } else if (step.infra === "satellite-uplink") {
    pose = uplinkPose(hops[Math.max(0, index - 1)]);
  } else if (step.infra === "satellite-link") {
    pose = relayPose(hops[Math.max(0, index - 1)], hops[index]);
  } else if (index === 0) {
    pose = nodePose(hops[index]);
  } else {
    /*
     * Terrestrial legs frame both ends, so the camera dives to the ground for
     * the few-kilometre hop to the mast and pulls back as the legs lengthen.
     * That is the "zoom into the first traceroute jumps" the flow asks for, and
     * it falls out of the geometry rather than being special-cased per stage.
     */
    pose = groundLegPose(hops[index - 1], hops[index]);
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
    radio.showAt(null);
    resetReply();
  }

  route.setStage(s.stageIndex);
  network.setLayers(s.layers);

  starlink?.setVisible(s.starlinkOn);
  starlink?.setOrigin(s.origin);

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
  const originKey = s.origin ? `${s.origin.lat},${s.origin.lon}` : null;
  if (s.origin && originKey !== lastFocusId && phaseFor(s.origin, s.destination) !== "journey") {
    controls.focusOn(s.origin);
  }
  lastFocusId = originKey;

  const nextPhase = phaseFor(s.origin, s.destination);
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
    /*
     * With the real network in hand, submarine legs can follow the cable that
     * actually carries them instead of a great circle. Undersea cables dogleg
     * around shelves and trenches; a straight arc through the middle of an
     * ocean is the one shape they never take.
     */
    const cablePaths = createCablePathIndex(collection);
    route.setLegPathProvider((from, to) => {
      if (to.infra !== "fibre-submarine") return null;
      return cablePaths.between(from.location, to.location);
    });
    // Anything already drawn was built on arcs; rebuild it on cables.
    route.setRoute(state.route);

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

loadPlaces()
  .then((index) => {
    places = index;
    hover.setLabeller((location) => index.label(location)?.text ?? null);
  })
  .catch(() => undefined);

loadDataCentres()
  .then((index) => {
    dataCentres = index;
    network.setDataCentres(index.centres);
    // If the user is already at the destination step, arm the magnet now.
    if (phase === "choose-destination") applyPhase(phase);

    const { meta } = index;
    notes.push(
      `Data centres: ${meta.count.toLocaleString("en-AU")} mapped sites, © OpenStreetMap contributors (ODbL) — ` +
        `coverage is uneven, so an unmarked region may be unmapped rather than empty.`,
    );
    publishNotes();
  })
  .catch(() => {
    notes.push("Data centre locations failed to load.");
    publishNotes();
  });

loadTowers()
  .then((index) => {
    network.setTowers(index.towers);

    // Route building can now include the radio hop. Any route already on
    // screen was built without one, so state rebuilds it.
    setTowerLookup((at) => {
      const found = index.nearest(at);
      return found ? { ...found.tower, distanceKm: found.distanceKm } : null;
    });

    const { meta } = index;
    notes.push(
      `Cell towers: ${meta.towerPoints.toLocaleString("en-AU")} markers standing for ` +
        `${meta.recordedTowersRepresented.toLocaleString("en-AU")} towers recorded by OpenCelliD ` +
        `(rasterised by the World Bank, CC BY 4.0) — one marker per 0.25° block, not one per mast.`,
    );
    publishNotes();
  })
  .catch(() => {
    notes.push("Cell tower data failed to load.");
    publishNotes();
  });

loadStarlink()
  .then(({ meta, satellites }) => {
    starlink = createStarlinkField(satellites);
    globe.scene.add(starlink.points, starlink.tracks);
    starlink.setVisible(state.starlinkOn);
    starlink.setPixelRatio(globe.renderer.getPixelRatio());
    if (state.origin) {
      starlink.setOrigin(state.origin);
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
  radio.update(dtMs);
  starlink?.update(dtMs);
  updateReply(dtMs);
  globe.render();
  globe.notifyFrame(elapsed);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
