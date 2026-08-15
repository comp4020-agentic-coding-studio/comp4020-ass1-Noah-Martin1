import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { CITY_BY_ID, GROUND_STATIONS, HUB_EDGES } from "../src/data/geo";
import { buildRoute, buildStarlinkRoute, buildTerrestrialRoute, pickRandomPair } from "../src/data/routes";
import type { RouteDestination, RouteOrigin, TowerHop } from "../src/data/types";
import { createPlaceIndex, createTowerIndex, type TowerMeta } from "../src/data/generated/towers";
import { greatCircleArcPoints, haversineKm, midpointLatLon, vector3ToLatLon, latLonToVector3 } from "../src/globe/geometry";

/** A modelled city expressed as what the app now actually passes around. */
function destOf(cityId: string): RouteDestination {
  return originOf(cityId);
}

function originOf(cityId: string): RouteOrigin {
  const city = CITY_BY_ID.get(cityId);
  if (!city) throw new Error(`unknown test city ${cityId}`);
  return { lat: city.lat, lon: city.lon, label: `${city.name}, ${city.country}`, cityId };
}

/** A point that is deliberately not any modelled city: White Cliffs, NSW. */
const WHITE_CLIFFS: RouteOrigin = {
  lat: -30.85,
  lon: 143.09,
  label: "New South Wales, Australia · 84 km from Wilcannia",
  cityId: null,
};

const A_TOWER: TowerHop = { lat: -30.79, lon: 143.1, towers: 2, distanceKm: 7 };

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

  // The globe is a full-bleed canvas the user can orbit, zoom and pick on --
  // including from the keyboard -- so it must carry an interactive role and be
  // focusable. (It was previously a static div labelled role="img"; that role
  // would now actively misdescribe it to a screen reader.)
  it("presents the globe as an accessible, focusable, labelled control", () => {
    const stage = doc.getElementById("globe-canvas");
    expect(stage).toBeTruthy();
    expect(stage?.tagName.toLowerCase()).toBe("canvas");
    expect(stage?.getAttribute("role")).toBe("application");
    expect(stage?.getAttribute("tabindex")).toBe("0");
    expect(stage?.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(20);
  });

  it("anchors the globe's framing to a layout element", () => {
    // The renderer centres the planet on this box, which is what keeps the
    // layout working at sizes other than the two marked viewports.
    expect(doc.getElementById("globe-focus")).toBeTruthy();
  });

  it("discloses that routes and orbits are simplified, not live", () => {
    expect(doc.getElementById("data-note")).toBeTruthy();
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
    const route = buildTerrestrialRoute(originOf("lon"), destOf("syd"), null);
    expect(route.steps[0].kind).toBe("device");
    expect(route.steps.at(-1)?.kind).toBe("server");
    expect(route.usesStarlink).toBe(false);
  });

  // The whole point of picking a spot on the globe: the request has to start
  // where the user actually pointed, not at whichever modelled city is closest.
  it("keeps the chosen point as the origin instead of snapping to a city", () => {
    const route = buildTerrestrialRoute(WHITE_CLIFFS, destOf("lon"), A_TOWER);
    expect(route.steps[0].location.lat).toBeCloseTo(WHITE_CLIFFS.lat, 6);
    expect(route.steps[0].location.lon).toBeCloseTo(WHITE_CLIFFS.lon, 6);
    expect(route.steps[0].title).toContain("New South Wales");
    // Sydney is the nearest modelled hub; it must appear as a later hop, not
    // as the place the request began.
    expect(route.steps[0].title).not.toContain("Sydney");
  });

  it("goes device → radio → network core when starting away from a hub", () => {
    const route = buildTerrestrialRoute(WHITE_CLIFFS, destOf("lon"), A_TOWER);
    expect(route.steps[1].infra).toBe("wireless");
    expect(route.steps[1].location.lat).toBeCloseTo(A_TOWER.lat, 6);
    expect(route.steps[2].infra).toBe("fibre-terrestrial");
    expect(route.steps[2].title).toContain("Network core");
  });

  // Symmetric with the origin: the traceroute has to end at the data centre the
  // user chose, not at whichever modelled city sits nearest to it.
  it("ends at the chosen data centre, keeping its exact position and name", () => {
    const equinixSy5: RouteDestination = {
      lat: -33.7495,
      lon: 150.9046,
      label: "Equinix SY5b",
      cityId: null,
    };
    const route = buildTerrestrialRoute(WHITE_CLIFFS, equinixSy5, A_TOWER);
    const last = route.steps.at(-1);
    expect(last?.kind).toBe("server");
    expect(last?.location.lat).toBeCloseTo(equinixSy5.lat, 6);
    expect(last?.location.lon).toBeCloseTo(equinixSy5.lon, 6);
    expect(last?.title).toContain("Equinix SY5b");
  });

  it("names the real distance to the mast rather than glossing it", () => {
    const route = buildTerrestrialRoute(WHITE_CLIFFS, destOf("lon"), A_TOWER);
    expect(route.steps[1].explanation).toContain("7 km");
  });

  it("omits the wireless hop when the origin is itself a hub", () => {
    const route = buildTerrestrialRoute(originOf("lon"), destOf("syd"), A_TOWER);
    expect(route.steps[1].infra).not.toBe("wireless");
  });

  // Tower data is 2 MB and arrives after first paint, so a route built in the
  // meantime must still be a valid route -- just without the radio leg.
  it("still builds a coherent route before the tower data has loaded", () => {
    const route = buildTerrestrialRoute(WHITE_CLIFFS, destOf("lon"), null);
    expect(route.steps[0].kind).toBe("device");
    expect(route.steps.at(-1)?.kind).toBe("server");
    expect(route.steps.some((s) => s.infra === "wireless")).toBe(false);
  });

  it("marks crossesOcean exactly when the path uses a submarine edge", () => {
    for (const [from, to] of [
      ["lon", "syd"],
      ["nyc", "lax"],
      ["par", "ber"],
    ] as const) {
      const route = buildTerrestrialRoute(originOf(from), destOf(to), null);
      const hasSubmarineStep = route.steps.some((s) => s.infra === "fibre-submarine");
      expect(route.crossesOcean).toBe(hasSubmarineStep);
      expect(route.backboneEdges.some((e) => e.kind === "submarine")).toBe(route.crossesOcean);
    }
  });

  it("never fabricates an undersea-cable stage for an all-terrestrial hop", () => {
    const route = buildTerrestrialRoute(originOf("par"), destOf("ber"), null);
    expect(route.crossesOcean).toBe(false);
    expect(route.steps.some((s) => s.infra === "fibre-submarine")).toBe(false);
  });
});

describe("route model: Starlink on", () => {
  it("always includes an uplink, at least one relay, and a ground-station hop", () => {
    const route = buildStarlinkRoute(originOf("nai"), destOf("tyo"));
    expect(route.usesStarlink).toBe(true);
    const kinds = route.steps.map((s) => s.infra);
    expect(kinds).toContain("satellite-uplink");
    expect(kinds).toContain("satellite-link");
    expect(kinds).toContain("ground-link");
  });

  it("routes through a real ground station id", () => {
    const route = buildStarlinkRoute(originOf("lag"), destOf("lon"));
    const groundStep = route.steps.find((s) => s.kind === "ground-station");
    expect(groundStep).toBeTruthy();
    expect(GROUND_STATIONS.some((gs) => gs.id === groundStep?.refId)).toBe(true);
  });

  it("dispatches on the starlink flag", () => {
    expect(buildRoute(originOf("lon"), destOf("syd"), true, null).usesStarlink).toBe(true);
    expect(buildRoute(originOf("lon"), destOf("syd"), false, null).usesStarlink).toBe(false);
  });

  // A satellite uplink goes straight up from wherever you are, so an arbitrary
  // point must not be relocated to a city here either.
  it("beams up from the chosen point, not from a nearby city", () => {
    const route = buildStarlinkRoute(WHITE_CLIFFS, destOf("lon"));
    const uplink = route.steps.find((s) => s.infra === "satellite-uplink");
    expect(uplink?.location.lat).toBeCloseTo(WHITE_CLIFFS.lat, 6);
    expect(uplink?.location.lon).toBeCloseTo(WHITE_CLIFFS.lon, 6);
  });
});

describe("random routes", () => {
  it("always returns a known, distinct-when-possible origin and destination", () => {
    for (let i = 0; i < 25; i++) {
      const { origin, destination } = pickRandomPair();
      expect(origin.cityId).toBeTruthy();
      expect(CITY_BY_ID.get(origin.cityId!)?.kinds.includes("origin")).toBe(true);
      expect(destination.cityId).toBeTruthy();
      expect(CITY_BY_ID.get(destination.cityId!)?.kinds.includes("server")).toBe(true);
    }
  });

  it("produces a route that builds cleanly for either mode", () => {
    const { origin, destination } = pickRandomPair();
    expect(() => buildRoute(origin, destination, false, null)).not.toThrow();
    expect(() => buildRoute(origin, destination, true, null)).not.toThrow();
  });
});

describe("cell towers and place naming", () => {
  const META = { towerPoints: 3 } as TowerMeta;

  it("finds the nearest tower and reports a real distance", () => {
    const index = createTowerIndex(
      [
        [151.2, -33.87, 4875], // Sydney
        [143.1, -30.79, 2], // near White Cliffs
        [-0.13, 51.51, 68029], // London
      ],
      META,
    );
    const found = index.nearest({ lat: -30.85, lon: 143.09 });
    expect(found?.tower.lon).toBeCloseTo(143.1, 3);
    expect(found?.distanceKm).toBeLessThan(20);
  });

  // Longitude wraps; a naive comparison puts the nearest tower on the wrong
  // side of the planet for anything sitting on the antimeridian.
  it("handles the antimeridian when choosing the nearest tower", () => {
    const index = createTowerIndex(
      [
        [179.5, -17, 1],
        [-100, -17, 1],
      ],
      META,
    );
    expect(index.nearest({ lat: -17, lon: -179.6 })?.tower.lon).toBeCloseTo(179.5, 3);
  });

  it("names a nearby place directly, and a distant one with its distance", () => {
    const places = createPlaceIndex([
      [143.375, -31.557, "Wilcannia", "New South Wales", "Australia"],
      [151.209, -33.868, "Sydney", "New South Wales", "Australia"],
    ]);

    const close = places.label({ lat: -31.55, lon: 143.38 });
    expect(close?.text).toBe("Wilcannia, New South Wales, Australia");

    // White Cliffs is ~84 km out, so the label must not imply you are in town.
    const far = places.label({ lat: -30.85, lon: 143.09 });
    expect(far?.text).toContain("New South Wales, Australia");
    expect(far?.text).toMatch(/\d+ km from Wilcannia/);
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
