#!/usr/bin/env node
// Vendors the submarine cable network into public/data/ so the deployed site
// never has to call a third-party host at runtime — same rule as the Starlink
// catalogue, same reason: a marked prototype must not go blank because someone
// else's CDN is having a bad day.
//
// The data is TeleGeography's Submarine Cable Map, which is where essentially
// every web visualisation of the cable network gets its geometry. It is also
// where geotraceroute.com gets its cable paths: that site credits
// submarinecablemap.com in its About panel and ships a self-hosted
// `world/cables-full.json` whose cable and landing ids ("2africa",
// "luanda-angola") are TeleGeography's slugs verbatim.
//
// TeleGeography used to publish these files in a public GitHub repository
// (telegeography/www.submarinecablemap.com, GeoJSON under web/public/api/v3/).
// That repo is gone — the API now 404s and their FAQ says plainly "We no longer
// maintain or update a GitHub repository for our data or source code" — so we
// read the same v3 endpoints from the live site instead. The paths are the ones
// the repo used to mirror, so the shape is unchanged.
//
// IMPORTANT — this is stylised geography. TeleGeography's own FAQ: "The cable
// routes on our map are stylized and do not reflect the precise geolocation of
// systems." The app must never present these lines as a surveyed seabed path or
// as the measured route of a real packet. See cables.meta.json's `note`.
//
// Re-run with `node scripts/fetch-cables.ts` to refresh. Cables are added and
// retired steadily, so this ages far more gracefully than a TLE — a refresh once
// a term is plenty.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "data");
const CABLES_PATH = join(OUT_DIR, "cables.geojson");
const LANDINGS_PATH = join(OUT_DIR, "cable-landings.json");
const META_PATH = join(OUT_DIR, "cables.meta.json");

const API = "https://www.submarinecablemap.com/api/v3";
const CABLE_URL = `${API}/cable/cable-geo.json`;
const LANDING_URL = `${API}/landing-point/landing-point-geo.json`;

// A default curl/node agent gets through today, but the site is behind a CDN
// that has historically been picky, and a 403 dressed as HTML is the failure
// mode we most want to catch loudly rather than write to disk.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** A cable route as TeleGeography publishes it. Coordinates are [lon, lat]. */
export type CableFeature = {
  type: "Feature";
  properties: { id: string; name: string; color?: string; feature_id?: string };
  geometry:
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "MultiLineString"; coordinates: [number, number][][] };
};

export type LandingFeature = {
  type: "Feature";
  properties: { id: string; name: string; is_tbd?: boolean };
  geometry: { type: "Point"; coordinates: [number, number] };
};

type FeatureCollection<F> = { type: "FeatureCollection"; features: F[] };

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json,*/*" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);

  // A CDN error page is served as 200 HTML often enough that parsing is the
  // real check — a JSON.parse failure here means we were handed a block page.
  const text = await response.text();
  if (text.trim().length === 0) throw new Error(`${url}: empty body`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${url}: response is not JSON (first 120 chars: ${text.trim().slice(0, 120)})`);
  }
}

/** Rejects anything that isn't a populated FeatureCollection of the expected geometry. */
export function checkCollection<F extends { geometry?: { type?: string } }>(
  label: string,
  data: FeatureCollection<F>,
  geometryTypes: string[],
  minimum: number,
): F[] {
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    throw new Error(`${label}: not a GeoJSON FeatureCollection — bad response`);
  }
  if (data.features.length < minimum) {
    throw new Error(`${label}: only ${data.features.length} features, expected at least ${minimum}`);
  }
  const wrong = data.features.find((f) => !geometryTypes.includes(String(f.geometry?.type)));
  if (wrong) {
    throw new Error(`${label}: unexpected geometry ${JSON.stringify(wrong.geometry?.type)}`);
  }
  return data.features;
}

/** Landing points packed to `[lon, lat]` at 2 dp and de-duplicated. */
export function packLandings(features: LandingFeature[]): [number, number][] {
  const seen = new Set<string>();
  const packed: [number, number][] = [];
  for (const feature of features) {
    const [lon, lat] = feature.geometry.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const pair: [number, number] = [round(lon, 2), round(lat, 2)];
    const key = `${pair[0]},${pair[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packed.push(pair);
  }
  return packed;
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

async function main(): Promise<void> {
  const [cableData, landingData] = await Promise.all([
    fetchJson<FeatureCollection<CableFeature>>(CABLE_URL),
    fetchJson<FeatureCollection<LandingFeature>>(LANDING_URL),
  ]);

  // Thresholds are "a bad response, not a small network" guards. The real
  // counts are ~724 cables and ~1900 landings; well under half of that means
  // something upstream broke.
  const cables = checkCollection("cable-geo", cableData, ["LineString", "MultiLineString"], 300);
  const landings = checkCollection("landing-point-geo", landingData, ["Point"], 800);

  const packed = packLandings(landings);
  if (packed.length < 800) {
    throw new Error(`only ${packed.length} usable landing points after packing — bad response`);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  // Written compact and verbatim: at ~740 KB the full-precision geometry is
  // cheaper than the land-50m coastline we already ship, so there is nothing to
  // gain by rounding it and losing fidelity on tight coastal approaches.
  writeFileSync(CABLES_PATH, `${JSON.stringify({ type: "FeatureCollection", features: cables })}\n`);
  writeFileSync(LANDINGS_PATH, `${JSON.stringify(packed)}\n`);
  writeFileSync(
    META_PATH,
    `${JSON.stringify(
      {
        source: "TeleGeography Submarine Cable Map (API v3)",
        sourceUrl: CABLE_URL,
        fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        cableCount: cables.length,
        landingCount: packed.length,
        licence:
          "TeleGeography publishes the Submarine Cable Map under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0): the map may be used in other work provided TeleGeography is credited. Their commercial geocoded dataset is separately licensed; this snapshot uses only the openly published map API.",
        note: "Published cable routes are indicative geography, not exact seabed survey lines.",
        geotracerouteFinding:
          "geotraceroute.com credits submarinecablemap.com for its submarine cable data and serves a self-hosted copy at /world/cables-full.json whose cable and landing ids are TeleGeography's slugs verbatim, so it is the same upstream dataset.",
      },
      null,
      2,
    )}\n`,
  );

  console.log(`✓ public/data/cables.geojson: ${cables.length} cables from ${CABLE_URL}`);
  console.log(`✓ public/data/cable-landings.json: ${packed.length} landing points (${landings.length} before dedupe)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
