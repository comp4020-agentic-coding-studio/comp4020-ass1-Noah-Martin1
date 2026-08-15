#!/usr/bin/env node
// Builds the data centre layer from OpenStreetMap's `telecom=data_center`
// features, via Overpass.
//
// Why not PeeringDB, which is the obvious first answer: its facility registry
// is excellent and it is NOT open data. The PeeringDB AUP reserves all rights
// ("© 2004-2026 PeeringDB"), forbids passing data "on in bulk to any other
// person or organization unless approved", and excludes "demographic mapping"
// and commercial applications from the permitted purposes. Vendoring their
// 5,255 facilities into a public repository and deploying it is precisely the
// bulk redistribution that policy prohibits, so it is not used here.
//
// OpenStreetMap is ODbL: reusable with attribution, share-alike on derived
// databases. It carries 4,469 mapped data centres worldwide, including the
// hyperscale and major colocation operators.
//
//   public/data/datacentres.json       packed [lon, lat, tier, name] entries
//   public/data/datacentres.meta.json  provenance, method and caveats
//
// Usage: node scripts/fetch-datacentres.ts

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "data");

/**
 * Mirrors, tried in order. A single Overpass instance rate-limits and times out
 * under load often enough that depending on one makes this script unreliable
 * rather than merely slow.
 */
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];
const OVERPASS = OVERPASS_MIRRORS[0];
const QUERY = `[out:json][timeout:600];
(
  node["telecom"="data_center"];
  way["telecom"="data_center"];
);
out center tags;`;

/**
 * How "major" a facility is, derived from the data rather than a hand-written
 * list of favourite companies: an operator running many mapped sites is a
 * hyperscaler or a big colocation provider, and one running a single site is a
 * regional facility. Nothing here is a judgement about a specific building.
 */
// Plain constants, not a `const enum`: these scripts run under Node's type
// stripping, which erases annotations but cannot synthesise an enum object.
const TIER_REGIONAL = 0;
const TIER_SIGNIFICANT = 1;
const TIER_MAJOR = 2;

const SIGNIFICANT_AT = 10;
const MAJOR_AT = 50;

interface OverpassElement {
  type: "node" | "way";
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** `[lon, lat, tier, name]`; name may be empty when OSM has not recorded one. */
export type PackedDataCentre = [number, number, number, string];

function positionOf(element: OverpassElement): { lat: number; lon: number } | null {
  if (element.type === "node" && typeof element.lat === "number" && typeof element.lon === "number") {
    return { lat: element.lat, lon: element.lon };
  }
  if (element.center) return element.center;
  return null;
}

export function packDataCentres(elements: OverpassElement[]): PackedDataCentre[] {
  const operatorCounts = new Map<string, number>();
  for (const element of elements) {
    const operator = element.tags?.operator;
    if (operator) operatorCounts.set(operator, (operatorCounts.get(operator) ?? 0) + 1);
  }

  const packed: PackedDataCentre[] = [];
  for (const element of elements) {
    const position = positionOf(element);
    if (!position) continue;

    const tags = element.tags ?? {};
    const operator = tags.operator ?? "";
    const sites = operator ? (operatorCounts.get(operator) ?? 0) : 0;
    const tier = sites >= MAJOR_AT ? TIER_MAJOR : sites >= SIGNIFICANT_AT ? TIER_SIGNIFICANT : TIER_REGIONAL;

    // Prefer the facility's own name; fall back to the operator so a marker is
    // always nameable, which the destination picker depends on.
    const name = tags.name ?? operator ?? "";

    packed.push([
      Number(position.lon.toFixed(4)),
      Number(position.lat.toFixed(4)),
      tier,
      name.slice(0, 60),
    ]);
  }
  // Majors last so they paint over the regional ones where they overlap.
  packed.sort((a, b) => a[2] - b[2]);
  return packed;
}

async function queryOverpass(): Promise<{ elements: OverpassElement[] }> {
  let lastError = "";
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      process.stdout.write(`  querying ${new URL(mirror).host} …\n`);
      // Overpass answers 406 to fetch()'s default text/plain body; it wants the
      // query as a form field.
      const response = await fetch(mirror, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new URLSearchParams({ data: QUERY }),
        signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok) {
        lastError = `${mirror}: HTTP ${response.status}`;
        continue;
      }
      return (await response.json()) as { elements: OverpassElement[] };
    } catch (error) {
      lastError = `${mirror}: ${String(error)}`;
    }
  }
  throw new Error(`every Overpass mirror failed. Last: ${lastError}`);
}

async function main(): Promise<void> {
  const fromArg = process.argv.indexOf("--from");

  process.stdout.write("collecting telecom=data_center …\n");
  const body =
    fromArg > -1
      ? (JSON.parse(await readFile(process.argv[fromArg + 1], "utf8")) as { elements: OverpassElement[] })
      : await queryOverpass();
  if (!Array.isArray(body.elements) || body.elements.length === 0) {
    throw new Error("Overpass returned no data centres");
  }

  const centres = packDataCentres(body.elements);
  if (centres.length === 0) throw new Error("no data centres survived packing");

  await mkdir(OUT_DIR, { recursive: true });
  const json = JSON.stringify(centres);
  await writeFile(join(OUT_DIR, "datacentres.json"), json);

  const tiers = [0, 0, 0];
  for (const centre of centres) tiers[centre[2]]++;

  const meta = {
    source: "OpenStreetMap, telecom=data_center (nodes and building outlines)",
    sourceUrl: OVERPASS,
    licence:
      "© OpenStreetMap contributors, Open Database Licence (ODbL). Reuse with attribution; derived databases share alike.",
    fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    rejectedSource:
      "PeeringDB was evaluated and not used: its AUP reserves all rights and forbids bulk redistribution without prior permission.",
    count: centres.length,
    tiers: { major: tiers[2], significant: tiers[1], regional: tiers[0] },
    method:
      `Ways are reduced to their centroid. Tier is derived from how many mapped sites share an operator ` +
      `(${MAJOR_AT}+ major, ${SIGNIFICANT_AT}+ significant), which stands in for how large an operator is — ` +
      `it is not a judgement about an individual building.`,
    caveats: [
      "OpenStreetMap coverage is uneven: a region with no marker may be unmapped rather than empty.",
      "A centroid is the middle of a mapped outline, not the building entrance or the equipment inside it.",
      "Not every mapped site is a public cloud region; many are private or enterprise facilities.",
    ],
  };
  await writeFile(join(OUT_DIR, "datacentres.meta.json"), JSON.stringify(meta, null, 2) + "\n");

  process.stdout.write(
    `✓ public/data/datacentres.json: ${centres.length.toLocaleString("en-AU")} sites, ` +
      `${json.length.toLocaleString("en-AU")} bytes ` +
      `(${tiers[2]} major, ${tiers[1]} significant, ${tiers[0]} regional)\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
