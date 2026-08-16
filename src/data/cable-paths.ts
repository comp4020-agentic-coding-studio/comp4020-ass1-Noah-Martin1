// Finding a real cable to carry a leg of the route.
//
// The route model picks hops through a simplified hub graph, which is the right
// level for the story. But drawing a submarine leg as a clean great-circle arc
// says something false: undersea cables emphatically do not run great circles.
// They dogleg around continental shelves, territorial waters and trenches, and
// that shape is most of what makes a cable map look like a cable map.
//
// So when a leg crosses an ocean, we look for a published cable system whose
// path actually connects those two hubs and draw along it. When none does, the
// arc is used unchanged — an honest "we don't have a cable for this" rather
// than a fabricated one.
//
// The wrinkle: every TeleGeography feature is a MultiLineString, and a system's
// branches are separate polylines. Sydney and Singapore are both on Hawaiki Nui
// 1, but on different branches of it, so matching a single polyline finds
// nothing for most ocean crossings. The branches have to be chained.

import type { CableCollection, CableFeature } from "./generated/cables";
import { cableSegments } from "./generated/cables";
import { distanceKm } from "./generated/nearest";
import type { LatLon } from "./types";

/**
 * How near a hub has to be to a cable vertex for that cable to count as serving
 * it. Hubs are cities and landing stations are on the coast nearby, so this is
 * generous enough to connect "Singapore" to a cable landing at Changi, and
 * tight enough not to claim a cable in a neighbouring country.
 */
const LANDING_TOLERANCE_KM = 450;

/**
 * How close two branch ends must be to count as the same system continuing.
 *
 * Most branches meet exactly (0 km) at their landing points, but the published
 * geometry is simplified and some ends of the same system sit a couple of
 * hundred kilometres apart — Hawaiki Nui 1's Australian branch is 204 km from
 * the branch that carries on to Asia. Bridging that gap follows the real cable
 * for all but a sliver of the crossing; refusing to would fall back to a great
 * circle for the entire ocean, which is far less true to the geography.
 */
const JOIN_TOLERANCE_KM = 260;

type Point = readonly [number, number];

export interface CablePathIndex {
  /**
   * A real cable path from `a` to `b`, as `[lon, lat]` vertices including both
   * ends, or null when no published system connects them.
   */
  between(a: LatLon, b: LatLon): [number, number][] | null;
}

function toLatLon(point: Point): LatLon {
  return { lat: point[1], lon: point[0] };
}

function pathLengthKm(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceKm(toLatLon(points[i - 1]), toLatLon(points[i]));
  return total;
}

interface Nearest {
  line: number;
  vertex: number;
  km: number;
}

function nearestVertex(branches: readonly (readonly Point[])[], to: LatLon): Nearest {
  let best: Nearest = { line: -1, vertex: -1, km: Infinity };
  for (let l = 0; l < branches.length; l++) {
    const points = branches[l];
    for (let v = 0; v < points.length; v++) {
      // Cheap reject before the trig: a vertex more than ~8 degrees of latitude
      // away cannot be within tolerance.
      if (Math.abs(points[v][1] - to.lat) > 8) continue;
      const km = distanceKm(to, toLatLon(points[v]));
      if (km < best.km) best = { line: l, vertex: v, km };
    }
  }
  return best;
}

/**
 * Where one branch of a system meets another.
 *
 * Crucially the meeting point on the far branch is *any* vertex, not just an
 * end. Branches were originally chained end-to-end only, which quietly threw
 * away most of the network: a country drop or a trunk continuation usually
 * T's off the middle of another branch, not its tip. Curie is the clearest
 * case -- two branches, one landing near Los Angeles and one near Panama,
 * joined mid-span -- and end-only matching rejected the whole system, so the
 * leg fell back to a great circle straight across Central America. Cape Town
 * to London failed the same way on 2Africa's 38 branches.
 */
interface Junction {
  aLine: number;
  aVertex: number;
  bLine: number;
  bVertex: number;
  km: number;
}

function buildJunctions(branches: readonly (readonly Point[])[]): Junction[] {
  const out: Junction[] = [];
  for (let j = 0; j < branches.length; j++) {
    // A branch can only *start* a join at one of its own ends -- that is where
    // a cable physically terminates into another run.
    for (const end of [0, branches[j].length - 1]) {
      const point = branches[j][end];
      for (let i = 0; i < branches.length; i++) {
        if (i === j) continue;
        const points = branches[i];
        let bestVertex = -1;
        let bestKm = Infinity;
        for (let v = 0; v < points.length; v++) {
          // ~3 degrees of latitude comfortably exceeds the join tolerance.
          if (Math.abs(points[v][1] - point[1]) > 3) continue;
          const km = distanceKm(toLatLon(point), toLatLon(points[v]));
          if (km < bestKm) {
            bestKm = km;
            bestVertex = v;
          }
        }
        if (bestVertex >= 0 && bestKm <= JOIN_TOLERANCE_KM) {
          out.push({ aLine: j, aVertex: end, bLine: i, bVertex: bestVertex, km: bestKm });
        }
      }
    }
  }
  return out;
}

/** Distance from each branch's first vertex to every other, for O(1) spans. */
function cumulative(branches: readonly (readonly Point[])[]): number[][] {
  return branches.map((points) => {
    const run = [0];
    for (let v = 1; v < points.length; v++) {
      run.push(run[v - 1] + distanceKm(toLatLon(points[v - 1]), toLatLon(points[v])));
    }
    return run;
  });
}

interface Node {
  line: number;
  vertex: number;
}

const nodeKey = (node: Node): string => `${node.line}:${node.vertex}`;

/**
 * Walks a system from `from` to `to`, following branches and crossing between
 * them at their junctions.
 *
 * Dijkstra over "ports" -- the handful of vertices per branch that matter: its
 * two ends, wherever another branch meets it, and the entry/exit vertices for
 * this particular query. Everything between two adjacent ports is a fixed span
 * of the branch, so the graph stays tiny even for a 38-branch system.
 */
function pathThroughSystem(
  branches: readonly (readonly Point[])[],
  junctions: readonly Junction[],
  cum: readonly number[][],
  from: Nearest,
  to: Nearest,
): Point[] | null {
  const ports: Set<number>[] = branches.map((points) => new Set([0, points.length - 1]));
  for (const junction of junctions) {
    ports[junction.aLine].add(junction.aVertex);
    ports[junction.bLine].add(junction.bVertex);
  }
  ports[from.line].add(from.vertex);
  ports[to.line].add(to.vertex);

  const edges = new Map<string, { to: Node; km: number }[]>();
  const link = (a: Node, b: Node, km: number): void => {
    if (!edges.has(nodeKey(a))) edges.set(nodeKey(a), []);
    edges.get(nodeKey(a))!.push({ to: b, km });
  };

  // Along each branch, between neighbouring ports.
  ports.forEach((set, line) => {
    const sorted = [...set].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) {
      const lo = sorted[i - 1];
      const hi = sorted[i];
      const km = cum[line][hi] - cum[line][lo];
      link({ line, vertex: lo }, { line, vertex: hi }, km);
      link({ line, vertex: hi }, { line, vertex: lo }, km);
    }
  });

  // And across the junctions, in both directions.
  for (const junction of junctions) {
    const a: Node = { line: junction.aLine, vertex: junction.aVertex };
    const b: Node = { line: junction.bLine, vertex: junction.bVertex };
    link(a, b, junction.km);
    link(b, a, junction.km);
  }

  const source: Node = { line: from.line, vertex: from.vertex };
  const target: Node = { line: to.line, vertex: to.vertex };
  const cost = new Map<string, number>([[nodeKey(source), 0]]);
  const previous = new Map<string, Node>();
  const settled = new Set<string>();
  const frontier: Node[] = [source];

  while (frontier.length > 0) {
    let bestAt = 0;
    for (let i = 1; i < frontier.length; i++) {
      if ((cost.get(nodeKey(frontier[i])) ?? Infinity) < (cost.get(nodeKey(frontier[bestAt])) ?? Infinity)) bestAt = i;
    }
    const current = frontier.splice(bestAt, 1)[0];
    const key = nodeKey(current);
    if (settled.has(key)) continue;
    settled.add(key);
    if (key === nodeKey(target)) break;

    const here = cost.get(key) ?? Infinity;
    for (const edge of edges.get(key) ?? []) {
      const next = nodeKey(edge.to);
      if (settled.has(next)) continue;
      const candidate = here + edge.km;
      if (candidate < (cost.get(next) ?? Infinity)) {
        cost.set(next, candidate);
        previous.set(next, current);
        frontier.push(edge.to);
      }
    }
  }

  if (!cost.has(nodeKey(target))) return null;

  const nodes: Node[] = [target];
  for (let cursor = previous.get(nodeKey(target)); cursor; cursor = previous.get(nodeKey(cursor))) {
    nodes.unshift(cursor);
    if (nodeKey(cursor) === nodeKey(source)) break;
  }

  const out: Point[] = [];
  const push = (point: Point): void => {
    const last = out[out.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  };

  push(branches[nodes[0].line][nodes[0].vertex]);
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1];
    const b = nodes[i];
    if (a.line !== b.line) {
      // A junction hop: the two vertices are within tolerance of each other,
      // so stepping straight across is the join itself.
      push(branches[b.line][b.vertex]);
      continue;
    }
    const points = branches[a.line];
    if (a.vertex <= b.vertex) {
      for (let v = a.vertex + 1; v <= b.vertex; v++) push(points[v]);
    } else {
      for (let v = a.vertex - 1; v >= b.vertex; v--) push(points[v]);
    }
  }

  return out.length >= 2 ? out : null;
}

export function createCablePathIndex(collection: CableCollection): CablePathIndex {
  interface System {
    branches: Point[][];
    /* Junctions and spans are properties of the cable, not of the query, so
       they are worked out once on first use and kept. */
    junctions?: Junction[];
    cum?: number[][];
  }

  const systems: System[] = collection.features.map((feature: CableFeature) => ({
    branches: cableSegments(feature).filter((segment) => segment.length >= 2),
  }));

  return {
    between(a: LatLon, b: LatLon): [number, number][] | null {
      let bestPath: Point[] | null = null;
      let bestScore = Infinity;

      for (const system of systems) {
        if (system.branches.length === 0) continue;

        const from = nearestVertex(system.branches, a);
        if (from.km > LANDING_TOLERANCE_KM) continue;
        const to = nearestVertex(system.branches, b);
        if (to.km > LANDING_TOLERANCE_KM) continue;

        system.junctions ??= buildJunctions(system.branches);
        system.cum ??= cumulative(system.branches);

        const path = pathThroughSystem(system.branches, system.junctions, system.cum, from, to);
        if (!path) continue;

        /*
         * Score by the distance actually travelled plus how far the cable falls
         * short of each hub, so a system landing on both cities beats one that
         * merely passes within tolerance, and an indirect routing loses to a
         * direct one.
         */
        const score = pathLengthKm(path) + from.km + to.km;
        if (score < bestScore) {
          bestScore = score;
          bestPath = path;
        }
      }

      if (!bestPath) return null;
      // Stitch the hubs onto the ends so the drawn leg starts and finishes on
      // the route's own nodes rather than at a landing point offshore.
      return [[a.lon, a.lat], ...bestPath.map((p) => [p[0], p[1]] as [number, number]), [b.lon, b.lat]];
    },
  };
}
