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
 * Where the request actually starts: any point the user picked, not a city id.
 * The whole 5G story depends on this being the real spot — "White Cliffs" has
 * to stay White Cliffs rather than becoming Sydney because Sydney is the
 * nearest place the route graph happens to model.
 */
export interface RouteOrigin extends LatLon {
  /** Human-readable place, already resolved for display. */
  label: string;
  /** Set only when the user picked a modelled city rather than a bare point. */
  cityId: string | null;
}

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
}

export interface Route {
  steps: RouteStep[];
  usesStarlink: boolean;
  crossesOcean: boolean;
  /** Backbone edges this route travels along, for highlighting the matching fibre arcs. */
  backboneEdges: HubEdge[];
}
