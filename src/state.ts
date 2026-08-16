import { buildRoute, pickRandomPair } from "./data/routes";
import type { LatLon, Route, RouteDestination, RouteOrigin, TowerHop } from "./data/types";

export interface LayerVisibility {
  fibre: boolean;
  towers: boolean;
  groundStations: boolean;
  servers: boolean;
}

export interface AppState {
  /** The exact point the request starts from — not snapped to a modelled city. */
  origin: RouteOrigin | null;
  /** The data centre the request is heading for, as chosen. */
  destination: RouteDestination | null;
  starlinkOn: boolean;
  route: Route | null;
  stageIndex: number;
  layers: LayerVisibility;
}

type Listener = (state: AppState) => void;

const listeners = new Set<Listener>();

export const state: AppState = {
  origin: null,
  destination: null,
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

/**
 * Supplied by main.ts once the tower dataset has loaded. Kept as an injected
 * lookup rather than an import so route building stays a pure function of its
 * inputs, and so a route can still be built (minus the radio hop) before 2 MB
 * of tower positions has come down the wire.
 */
let towerLookup: ((at: LatLon) => TowerHop | null) | null = null;

export function setTowerLookup(lookup: (at: LatLon) => TowerHop | null): void {
  towerLookup = lookup;
  // Anything already on screen was built without a mast; rebuild it with one.
  if (state.origin && state.destination) {
    recomputeRoute();
    notify();
  }
}

function recomputeRoute(): void {
  state.stageIndex = 0;
  if (state.origin && state.destination) {
    const tower = towerLookup ? towerLookup(state.origin) : null;
    state.route = buildRoute(state.origin, state.destination, state.starlinkOn, tower);
  } else {
    state.route = null;
  }
}

export function setOrigin(origin: RouteOrigin): void {
  state.origin = origin;
  recomputeRoute();
  notify();
}

export function setDestination(destination: RouteDestination): void {
  state.destination = destination;
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
  const { origin, destination } = pickRandomPair();
  state.origin = origin;
  state.destination = destination;
  recomputeRoute();
  notify();
}

/** Clears the current selection so the user can start choosing a route again. */
export function resetRoute(): void {
  state.origin = null;
  state.destination = null;
  recomputeRoute();
  notify();
}
