#!/usr/bin/env node
// Vendors the geographic base map into public/data/ so nothing the globe draws
// depends on a third-party host at runtime.
//
// Everything here is Natural Earth (public domain, no attribution required
// though we give it anyway), pulled from the nvkelso/natural-earth-vector
// mirror because it publishes ready-made GeoJSON:
//
//   land-110m.geojson  coastline at 1:110m — the default silhouette, tiny
//   land-50m.geojson   coastline at 1:50m  — crisper, used when zoomed in
//   cities.json        populated places, packed to [lon, lat, popRank] triples
//
// Two size decisions worth not rediscovering:
//
//   * The raw ne_50m_land GeoJSON is ~1.6 MB, mostly wasted precision (14
//     decimal places on a dataset accurate to ~500 m) and properties the globe
//     never reads. Rounded to 4 dp with properties stripped it is ~1.26 MB and
//     pixel-identical at any zoom the prototype offers.
//   * The raw populated-places GeoJSON is ~4.9 MB for 7342 dots. As packed
//     [lon, lat, popRank] triples it is ~180 KB. City *names* are deliberately
//     not carried: the globe draws sparkling points, not a wall of labels.
//
// Re-run with `node scripts/fetch-geodata.ts`. The upstream changes rarely —
// this is a refresh path, not a build step.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "data");
const BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";

// Coordinates good to ~11 m. Natural Earth at these scales is nowhere near that
// accurate, so this throws away noise rather than detail.
const DP = 4;

type Position = [number, number];
type Ring = Position[];
type GeoJsonFeature = {
  type: "Feature";
  properties: Record<string, unknown> | null;
  geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
};
type FeatureCollection = { type: "FeatureCollection"; features: GeoJsonFeature[] };

type PlaceFeature = {
  properties: { scalerank?: number; pop_max?: number };
  geometry: { type: "Point"; coordinates: [number, number] };
};

/** One city as the globe wants it: [lon, lat, popRank]. */
export type PackedCity = [number, number, number];

function round(value: number, dp = DP): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

async function fetchJson<T>(url: string): Promise<{ value: T; text: string; bytes: number }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  return { value: JSON.parse(text) as T, text, bytes: Buffer.byteLength(text) };
}

function assertLandCollection(collection: FeatureCollection, label: string): void {
  if (collection.type !== "FeatureCollection") throw new Error(`${label}: not a FeatureCollection`);
  if (!Array.isArray(collection.features) || collection.features.length === 0) {
    throw new Error(`${label}: no features`);
  }
  for (const feature of collection.features) {
    const type = feature.geometry?.type;
    if (type !== "Polygon" && type !== "MultiPolygon") {
      throw new Error(`${label}: unexpected geometry ${String(type)}`);
    }
  }
}

/** Strips properties and rounds every position — the globe only wants outlines. */
export function shrinkLand(collection: FeatureCollection): FeatureCollection {
  const ring = (coords: Ring): Ring => coords.map(([lon, lat]) => [round(lon), round(lat)]);
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => ({
      type: "Feature",
      properties: {},
      geometry:
        feature.geometry.type === "Polygon"
          ? { type: "Polygon", coordinates: feature.geometry.coordinates.map(ring) }
          : { type: "MultiPolygon", coordinates: feature.geometry.coordinates.map((p) => p.map(ring)) },
    })),
  };
}

/**
 * popRank is a 0-10 "how big a dot" hint, high = bigger. It takes the larger of
 * two views so neither kind of city disappears: a population curve (roughly one
 * step per half order of magnitude, 1M ≈ 8, 10M ≈ 10) and Natural Earth's own
 * scalerank importance (inverted, so a small but significant capital still gets
 * a visible dot). Natural Earth writes -99 for unknown populations.
 */
export function popRank(props: { scalerank?: number; pop_max?: number }): number {
  const population = typeof props.pop_max === "number" && props.pop_max > 0 ? props.pop_max : 1;
  const byPopulation = Math.round((Math.log10(population) - 2) * 2);
  const byImportance = typeof props.scalerank === "number" ? 10 - props.scalerank : 0;
  return Math.min(10, Math.max(0, Math.max(byPopulation, byImportance)));
}

export function packCities(features: PlaceFeature[]): PackedCity[] {
  return features.map((feature) => {
    const [lon, lat] = feature.geometry.coordinates;
    return [round(lon, 2), round(lat, 2), popRank(feature.properties)];
  });
}

function write(name: string, contents: string): number {
  const path = join(OUT_DIR, name);
  writeFileSync(path, contents);
  return statSync(path).size;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  // 110m stays verbatim: it is already only ~135 KB and keeping it untouched
  // leaves one file in the repo that is byte-for-byte the upstream dataset.
  const land110 = await fetchJson<FeatureCollection>(`${BASE}/ne_110m_land.geojson`);
  assertLandCollection(land110.value, "ne_110m_land");
  const size110 = write("land-110m.geojson", land110.text);
  console.log(`✓ public/data/land-110m.geojson: ${land110.value.features.length} features, ${size110} bytes`);

  const land50 = await fetchJson<FeatureCollection>(`${BASE}/ne_50m_land.geojson`);
  assertLandCollection(land50.value, "ne_50m_land");
  const shrunk = shrinkLand(land50.value);
  const size50 = write("land-50m.geojson", JSON.stringify(shrunk));
  console.log(
    `✓ public/data/land-50m.geojson: ${shrunk.features.length} features, ${size50} bytes (from ${land50.bytes})`,
  );

  const places = await fetchJson<{ features: PlaceFeature[] }>(
    `${BASE}/ne_10m_populated_places_simple.geojson`,
  );
  const cities = packCities(places.value.features);
  if (cities.length === 0) throw new Error("populated places came back empty");
  const sizeCities = write("cities.json", JSON.stringify(cities));
  console.log(
    `✓ public/data/cities.json: ${cities.length} cities, ${sizeCities} bytes (from ${places.bytes})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
