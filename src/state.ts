import { buildRoute, pickRandomPair } from "./data/routes";
import type { Route } from "./data/types";

export interface LayerVisibility {
  fibre: boolean;
  towers: boolean;
  groundStations: boolean;
  servers: boolean;
}

export interface AppState {
  originId: string | null;
  destId: string | null;
  starlinkOn: boolean;
  route: Route | null;
  stageIndex: number;
  layers: LayerVisibility;
}

type Listener = (state: AppState) => void;

const listeners = new Set<Listener>();

export const state: AppState = {
  originId: null,
  destId: null,
  // The flow opens on Starlink: the constellation is the first thing the user
  // sees orbiting, and selection is gated on Starlink's coverage from the
  // outset. (This supersedes the earlier "Starlink off by default" default.)
  starlinkOn: true,
  route: null,
  stageIndex: 0,
  layers: { fibre: false, towers: false, groundStations: false, servers: false },
};

function notify(): void {
  for (const listener of listeners) listener(state);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function recomputeRoute(): void {
  state.stageIndex = 0;
  if (state.originId && state.destId) {
    state.route = buildRoute(state.originId, state.destId, state.starlinkOn);
  } else {
    state.route = null;
  }
}

export function setOrigin(id: string): void {
  state.originId = id;
  recomputeRoute();
  notify();
}

export function setDestination(id: string): void {
  state.destId = id;
  recomputeRoute();
  notify();
}

export function setStarlink(on: boolean): void {
  state.starlinkOn = on;
  recomputeRoute();
  notify();
}

export function setStageIndex(index: number): void {
  if (index === state.stageIndex) return;
  state.stageIndex = index;
  notify();
}

export function setLayer(layer: keyof LayerVisibility, on: boolean): void {
  state.layers[layer] = on;
  notify();
}

export function randomizeRoute(): void {
  const { originId, destId } = pickRandomPair();
  state.originId = originId;
  state.destId = destId;
  recomputeRoute();
  notify();
}
