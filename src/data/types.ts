export interface LatLon {
  lat: number;
  lon: number;
}

export type CityKind = "origin" | "hub" | "server" | "ground-station";

export interface City extends LatLon {
  id: string;
  name: string;
  country: string;
  /** What roles this place can play when building a route. A place can hold several. */
  kinds: readonly CityKind[];
}

export type CableKind = "terrestrial" | "submarine";

export interface HubEdge {
  a: string;
  b: string;
  kind: CableKind;
}

/** A ground station's simplified onward link into the terrestrial backbone. */
export interface GroundStation extends LatLon {
  id: string;
  name: string;
  country: string;
  /** id of the nearest backbone hub this station hands traffic off to. */
  nearestHub: string;
}

/**
 * An end of the journey: a real point the user picked, not a city id.
 *
 * Both ends work this way. The origin has to be the actual spot or the 5G story
 * collapses — "White Cliffs" must stay White Cliffs rather than becoming Sydney
 * because Sydney is the nearest place the route graph happens to model — and
 * the destination has to be the data centre the user chose, for the same
 * reason: it is where the traceroute ends.
 */
export interface RoutePlace extends LatLon {
  /** Human-readable place, already resolved for display. */
  label: string;
  /** Set only when the user picked a modelled city rather than a bare point. */
  cityId: string | null;
}

export type RouteOrigin = RoutePlace;
export type RouteDestination = RoutePlace;

/** The mast serving a chosen point, and how far away it really is. */
export interface TowerHop extends LatLon {
  towers: number;
  distanceKm: number;
}

export type NodeKind = "device" | "tower" | "hub" | "satellite" | "ground-station" | "server";

export type InfraKind =
  | "wireless"
  | "fibre-terrestrial"
  | "fibre-submarine"
  | "satellite-uplink"
  | "satellite-link"
  | "ground-link";

export type VisualBehaviour = "pulse" | "radio" | "arc" | "orbit" | "glow";

/**
 * One stop along a visualised request. `infra` describes the link travelled
 * to reach this node from the previous one (null for the first node).
 */
export interface RouteStep {
  id: string;
  kind: NodeKind;
  /** id of the underlying city/hub/ground-station this step represents, for matching against infrastructure markers. */
  refId: string;
  location: LatLon;
  infra: InfraKind | null;
  title: string;
  explanation: string;
  fact: string;
  visual: VisualBehaviour;
  /**
   * Approximate one-way delay for the leg arriving at this step, in whole ms.
   * An estimate from distance and typical equipment behaviour — see
   * ./latency.ts. Zero on the first step, which is where the request begins.
   */
  latencyMs: number;
  /** Approximate cumulative one-way delay from the device to here, in ms. */
  elapsedMs: number;
}

export interface Route {
  steps: RouteStep[];
  usesStarlink: boolean;
  crossesOcean: boolean;
  /** Backbone edges this route travels along, for highlighting the matching fibre arcs. */
  backboneEdges: HubEdge[];
  /** Approximate one-way total delay, in ms. Doubling it approximates a ping. */
  totalLatencyMs: number;
}
