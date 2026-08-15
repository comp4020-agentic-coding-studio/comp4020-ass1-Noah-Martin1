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
 * Walks one system's branches from `from` to `to`, hopping between branches
 * wherever their ends meet.
 *
 * Dijkstra over (branch, end-we-leave-by): entering a branch at one end and
 * leaving by the other means traversing all of it, so the state space is two
 * per branch and a system only has a handful of branches.
 */
function pathThroughSystem(branches: readonly (readonly Point[])[], from: Nearest, to: Nearest): Point[] | null {
  if (from.line === to.line) {
    const points = branches[from.line];
    const lo = Math.min(from.vertex, to.vertex);
    const hi = Math.max(from.vertex, to.vertex);
    const slice = points.slice(lo, hi + 1);
    return from.vertex <= to.vertex ? slice : slice.slice().reverse();
  }

  const endPoint = (line: number, end: 0 | 1): Point => {
    const points = branches[line];
    return end === 0 ? points[0] : points[points.length - 1];
  };

  interface State {
    line: number;
    exit: 0 | 1;
  }
  const key = (state: State): string => `${state.line}:${state.exit}`;

  const cost = new Map<string, number>();
  const previous = new Map<string, State | null>();
  const queue: State[] = [];

  for (const exit of [0, 1] as const) {
    // Leaving the first branch means walking from the entry vertex to that end.
    const points = branches[from.line];
    const walk =
      exit === 0
        ? pathLengthKm(points.slice(0, from.vertex + 1))
        : pathLengthKm(points.slice(from.vertex));
    const state: State = { line: from.line, exit };
    cost.set(key(state), walk);
    previous.set(key(state), null);
    queue.push(state);
  }

  let best: { state: State; total: number } | null = null;

  while (queue.length > 0) {
    queue.sort((x, y) => (cost.get(key(x)) ?? Infinity) - (cost.get(key(y)) ?? Infinity));
    const current = queue.shift()!;
    const currentCost = cost.get(key(current)) ?? Infinity;
    if (best && currentCost >= best.total) break;

    const here = endPoint(current.line, current.exit);

    for (let line = 0; line < branches.length; line++) {
      if (line === current.line) continue;
      for (const entry of [0, 1] as const) {
        const gap = distanceKm(toLatLon(here), toLatLon(endPoint(line, entry)));
        if (gap > JOIN_TOLERANCE_KM) continue;

        if (line === to.line) {
          // Final branch: stop at the target vertex rather than traversing it all.
          const points = branches[line];
          const walk =
            entry === 0
              ? pathLengthKm(points.slice(0, to.vertex + 1))
              : pathLengthKm(points.slice(to.vertex));
          const total = currentCost + gap + walk;
          if (!best || total < best.total) {
            best = { state: current, total };
          }
          continue;
        }

        const exit: 0 | 1 = entry === 0 ? 1 : 0;
        const next: State = { line, exit };
        const total = currentCost + gap + pathLengthKm(branches[line]);
        if (total < (cost.get(key(next)) ?? Infinity)) {
          cost.set(key(next), total);
          previous.set(key(next), current);
          queue.push(next);
        }
      }
    }
  }

  if (!best) return null;

  // Rebuild the branch order, then emit the vertices along it.
  const order: State[] = [];
  for (let cursor: State | null | undefined = best.state; cursor; cursor = previous.get(key(cursor))) {
    order.unshift(cursor);
  }

  const out: Point[] = [];
  order.forEach((state, position) => {
    const points = branches[state.line];
    let slice: Point[];
    if (position === 0) {
      slice = state.exit === 0 ? points.slice(0, from.vertex + 1).reverse() : points.slice(from.vertex);
    } else {
      slice = state.exit === 0 ? points.slice().reverse() : points.slice();
    }
    out.push(...(out.length === 0 ? slice : slice.slice(1)));
  });

  // And the final branch, entered from whichever end is nearer where we are.
  const tail = branches[to.line];
  const last = out.length > 0 ? out[out.length - 1] : endPoint(from.line, 0);
  const fromStart = distanceKm(toLatLon(last), toLatLon(tail[0]));
  const fromEnd = distanceKm(toLatLon(last), toLatLon(tail[tail.length - 1]));
  const tailSlice =
    fromStart <= fromEnd ? tail.slice(0, to.vertex + 1) : tail.slice(to.vertex).slice().reverse();
  out.push(...tailSlice);

  return out.length >= 2 ? out : null;
}

export function createCablePathIndex(collection: CableCollection): CablePathIndex {
  const systems: { branches: Point[][] }[] = collection.features.map((feature: CableFeature) => ({
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

        const path = pathThroughSystem(system.branches, from, to);
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
