import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCablePathIndex } from "../src/data/cable-paths";
import type { CableCollection } from "../src/data/generated/cables";
import { CITY_BY_ID, HUB_EDGES } from "../src/data/geo";
import { haversineKm } from "../src/globe/geometry";

const collection: CableCollection = JSON.parse(readFileSync("public/data/cables.geojson", "utf8"));
const index = createCablePathIndex(collection);

const SUBMARINE = HUB_EDGES.filter((edge) => edge.kind === "submarine");

function lengthKm(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineKm(
      { lat: points[i - 1][1], lon: points[i - 1][0] },
      { lat: points[i][1], lon: points[i][0] },
    );
  }
  return total;
}

describe("submarine legs follow real cables", () => {
  /*
   * The regression. Branches of a system were only ever chained end-to-end,
   * but a country drop or a trunk continuation usually T's off the *middle* of
   * another branch. Systems that plainly connected both hubs were therefore
   * rejected whole, and the leg fell back to a great circle — Cape Town to
   * London drew a straight line across the African continent, and Los Angeles
   * to Panama and Marseille to Dubai did the same.
   */
  it.each(SUBMARINE.map((edge) => [edge.a, edge.b] as const))(
    "%s -> %s resolves to a published cable, not a great circle",
    (a, b) => {
      const path = index.between(CITY_BY_ID.get(a)!, CITY_BY_ID.get(b)!);
      expect(path).not.toBeNull();
      // More than a handful of vertices means it is following geometry rather
      // than cutting a straight line between the two hubs.
      expect(path!.length).toBeGreaterThan(4);
    },
  );

  it("routes Cape Town to London out into the Atlantic, not over Africa", () => {
    const path = index.between(CITY_BY_ID.get("cpt")!, CITY_BY_ID.get("lon")!)!;
    const westmost = Math.min(...path.map(([lon]) => lon));
    /*
     * A great circle between the two never goes west of about 0 degrees — it
     * runs overland through Africa. The real west-coast systems swing out past
     * Cape Verde, beyond 15W. This is the assertion that fails if the leg ever
     * silently falls back to an arc again.
     */
    expect(westmost).toBeLessThan(-15);
  });

  it("keeps every leg a plausible length for its crossing", () => {
    for (const edge of SUBMARINE) {
      const a = CITY_BY_ID.get(edge.a)!;
      const b = CITY_BY_ID.get(edge.b)!;
      const path = index.between(a, b)!;
      const ratio = lengthKm(path) / haversineKm(a, b);
      // Cables dogleg, so they are always longer than the direct line, but a
      // path several times longer would mean the walk wandered off around the
      // system rather than crossing it.
      expect(ratio).toBeGreaterThan(1);
      expect(ratio).toBeLessThan(2.5);
    }
  });
});
