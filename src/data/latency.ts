// Approximate delay for each leg of a route.
//
// These are estimates from physics and typical equipment behaviour, not
// measurements — the site has never sent a packet anywhere. They are worth
// showing anyway, because "latency is mostly distance" is one of the few things
// about networking that a globe can teach better than a paragraph can: the
// Atlantic crossing costs more than every router on either side of it put
// together, and you can see why.
//
// Everything here is deliberately round. Presenting 34 ms is honest about the
// model; presenting 34.28 ms would not be.

import { haversineKm } from "../globe/geometry";
import type { RouteStep } from "./types";

/**
 * Light in glass, roughly two thirds of its speed in vacuum, so about 200 km
 * per millisecond. This is the single most important number here: it is why
 * distance dominates every long route.
 */
const FIBRE_KM_PER_MS = 200;

/** Radio through air and vacuum travels at essentially the speed of light. */
const VACUUM_KM_PER_MS = 300;

/**
 * Real fibre does not run in straight lines — it follows coasts, roads and
 * rights of way, and routing sends traffic via exchange points rather than the
 * shortest arc. Measured internet paths commonly run a third or more longer
 * than the great-circle distance, so the straight-line figure alone would
 * understate every terrestrial leg.
 */
const TERRESTRIAL_DETOUR = 1.35;

/**
 * Submarine legs dogleg too, and by a very variable amount: across the sixteen
 * crossings this route model uses, the drawn cable runs between 2% and 97%
 * longer than the direct line, averaging about 29%.
 *
 * A single factor cannot honour both ends of that range, so this is a
 * deliberate middle. It matters because the alternative — measuring the great
 * circle — is not "approximate", it is systematically short: Cape Town to
 * London came out at 112 ms round trip against a real figure nearer 150 ms,
 * purely because the cable goes the long way round West Africa.
 *
 * The straight-line distance is used rather than the drawn cable's true length
 * because routes are built before the cable geometry has loaded, and a number
 * that changed once a 700 KB file arrived would be worse than one that is
 * merely approximate.
 */
const SUBMARINE_DETOUR = 1.2;

/** Switching and queueing at one network node. */
const HOP_PROCESSING_MS = 1.5;

/**
 * The 5G air interface: scheduling, coding and retransmission, none of which is
 * propagation. It dominates the first hop, since the mast is usually only a few
 * kilometres away.
 */
const RADIO_ACCESS_MS = 8;

/** Starlink's shell, near enough for an estimate. */
const SATELLITE_ALTITUDE_KM = 550;

/** Onboard switching for a satellite hop. */
const SATELLITE_HOP_MS = 2;

/** Delay for the leg that arrives at `to`, coming from `from`. */
function legLatencyMs(from: RouteStep, to: RouteStep): number {
  const ground = haversineKm(from.location, to.location);

  switch (to.infra) {
    case "wireless":
      return ground / VACUUM_KM_PER_MS + RADIO_ACCESS_MS;

    // Up to the satellite, or back down from it: the altitude is the leg.
    case "satellite-uplink":
    case "ground-link":
      return (SATELLITE_ALTITUDE_KM + ground) / VACUUM_KM_PER_MS + SATELLITE_HOP_MS;

    // Laser links between satellites run through vacuum, which is why they can
    // beat fibre over the same distance.
    case "satellite-link":
      return ground / VACUUM_KM_PER_MS + SATELLITE_HOP_MS;

    case "fibre-submarine":
      return (ground * SUBMARINE_DETOUR) / FIBRE_KM_PER_MS + HOP_PROCESSING_MS;

    case "fibre-terrestrial":
    default:
      return (ground * TERRESTRIAL_DETOUR) / FIBRE_KM_PER_MS + HOP_PROCESSING_MS;
  }
}

/**
 * Fills in `latencyMs` (this leg) and `elapsedMs` (cumulative from the device)
 * on each step, and returns the one-way total.
 *
 * Rounded to whole milliseconds per step so the numbers add up on screen: a
 * reader who sums the legs should get the total, which they would not if each
 * were rounded only at display time.
 */
export function annotateLatency(steps: RouteStep[]): number {
  let elapsed = 0;
  steps.forEach((step, index) => {
    const leg = index === 0 ? 0 : Math.max(1, Math.round(legLatencyMs(steps[index - 1], step)));
    elapsed += leg;
    step.latencyMs = leg;
    step.elapsedMs = elapsed;
  });
  return elapsed;
}
