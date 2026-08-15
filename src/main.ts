import { CITY_BY_ID } from "./data/geo";
import { attachGlobeControls } from "./globe/controls";
import { buildInfrastructureLayer } from "./globe/infrastructure";
import { pickCityAt } from "./globe/picking";
import { createGlobeScene } from "./globe/scene";
import { buildSatelliteField } from "./globe/satellites";
import { createControlPanel } from "./ui/panel";
import { createStoryPanel } from "./scroll/story";
import { setDestination, setOrigin, state, subscribe } from "./state";
import type { Route } from "./data/types";

const stage = document.getElementById("globe-stage");
const panelHost = document.getElementById("control-panel-host");
const storyHost = document.getElementById("story-host");

if (!(stage instanceof HTMLElement) || !panelHost || !storyHost) {
  throw new Error("Expected #globe-stage, #control-panel-host and #story-host in index.html");
}

const panel = createControlPanel();
panelHost.append(panel.el);

const story = createStoryPanel();
storyHost.append(story.el);

const globe = createGlobeScene(stage);
const infrastructure = buildInfrastructureLayer(globe.sphereRadius);
globe.globeGroup.add(infrastructure.group);

const satellites = buildSatelliteField(globe.sphereRadius);
globe.scene.add(satellites.points);

let pickPhase: "origin" | "destination" = "origin";

const controls = attachGlobeControls(globe, {
  onTap(clientX, clientY) {
    const { city } = pickCityAt(globe, clientX, clientY);
    if (!city) {
      panel.setFeedback("No network coverage there — try tapping a populated area.");
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

let lastRoute: Route | null = null;
subscribe((s) => {
  if (s.route !== lastRoute) {
    lastRoute = s.route;
    infrastructure.setRoute(s.route);
  }
  infrastructure.setStageAndLayers(s.stageIndex, s.layers);
});

let lastTime = performance.now();
function frame(now: number): void {
  const dtMs = Math.min(64, now - lastTime);
  lastTime = now;

  controls.update(dtMs);
  const origin = state.originId ? (CITY_BY_ID.get(state.originId) ?? null) : null;
  satellites.update(dtMs, origin, state.starlinkOn);
  infrastructure.update(dtMs);
  globe.render();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
