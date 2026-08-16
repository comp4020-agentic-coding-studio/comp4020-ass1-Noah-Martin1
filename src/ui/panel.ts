import { citiesWithKind } from "../data/geo";
import {
  randomizeRoute,
  resetRoute,
  setAutoRotate,
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

/*
 * Ground stations moved into the Starlink mode box (they're only meaningful
 * alongside Starlink), so this fieldset now covers the three layers that
 * apply regardless of mode.
 */
const LAYER_LABELS: Record<Exclude<keyof LayerVisibility, "groundStations">, string> = {
  fibre: "Fibre cables",
  towers: "Cell towers",
  servers: "Servers",
};

/*
 * On a 390px screen the full labels wrap onto a second row, and that row is
 * taken straight out of the globe's height. The short forms keep them all
 * togglable in one row; the full label stays as the accessible name so
 * nothing is lost to a screen reader.
 */
const LAYER_SHORT: Record<Exclude<keyof LayerVisibility, "groundStations">, string> = {
  fibre: "Fibre",
  towers: "Towers",
  servers: "Servers",
};

export interface ControlPanel {
  el: HTMLElement;
  setFeedback(message: string | null): void;
}

/** The Starlink/Ground-station switches share one look; built once, used twice. */
function buildSwitch(
  id: string,
  labelText: string,
  onChange: (checked: boolean) => void,
): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = document.createElement("label");
  wrap.className = "switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.addEventListener("change", () => onChange(input.checked));
  const track = document.createElement("span");
  track.className = "switch-track";
  track.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "switch-label";
  text.textContent = labelText;
  wrap.append(input, track, text);
  return { wrap, input };
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
    const city = ORIGIN_OPTIONS.find((c) => c.id === originSelect.value);
    if (city) {
      setOrigin({ lat: city.lat, lon: city.lon, label: `${city.name}, ${city.country}`, cityId: city.id });
    }
  });
  destSelect.addEventListener("change", () => {
    const city = DEST_OPTIONS.find((c) => c.id === destSelect.value);
    if (city) {
      setDestination({ lat: city.lat, lon: city.lon, label: `${city.name}, ${city.country}`, cityId: city.id });
    }
  });

  const row = document.createElement("div");
  row.className = "panel-row";
  row.append(originWrap, destWrap);

  // The tap-the-globe flow (driven by the on-globe prompt) is the primary way
  // to choose a route; these menus stay for keyboard/screen-reader use and for
  // anyone who'd rather type, but sit behind a disclosure so they don't compete
  // with the prompt for attention.
  const picker = document.createElement("details");
  picker.className = "picker-fallback";
  const pickerSummary = document.createElement("summary");
  pickerSummary.textContent = "Prefer to pick from a list?";
  picker.append(pickerSummary, row);

  const { wrap: starlinkWrap, input: starlinkInput } = buildSwitch("starlink-toggle", "Use Starlink?", setStarlink);
  const { wrap: groundWrap, input: groundInput } = buildSwitch("ground-toggle", "Show ground stations", (checked) =>
    setLayer("groundStations", checked),
  );

  const modeBox = document.createElement("fieldset");
  modeBox.className = "mode-box";
  const modeLegend = document.createElement("legend");
  modeLegend.textContent = "Connectivity";
  modeBox.append(modeLegend, starlinkWrap, groundWrap);

  const randomButton = document.createElement("button");
  randomButton.type = "button";
  randomButton.className = "random-button";
  randomButton.textContent = "Random route";
  randomButton.addEventListener("click", () => randomizeRoute());

  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "reset-button";
  resetButton.textContent = "New request";
  resetButton.title = "Stop and start a new request";
  resetButton.addEventListener("click", () => resetRoute());

  const buttonsRow = document.createElement("div");
  buttonsRow.className = "panel-buttons";
  buttonsRow.append(randomButton, resetButton);

  const actionsRow = document.createElement("div");
  actionsRow.className = "panel-row panel-row-actions";
  actionsRow.append(modeBox, buttonsRow);

  /*
   * Not in the mode box: that box is the Starlink grouping, and holding the
   * globe still has nothing to do with which network the route uses. It is a
   * property of the view, so it gets its own small box in the same shape.
   */
  const { wrap: rotateWrap, input: rotateInput } = buildSwitch("rotate-toggle", "Rotate globe", setAutoRotate);
  const viewBox = document.createElement("fieldset");
  viewBox.className = "mode-box view-box";
  const viewLegend = document.createElement("legend");
  viewLegend.textContent = "View";
  viewBox.append(viewLegend, rotateWrap);

  const layersFieldset = document.createElement("fieldset");
  layersFieldset.className = "layers";
  const legend = document.createElement("legend");
  legend.textContent = "Highlight infrastructure";
  layersFieldset.append(legend);

  const layerInputs: Partial<Record<Exclude<keyof LayerVisibility, "groundStations">, HTMLInputElement>> = {};
  for (const key of Object.keys(LAYER_LABELS) as Exclude<keyof LayerVisibility, "groundStations">[]) {
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

  el.append(picker, actionsRow, viewBox, layersFieldset, feedback);

  function setFeedback(message: string | null): void {
    feedback.textContent = message ?? "";
    feedback.classList.toggle("feedback-visible", Boolean(message));
  }

  function sync(s: typeof state): void {
    // A point picked off the globe has no city id, so the menu shows nothing
    // selected — which is honest: the origin genuinely isn't one of its options.
    const originValue = s.origin?.cityId ?? "";
    if (originSelect.value !== originValue) originSelect.value = originValue;
    const destValue = s.destination?.cityId ?? "";
    if (destSelect.value !== destValue) destSelect.value = destValue;
    starlinkInput.checked = s.starlinkOn;
    rotateInput.checked = s.autoRotate;
    groundInput.checked = s.layers.groundStations;
    for (const key of Object.keys(LAYER_LABELS) as Exclude<keyof LayerVisibility, "groundStations">[]) {
      const input = layerInputs[key];
      if (input) input.checked = s.layers[key];
    }
  }

  subscribe(sync);

  // Initial sync: subscribe() only fires on change, so the controls have to be
  // seeded from the starting state or the Starlink switch would read "off"
  // while the constellation is on screen.
  sync(state);

  return { el, setFeedback };
}
