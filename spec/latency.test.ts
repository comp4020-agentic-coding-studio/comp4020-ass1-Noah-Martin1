import { describe, expect, it } from "vitest";
import { CITY_BY_ID } from "../src/data/geo";
import { buildRoute } from "../src/data/routes";
import type { RouteDestination, RouteOrigin } from "../src/data/types";

function place(id: string): RouteOrigin & RouteDestination {
  const city = CITY_BY_ID.get(id)!;
  return { lat: city.lat, lon: city.lon, label: city.name, cityId: city.id };
}

function route(a: string, b: string, starlink = false) {
  return buildRoute(place(a), place(b), starlink, null);
}

describe("route latency estimates", () => {
  it("starts the clock at zero on the device", () => {
    const { steps } = route("lon", "nyc");
    expect(steps[0].latencyMs).toBe(0);
    expect(steps[0].elapsedMs).toBe(0);
  });

  it("accumulates so the legs add up to the total shown at the end", () => {
    for (const starlink of [false, true]) {
      const built = route("syd", "lon", starlink);
      let running = 0;
      for (const step of built.steps) {
        running += step.latencyMs;
        // A reader summing the per-stage numbers must arrive at the cumulative
        // one, which is why legs are rounded before they are added rather than
        // at display time.
        expect(step.elapsedMs).toBe(running);
      }
      expect(built.totalLatencyMs).toBe(built.steps[built.steps.length - 1].elapsedMs);
    }
  });

  it("never goes backwards along the route", () => {
    const { steps } = route("cpt", "lon");
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].elapsedMs).toBeGreaterThanOrEqual(steps[i - 1].elapsedMs);
    }
  });

  it("charges more for a longer journey", () => {
    expect(route("syd", "lon").totalLatencyMs).toBeGreaterThan(route("lon", "nyc").totalLatencyMs);
    expect(route("lon", "nyc").totalLatencyMs).toBeGreaterThan(route("lon", "par").totalLatencyMs);
  });

  it("makes the ocean crossing dominate its route", () => {
    const { steps, totalLatencyMs } = route("lon", "nyc");
    const crossing = steps.find((s) => s.infra === "fibre-submarine")!;
    // The teaching point: the Atlantic costs more than every router on either
    // side of it put together.
    expect(crossing.latencyMs).toBeGreaterThan(totalLatencyMs / 2);
  });

  it("lands in the right ballpark for well-known round trips", () => {
    /*
     * Real-world round trips, for reference: London-New York is about 70-80ms,
     * Sydney-London about 250-280ms, Cape Town-London about 150ms. These are
     * estimates from distance, so the bounds are broad on purpose — they exist
     * to catch a model that has drifted into nonsense, not to pin a figure.
     */
    const rtt = (a: string, b: string) => route(a, b).totalLatencyMs * 2;
    expect(rtt("lon", "nyc")).toBeGreaterThan(50);
    expect(rtt("lon", "nyc")).toBeLessThan(110);
    expect(rtt("syd", "lon")).toBeGreaterThan(200);
    expect(rtt("syd", "lon")).toBeLessThan(340);
    expect(rtt("cpt", "lon")).toBeGreaterThan(95);
    expect(rtt("cpt", "lon")).toBeLessThan(200);
  });

  it("costs more over Starlink than over fibre for a short hop", () => {
    // Going to orbit and back is a real cost, and over a short distance there
    // is no fibre detour for it to win back.
    expect(route("lon", "par", true).totalLatencyMs).toBeGreaterThan(route("lon", "par", false).totalLatencyMs);
  });
});
