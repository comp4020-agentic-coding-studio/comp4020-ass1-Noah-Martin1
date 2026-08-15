import { citiesWithKind } from "../data/geo";
import {
  randomizeRoute,
  setDestination,
  setLayer,
  setOrigin,
  setStarlink,
  state,
  subscribe,
  type LayerVisibility,
} from "../state";

const ORIGIN_OPTIONS = citiesWithKind("origin").slice().sort((a, b) => a.name.localeCompare(b.name));
const DEST_OPTIONS = citiesWithKind("server").slice().sort((a, b) => a.name.localeCompare(b.name));

const LAYER_LABELS: Record<keyof LayerVisibility, string> = {
  fibre: "Fibre cables",
  towers: "5G towers",
  groundStations: "Ground stations",
  servers: "Servers",
};

/*
 * On a 390px screen the four full labels wrap onto a second row, and that row
 * is taken straight out of the globe's height. The short forms keep all four
 * togglable in one row; the full label stays as the accessible name so nothing
 * is lost to a screen reader.
 */
const LAYER_SHORT: Record<keyof LayerVisibility, string> = {
  fibre: "Fibre",
  towers: "5G",
  groundStations: "Ground",
  servers: "Servers",
};

export interface ControlPanel {
  el: HTMLElement;
  setFeedback(message: string | null): void;
}

function citySelect(id: string, labelText: string): { wrap: HTMLElement; select: HTMLSelectElement } {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.className = "field-label";
  span.textContent = labelText;
  const select = document.createElement("select");
  select.id = id;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Tap the globe or choose …";
  select.append(placeholder);
  wrap.append(span, select);
  return { wrap, select };
}

export function createControlPanel(): ControlPanel {
  const el = document.createElement("div");
  el.className = "panel";
  el.setAttribute("aria-label", "Route controls");

  const { wrap: originWrap, select: originSelect } = citySelect("origin-select", "From");
  const { wrap: destWrap, select: destSelect } = citySelect("dest-select", "To");

  for (const city of ORIGIN_OPTIONS) {
    const option = document.createElement("option");
    option.value = city.id;
    option.textContent = `${city.name}, ${city.country}`;
    originSelect.append(option);
  }
  for (const city of DEST_OPTIONS) {
    const option = document.createElement("option");
    option.value = city.id;
    option.textContent = `${city.name}, ${city.country}`;
    destSelect.append(option);
  }

  originSelect.addEventListener("change", () => {
    if (originSelect.value) setOrigin(originSelect.value);
  });
  destSelect.addEventListener("change", () => {
    if (destSelect.value) setDestination(destSelect.value);
  });

  const row = document.createElement("div");
  row.className = "panel-row";
  row.append(originWrap, destWrap);

  const starlinkWrap = document.createElement("label");
  starlinkWrap.className = "switch";
  const starlinkInput = document.createElement("input");
  starlinkInput.type = "checkbox";
  starlinkInput.id = "starlink-toggle";
  starlinkInput.addEventListener("change", () => setStarlink(starlinkInput.checked));
  const starlinkTrack = document.createElement("span");
  starlinkTrack.className = "switch-track";
  starlinkTrack.setAttribute("aria-hidden", "true");
  const starlinkText = document.createElement("span");
  starlinkText.className = "switch-label";
  starlinkText.textContent = "Starlink";
  starlinkWrap.append(starlinkInput, starlinkTrack, starlinkText);

  const randomButton = document.createElement("button");
  randomButton.type = "button";
  randomButton.className = "random-button";
  randomButton.textContent = "Random route";
  randomButton.addEventListener("click", () => randomizeRoute());

  const actionsRow = document.createElement("div");
  actionsRow.className = "panel-row panel-row-actions";
  actionsRow.append(starlinkWrap, randomButton);

  const layersFieldset = document.createElement("fieldset");
  layersFieldset.className = "layers";
  const legend = document.createElement("legend");
  legend.textContent = "Highlight infrastructure";
  layersFieldset.append(legend);

  const layerInputs: Partial<Record<keyof LayerVisibility, HTMLInputElement>> = {};
  for (const key of Object.keys(LAYER_LABELS) as (keyof LayerVisibility)[]) {
    const label = document.createElement("label");
    label.className = "pill";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("aria-label", LAYER_LABELS[key]);
    input.addEventListener("change", () => setLayer(key, input.checked));
    layerInputs[key] = input;
    const full = document.createElement("span");
    full.className = "pill-full";
    full.textContent = LAYER_LABELS[key];
    const short = document.createElement("span");
    short.className = "pill-short";
    short.setAttribute("aria-hidden", "true");
    short.textContent = LAYER_SHORT[key];
    label.append(input, full, short);
    layersFieldset.append(label);
  }

  const feedback = document.createElement("p");
  feedback.className = "feedback";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");

  el.append(row, actionsRow, layersFieldset, feedback);

  function setFeedback(message: string | null): void {
    feedback.textContent = message ?? "";
    feedback.classList.toggle("feedback-visible", Boolean(message));
  }

  subscribe((s) => {
    if (originSelect.value !== (s.originId ?? "")) originSelect.value = s.originId ?? "";
    if (destSelect.value !== (s.destId ?? "")) destSelect.value = s.destId ?? "";
    starlinkInput.checked = s.starlinkOn;
    for (const key of Object.keys(LAYER_LABELS) as (keyof LayerVisibility)[]) {
      const input = layerInputs[key];
      if (input) input.checked = s.layers[key];
    }
  });

  // Initial sync: subscribe() only fires on change, so the controls have to be
  // seeded from the starting state or the Starlink switch would read "off"
  // while the constellation is on screen.
  originSelect.value = state.originId ?? "";
  destSelect.value = state.destId ?? "";
  starlinkInput.checked = state.starlinkOn;
  for (const key of Object.keys(LAYER_LABELS) as (keyof LayerVisibility)[]) {
    const input = layerInputs[key];
    if (input) input.checked = state.layers[key];
  }

  return { el, setFeedback };
}
