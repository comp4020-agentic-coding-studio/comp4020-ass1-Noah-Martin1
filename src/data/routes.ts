import { haversineKm, midpointLatLon } from "../globe/geometry";
import { CITIES, CITY_BY_ID, GROUND_STATIONS, HUB_EDGES } from "./geo";
import type { City, HubEdge, LatLon, Route, RouteStep } from "./types";

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

function nearestHub(city: City): City {
  if (city.kinds.includes("hub")) return city;
  let best = CITY_BY_ID.get(HUB_IDS[0])!;
  let bestDist = Infinity;
  for (const id of HUB_IDS) {
    const hub = CITY_BY_ID.get(id)!;
    const d = haversineKm(city, hub);
    if (d < bestDist) {
      bestDist = d;
      best = hub;
    }
  }
  return best;
}

function nearestGroundStation(city: City) {
  let best = GROUND_STATIONS[0];
  let bestDist = Infinity;
  for (const gs of GROUND_STATIONS) {
    const d = haversineKm(city, gs);
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

function deviceStep(city: City): RouteStep {
  return step({
    kind: "device",
    refId: city.id,
    location: city,
    infra: null,
    title: `Your device — ${city.name}`,
    explanation: `The request begins on your device in ${city.name}, ${city.country}. Before it can go anywhere, your device packages the request into small units called packets, each addressed with an IP address.`,
    fact: "Every device on the internet is identified by an IP address, so replies know where to come back to.",
    visual: "pulse",
  });
}

function towerStep(city: City): RouteStep {
  return step({
    kind: "tower",
    refId: city.id,
    location: city,
    infra: "wireless",
    title: "Wireless connection",
    explanation: `${city.name} isn't itself a major network hub, so the request first travels over radio to a nearby 5G tower.`,
    fact: "5G carries data over radio waves for the first hop only — once it reaches the tower, it continues over wired fibre.",
    visual: "radio",
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

function serverStep(city: City): RouteStep {
  return step({
    kind: "server",
    refId: city.id,
    location: city,
    infra: "fibre-terrestrial",
    title: `Server — ${city.name}`,
    explanation: `The request reaches a server in a data centre near ${city.name}, which processes it and prepares a response to send back.`,
    fact: "Popular services run in data centres in many regions at once, so requests are often answered from whichever is geographically closest.",
    visual: "glow",
  });
}

function satelliteUplinkStep(origin: City): RouteStep {
  return step({
    kind: "satellite",
    refId: `${origin.id}-uplink`,
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

function withHubPath(steps: RouteStep[], hubIds: string[], edges: HubEdge[]): void {
  for (let i = 0; i < hubIds.length; i++) {
    const hub = CITY_BY_ID.get(hubIds[i])!;
    if (i === 0) {
      steps.push(hubStep(hub));
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

export function buildTerrestrialRoute(originId: string, destId: string): Route {
  const origin = CITY_BY_ID.get(originId);
  const dest = CITY_BY_ID.get(destId);
  if (!origin || !dest) throw new Error(`Unknown city id: ${originId} / ${destId}`);

  const steps: RouteStep[] = [deviceStep(origin)];
  if (!origin.kinds.includes("hub")) steps.push(towerStep(origin));

  const originHub = nearestHub(origin);
  const destHub = nearestHub(dest);
  const { hubIds, edges } = shortestHubPath(originHub.id, destHub.id);
  withHubPath(steps, hubIds, edges);

  steps.push(serverStep(dest));

  return { steps, usesStarlink: false, crossesOcean: edges.some((e) => e.kind === "submarine"), backboneEdges: edges };
}

export function buildStarlinkRoute(originId: string, destId: string): Route {
  const origin = CITY_BY_ID.get(originId);
  const dest = CITY_BY_ID.get(destId);
  if (!origin || !dest) throw new Error(`Unknown city id: ${originId} / ${destId}`);

  const gs = nearestGroundStation(origin);
  const steps: RouteStep[] = [
    deviceStep(origin),
    satelliteUplinkStep(origin),
    satelliteRelayStep(origin.id, midpointLatLon(origin, gs), 1),
    groundStationStep(gs),
  ];

  const { hubIds, edges } = shortestHubPath(gs.nearestHub, nearestHub(dest).id);
  withHubPath(steps, hubIds, edges);
  steps.push(serverStep(dest));

  return { steps, usesStarlink: true, crossesOcean: edges.some((e) => e.kind === "submarine"), backboneEdges: edges };
}

export function buildRoute(originId: string, destId: string, starlink: boolean): Route {
  return starlink ? buildStarlinkRoute(originId, destId) : buildTerrestrialRoute(originId, destId);
}

const RANDOMIZABLE_ORIGINS = CITIES.filter((c) => c.kinds.includes("origin"));
const RANDOMIZABLE_SERVERS = CITIES.filter((c) => c.kinds.includes("server"));

export function pickRandomPair(): { originId: string; destId: string } {
  const origin = RANDOMIZABLE_ORIGINS[Math.floor(Math.random() * RANDOMIZABLE_ORIGINS.length)];
  let dest = RANDOMIZABLE_SERVERS[Math.floor(Math.random() * RANDOMIZABLE_SERVERS.length)];
  let guard = 0;
  while (dest.id === origin.id && guard < 10) {
    dest = RANDOMIZABLE_SERVERS[Math.floor(Math.random() * RANDOMIZABLE_SERVERS.length)];
    guard += 1;
  }
  return { originId: origin.id, destId: dest.id };
}
