import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { CITY_BY_ID, GROUND_STATIONS, HUB_EDGES } from "../src/data/geo";
import { buildRoute, buildStarlinkRoute, buildTerrestrialRoute, pickRandomPair } from "../src/data/routes";
import { greatCircleArcPoints, haversineKm, midpointLatLon, vector3ToLatLon, latLonToVector3 } from "../src/globe/geometry";

// This week's spec is "Visualise your internet requests": an interactive
// globe that walks a user through how a request travels, over conventional
// 5G/fibre or Starlink. These tests assert the mechanically-checkable parts
// of that contract -- see CLAUDE.md for the full brief.

describe("home page markup", () => {
  const doc = new JSDOM(readFileSync(resolve("dist/index.html"), "utf8")).window.document;

  it("uses the required main heading", () => {
    const h1 = doc.querySelector("h1");
    expect(h1?.textContent?.trim()).toBe("Visualise your internet requests");
  });

  it("presents the globe as an accessible, labelled region", () => {
    const stage = doc.getElementById("globe-stage");
    expect(stage).toBeTruthy();
    expect(stage?.getAttribute("role")).toBe("img");
    expect(stage?.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(20);
  });

  it("has mount points for the controls and the route story", () => {
    expect(doc.getElementById("control-panel-host")).toBeTruthy();
    expect(doc.getElementById("story-host")).toBeTruthy();
  });

  it("loads the app as a bundled module script", () => {
    const script = doc.querySelector('script[type="module"]');
    expect(script?.getAttribute("src")).toMatch(/\.js$/);
  });
});

describe("route model: terrestrial (Starlink off)", () => {
  it("always starts on the device and ends on a server", () => {
    const route = buildTerrestrialRoute("lon", "syd");
    expect(route.steps[0].kind).toBe("device");
    expect(route.steps.at(-1)?.kind).toBe("server");
    expect(route.usesStarlink).toBe(false);
  });

  it("inserts a wireless hop only when the origin isn't itself a hub", () => {
    const fromNonHub = buildTerrestrialRoute("chi", "syd"); // Chicago: origin-only
    expect(fromNonHub.steps[1].infra).toBe("wireless");

    const fromHub = buildTerrestrialRoute("lon", "syd"); // London: origin + hub
    expect(fromHub.steps[1].infra).not.toBe("wireless");
  });

  it("marks crossesOcean exactly when the path uses a submarine edge", () => {
    for (const [from, to] of [
      ["lon", "syd"],
      ["nyc", "lax"],
      ["par", "ber"],
    ] as const) {
      const route = buildTerrestrialRoute(from, to);
      const hasSubmarineStep = route.steps.some((s) => s.infra === "fibre-submarine");
      expect(route.crossesOcean).toBe(hasSubmarineStep);
      expect(route.backboneEdges.some((e) => e.kind === "submarine")).toBe(route.crossesOcean);
    }
  });

  it("never fabricates an undersea-cable stage for an all-terrestrial hop", () => {
    const route = buildTerrestrialRoute("par", "ber");
    expect(route.crossesOcean).toBe(false);
    expect(route.steps.some((s) => s.infra === "fibre-submarine")).toBe(false);
  });
});

describe("route model: Starlink on", () => {
  it("always includes an uplink, at least one relay, and a ground-station hop", () => {
    const route = buildStarlinkRoute("nai", "tyo");
    expect(route.usesStarlink).toBe(true);
    const kinds = route.steps.map((s) => s.infra);
    expect(kinds).toContain("satellite-uplink");
    expect(kinds).toContain("satellite-link");
    expect(kinds).toContain("ground-link");
  });

  it("routes through a real ground station id", () => {
    const route = buildStarlinkRoute("lag", "lon");
    const groundStep = route.steps.find((s) => s.kind === "ground-station");
    expect(groundStep).toBeTruthy();
    expect(GROUND_STATIONS.some((gs) => gs.id === groundStep?.refId)).toBe(true);
  });

  it("dispatches on the starlink flag", () => {
    expect(buildRoute("lon", "syd", true).usesStarlink).toBe(true);
    expect(buildRoute("lon", "syd", false).usesStarlink).toBe(false);
  });
});

describe("random routes", () => {
  it("always returns a known, distinct-when-possible origin and destination", () => {
    for (let i = 0; i < 25; i++) {
      const { originId, destId } = pickRandomPair();
      expect(CITY_BY_ID.get(originId)?.kinds.includes("origin")).toBe(true);
      expect(CITY_BY_ID.get(destId)?.kinds.includes("server")).toBe(true);
    }
  });

  it("produces a route that builds cleanly for either mode", () => {
    const { originId, destId } = pickRandomPair();
    expect(() => buildRoute(originId, destId, false)).not.toThrow();
    expect(() => buildRoute(originId, destId, true)).not.toThrow();
  });
});

describe("backbone data", () => {
  it("references only known hub cities", () => {
    for (const edge of HUB_EDGES) {
      expect(CITY_BY_ID.get(edge.a)).toBeTruthy();
      expect(CITY_BY_ID.get(edge.b)).toBeTruthy();
    }
  });

  it("gives every ground station a real nearest hub", () => {
    for (const gs of GROUND_STATIONS) {
      expect(CITY_BY_ID.get(gs.nearestHub)).toBeTruthy();
    }
  });
});

describe("globe geometry", () => {
  it("round-trips lat/lon through a sphere position", () => {
    const original = { lat: -12.3, lon: 78.4 };
    const back = vector3ToLatLon(latLonToVector3(original, 2.5));
    expect(back.lat).toBeCloseTo(original.lat, 3);
    expect(back.lon).toBeCloseTo(original.lon, 3);
  });

  it("measures zero distance between a point and itself", () => {
    expect(haversineKm({ lat: 10, lon: 10 }, { lat: 10, lon: 10 })).toBeCloseTo(0, 6);
  });

  it("draws a great-circle arc that starts and ends at the requested points", () => {
    const a = { lat: 40.71, lon: -74.01 };
    const b = { lat: 51.51, lon: -0.13 };
    const points = greatCircleArcPoints(a, b, 1.6, 0.05, 8);
    expect(points).toHaveLength(9);
    const start = vector3ToLatLon(points[0]);
    const end = vector3ToLatLon(points.at(-1)!);
    expect(start.lat).toBeCloseTo(a.lat, 1);
    expect(end.lat).toBeCloseTo(b.lat, 1);
  });

  it("finds the same midpoint regardless of argument order", () => {
    const a = { lat: 10, lon: 20 };
    const b = { lat: -5, lon: 100 };
    expect(midpointLatLon(a, b)).toEqual(midpointLatLon(b, a));
  });
});
