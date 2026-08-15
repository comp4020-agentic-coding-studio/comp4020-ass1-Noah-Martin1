import { haversineKm, midpointLatLon } from "../globe/geometry";
import { CITIES, CITY_BY_ID, GROUND_STATIONS, HUB_EDGES } from "./geo";
import type {
  City,
  HubEdge,
  LatLon,
  Route,
  RouteDestination,
  RouteOrigin,
  RouteStep,
  TowerHop,
} from "./types";

const HUB_IDS = CITIES.filter((c) => c.kinds.includes("hub")).map((c) => c.id);

function buildAdjacency(): Map<string, { to: string; edge: HubEdge; weight: number }[]> {
  const adjacency = new Map<string, { to: string; edge: HubEdge; weight: number }[]>();
  for (const id of HUB_IDS) adjacency.set(id, []);
  for (const edge of HUB_EDGES) {
    const a = CITY_BY_ID.get(edge.a)!;
    const b = CITY_BY_ID.get(edge.b)!;
    const weight = haversineKm(a, b);
    adjacency.get(edge.a)!.push({ to: edge.b, edge, weight });
    adjacency.get(edge.b)!.push({ to: edge.a, edge, weight });
  }
  return adjacency;
}

const ADJACENCY = buildAdjacency();

/** Dijkstra's shortest path over the simplified backbone hub graph. */
function shortestHubPath(fromHub: string, toHub: string): { hubIds: string[]; edges: HubEdge[] } {
  if (fromHub === toHub) return { hubIds: [fromHub], edges: [] };

  const dist = new Map<string, number>([[fromHub, 0]]);
  const prev = new Map<string, { hub: string; edge: HubEdge }>();
  const visited = new Set<string>();
  const queue = new Set(HUB_IDS);

  while (queue.size > 0) {
    let current: string | null = null;
    let currentDist = Infinity;
    for (const id of queue) {
      const d = dist.get(id) ?? Infinity;
      if (d < currentDist) {
        currentDist = d;
        current = id;
      }
    }
    if (current === null) break;
    queue.delete(current);
    visited.add(current);
    if (current === toHub) break;

    for (const { to, edge, weight } of ADJACENCY.get(current) ?? []) {
      if (visited.has(to)) continue;
      const candidate = currentDist + weight;
      if (candidate < (dist.get(to) ?? Infinity)) {
        dist.set(to, candidate);
        prev.set(to, { hub: current, edge });
      }
    }
  }

  const hubIds: string[] = [toHub];
  const edges: HubEdge[] = [];
  let cursor = toHub;
  while (cursor !== fromHub) {
    const step = prev.get(cursor);
    if (!step) break; // unreachable -- graph is connected in practice, but stay safe
    edges.unshift(step.edge);
    hubIds.unshift(step.hub);
    cursor = step.hub;
  }
  return { hubIds, edges };
}

function nearestHub(at: LatLon): City {
  let best = CITY_BY_ID.get(HUB_IDS[0])!;
  let bestDist = Infinity;
  for (const id of HUB_IDS) {
    const hub = CITY_BY_ID.get(id)!;
    const d = haversineKm(at, hub);
    if (d < bestDist) {
      bestDist = d;
      best = hub;
    }
  }
  return best;
}

function nearestGroundStation(at: LatLon) {
  let best = GROUND_STATIONS[0];
  let bestDist = Infinity;
  for (const gs of GROUND_STATIONS) {
    const d = haversineKm(at, gs);
    if (d < bestDist) {
      bestDist = d;
      best = gs;
    }
  }
  return best;
}

let stepCounter = 0;
function step(partial: Omit<RouteStep, "id">): RouteStep {
  stepCounter += 1;
  return { ...partial, id: `step-${stepCounter}` };
}

function deviceStep(origin: RouteOrigin): RouteStep {
  return step({
    kind: "device",
    refId: origin.cityId ?? "origin",
    location: origin,
    infra: null,
    title: `Your device — ${origin.label}`,
    explanation: `The request begins on your device at ${origin.label}. Before it can go anywhere, your device packages the request into small units called packets, each addressed with an IP address.`,
    fact: "Every device on the internet is identified by an IP address, so replies know where to come back to.",
    visual: "pulse",
  });
}

/**
 * The wireless hop. This is the step the whole "you are here, not in the
 * nearest city" point rests on, so it names the actual distance to the tower
 * rather than glossing it — 7 km outside White Cliffs and 1 km in Sydney are
 * different stories about the same infrastructure.
 */
function towerStep(tower: TowerHop, origin: RouteOrigin): RouteStep {
  const distance = tower.distanceKm < 1 ? "under a kilometre" : `about ${Math.round(tower.distanceKm)} km`;
  return step({
    kind: "tower",
    refId: "tower",
    location: tower,
    infra: "wireless",
    title: "Wireless connection",
    explanation: `There is no fibre running to ${origin.label} itself. The request travels over radio to the nearest mast, ${distance} away, which is where the wired network actually begins.`,
    fact: "5G carries data over radio waves for the first hop only — once it reaches the tower, it continues over wired fibre.",
    visual: "radio",
  });
}

/** The first wired hop after the mast: the operator's nearest core network. */
function coreStep(hub: City, tower: TowerHop): RouteStep {
  return step({
    kind: "hub",
    refId: hub.id,
    location: hub,
    infra: "fibre-terrestrial",
    title: `Network core — ${hub.name}`,
    explanation: `From the mast the request runs down fibre-optic cable to ${hub.name}, roughly ${Math.round(haversineKm(tower, hub))} km away — the nearest place where the operator's network joins the wider internet.`,
    fact: "A mast is only an antenna. Every tower is wired back to a core network, so almost all of a “wireless” journey actually happens through cable.",
    visual: "pulse",
  });
}

function hubStep(hub: City): RouteStep {
  return step({
    kind: "hub",
    refId: hub.id,
    location: hub,
    infra: "fibre-terrestrial",
    title: `Network hub — ${hub.name}`,
    explanation: `The request arrives at ${hub.name}, a major internet exchange point where many networks interconnect and hand traffic off to one another.`,
    fact: "Internet exchange points let separate networks (autonomous systems) swap traffic directly, instead of routing it through a third party.",
    visual: "pulse",
  });
}

function undersea(fromName: string, toName: string, city: City): RouteStep {
  return step({
    kind: "hub",
    refId: `${city.id}-undersea`,
    location: city,
    infra: "fibre-submarine",
    title: "Undersea cable",
    explanation: `Between ${fromName} and ${toName}, the request crosses an ocean through a submarine fibre-optic cable lying on the seabed.`,
    fact: "A single submarine cable, thinner than a garden hose, can carry many terabits of traffic per second using light.",
    visual: "arc",
  });
}

function serverStep(destination: RouteDestination): RouteStep {
  return step({
    kind: "server",
    refId: destination.cityId ?? "destination",
    location: destination,
    infra: "fibre-terrestrial",
    title: `Server — ${destination.label}`,
    explanation: `The request reaches a server in ${destination.label}, which processes it and prepares a response to send back.`,
    fact: "Popular services run in data centres in many regions at once, so requests are often answered from whichever is geographically closest.",
    visual: "glow",
  });
}

function satelliteUplinkStep(origin: RouteOrigin): RouteStep {
  return step({
    kind: "satellite",
    refId: "uplink",
    location: origin,
    infra: "satellite-uplink",
    title: "Uplink to satellite",
    explanation: `Instead of a tower, the request is beamed straight up to a Starlink satellite passing overhead.`,
    fact: "Starlink satellites orbit only a few hundred kilometres up (low Earth orbit), which keeps the round-trip delay much lower than older geostationary satellite internet.",
    visual: "orbit",
  });
}

function satelliteRelayStep(originId: string, location: LatLon, index: number): RouteStep {
  return step({
    kind: "satellite",
    refId: `${originId}-relay-${index}`,
    location,
    infra: "satellite-link",
    title: `Inter-satellite link ${index}`,
    explanation: "The signal is relayed between satellites using laser links before it comes back down to Earth.",
    fact: "Newer Starlink satellites talk to each other directly with lasers, so a request can hop between satellites without touching the ground.",
    visual: "orbit",
  });
}

function groundStationStep(gs: { id: string; name: string; lat: number; lon: number }): RouteStep {
  return step({
    kind: "ground-station",
    refId: gs.id,
    location: { lat: gs.lat, lon: gs.lon },
    infra: "ground-link",
    title: `Starlink ground station — ${gs.name}`,
    explanation: "The satellite sends the request down to a ground station, which is wired directly into the terrestrial internet.",
    fact: "Ground stations are the bridge between the satellite network and the regular fibre-optic internet.",
    visual: "pulse",
  });
}

function withHubPath(steps: RouteStep[], hubIds: string[], edges: HubEdge[], skipFirst = false): void {
  for (let i = 0; i < hubIds.length; i++) {
    const hub = CITY_BY_ID.get(hubIds[i])!;
    if (i === 0) {
      if (!skipFirst) steps.push(hubStep(hub));
      continue;
    }
    const edge = edges[i - 1];
    const prevHub = CITY_BY_ID.get(hubIds[i - 1])!;
    if (edge.kind === "submarine") {
      steps.push(undersea(prevHub.name, hub.name, hub));
    }
    steps.push(hubStep(hub));
  }
}

export function buildTerrestrialRoute(
  origin: RouteOrigin,
  destination: RouteDestination,
  tower: TowerHop | null,
): Route {
  const steps: RouteStep[] = [deviceStep(origin)];

  /*
   * The wireless hop is skipped only when the request already starts inside a
   * modelled backbone hub — picking "London" from the menu should not claim a
   * mast between your device and the exchange. Every other point on Earth gets
   * the radio hop, including points inside cities, because that is how a phone
   * actually reaches the network.
   */
  const startsAtHub = origin.cityId !== null && (CITY_BY_ID.get(origin.cityId)?.kinds.includes("hub") ?? false);
  const originHub = startsAtHub ? CITY_BY_ID.get(origin.cityId!)! : nearestHub(origin);

  if (!startsAtHub && tower) {
    steps.push(towerStep(tower, origin));
    steps.push(coreStep(originHub, tower));
  }

  const { hubIds, edges } = shortestHubPath(originHub.id, nearestHub(destination).id);
  // The core step already introduced this hub, so don't announce it twice.
  withHubPath(steps, hubIds, edges, !startsAtHub && tower !== null);

  steps.push(serverStep(destination));

  return { steps, usesStarlink: false, crossesOcean: edges.some((e) => e.kind === "submarine"), backboneEdges: edges };
}

export function buildStarlinkRoute(origin: RouteOrigin, destination: RouteDestination): Route {
  const gs = nearestGroundStation(origin);
  const steps: RouteStep[] = [
    deviceStep(origin),
    satelliteUplinkStep(origin),
    satelliteRelayStep(origin.cityId ?? "origin", midpointLatLon(origin, gs), 1),
    groundStationStep(gs),
  ];

  const { hubIds, edges } = shortestHubPath(gs.nearestHub, nearestHub(destination).id);
  withHubPath(steps, hubIds, edges);
  steps.push(serverStep(destination));

  return { steps, usesStarlink: true, crossesOcean: edges.some((e) => e.kind === "submarine"), backboneEdges: edges };
}

export function buildRoute(
  origin: RouteOrigin,
  destination: RouteDestination,
  starlink: boolean,
  tower: TowerHop | null,
): Route {
  return starlink
    ? buildStarlinkRoute(origin, destination)
    : buildTerrestrialRoute(origin, destination, tower);
}

const RANDOMIZABLE_ORIGINS = CITIES.filter((c) => c.kinds.includes("origin"));
const RANDOMIZABLE_SERVERS = CITIES.filter((c) => c.kinds.includes("server"));

export function pickRandomPair(): { origin: RouteOrigin; destination: RouteDestination } {
  const origin = RANDOMIZABLE_ORIGINS[Math.floor(Math.random() * RANDOMIZABLE_ORIGINS.length)];
  let dest = RANDOMIZABLE_SERVERS[Math.floor(Math.random() * RANDOMIZABLE_SERVERS.length)];
  let guard = 0;
  while (dest.id === origin.id && guard < 10) {
    dest = RANDOMIZABLE_SERVERS[Math.floor(Math.random() * RANDOMIZABLE_SERVERS.length)];
    guard += 1;
  }
  return {
    origin: { lat: origin.lat, lon: origin.lon, label: `${origin.name}, ${origin.country}`, cityId: origin.id },
    destination: { lat: dest.lat, lon: dest.lon, label: `${dest.name}, ${dest.country}`, cityId: dest.id },
  };
}
