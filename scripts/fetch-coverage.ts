#!/usr/bin/env node
// Builds the two coverage masks the globe uses to answer "can a request start
// here?" for any lat/lon, plus the Starlink gateway points.
//
// The globe needs that answer on every pointer-move frame, so the runtime shape
// is a bitmap, not geometry: one equirectangular grid at 0.25° (1440 × 720),
// one bit per cell, packed 8 cells to a byte and base64'd. Lookup is then two
// divisions and a bit test — see decodeMask() in src/data/generated/coverage.ts.
// Doing point-in-polygon against land at pointer speed would not survive
// contact with a 1.2 MB coastline.
//
//   mobile    where the simplified 5G/mobile model says a request can begin
//   starlink  where Starlink is licensed and within the consumer service band
//
// Neither mask is an operator coverage map, and the meta file says so in words.
// The mobile mask especially: there is no free global 5G-coverage polygon
// dataset, so this is a model built from real population geography —
//
//   land ∧ (near a populated place ∨ inside an urban area) ∧ not Antarctica
//
// — which is the brief's own simplification ("the prototype may assume that
// most populated areas have mobile coverage"). It gets the shape of the truth
// right: continuous across Europe, India, eastern China and the US coasts;
// thinning to nothing across the Sahara, the Amazon interior, Siberia,
// Greenland and central Australia. It will be wrong about any individual
// address, which is why the UI must never phrase it as "you have 5G here".
//
// The Starlink mask is on firmer ground: starlink.com publishes the same
// per-country status file its own availability map reads, keyed by ISO 3166-1
// alpha-2. We take status `available` or `launched` as serviced and vendor the
// resulting list as a dated snapshot. Two knowing simplifications:
//
//   * Countries the file marks `exclude` (CY, GE, UA) are excluded from the
//     admin0 layer only because Starlink draws them with sub-national polygons
//     to geofence occupied territory. Those polygons are keyed by opaque
//     Mapbox boundary ids we cannot resolve, so we treat those countries as
//     serviced at the national level. The mask is coarser than the real
//     licensing map there.
//   * Country shapes come from Natural Earth 1:110m, so coastlines are blunt.
//     A ~55 km dilation adds the near-shore band, since Starlink works on a
//     boat just off the beach.
//
// The gateway list is the one genuinely unofficial input here — see the comment
// above GATEWAYS_URL for why no authoritative source is reachable.
//
// Re-run with `node scripts/fetch-coverage.ts`. Land and cities are read from
// the files scripts/fetch-geodata.ts already vendored — this script never
// refetches them.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "data");
const NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";

const URBAN_URL = `${NE}/ne_10m_urban_areas.geojson`;
const COUNTRIES_URL = `${NE}/ne_110m_admin_0_countries.geojson`;
// The file starlink.com/map itself reads. Keys are ISO 3166-1 alpha-2.
const AVAILABILITY_URL = "https://www.starlink.com/public-files/availability.json";

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/** Cells across: 360° / 0.25°. */
export const WIDTH = 1440;
/** Cells down: 180° / 0.25°. */
export const HEIGHT = 720;
/** Degrees per cell, both axes. */
export const CELL = 0.25;
/** Row 0 is +90° lat, column 0 is -180° lon, row-major, MSB first. */
export const MASK_BYTES = (WIDTH * HEIGHT) / 8;

/** Mean degrees of latitude per kilometre — good enough at this resolution. */
const KM_PER_DEGREE = 111.32;

/** Latitude at the centre of a row. */
export function rowLat(row: number): number {
  return 90 - (row + 0.5) * CELL;
}

export function createMask(): Uint8Array {
  return new Uint8Array(MASK_BYTES);
}

export function setCell(mask: Uint8Array, row: number, col: number): void {
  if (row < 0 || row >= HEIGHT) return;
  const wrapped = ((col % WIDTH) + WIDTH) % WIDTH;
  const bit = row * WIDTH + wrapped;
  mask[bit >> 3] |= 0x80 >> (bit & 7);
}

export function getCell(mask: Uint8Array, row: number, col: number): boolean {
  if (row < 0 || row >= HEIGHT) return false;
  const wrapped = ((col % WIDTH) + WIDTH) % WIDTH;
  const bit = row * WIDTH + wrapped;
  return (mask[bit >> 3] & (0x80 >> (bit & 7))) !== 0;
}

/** Fills a whole run of columns in one row. Inclusive of both ends. */
function setSpan(mask: Uint8Array, row: number, fromCol: number, toCol: number): void {
  for (let col = fromCol; col <= toCol; col += 1) setCell(mask, row, col);
}

export function countCells(mask: Uint8Array): number {
  let total = 0;
  for (const byte of mask) {
    // Popcount by nibble lookup — this runs over 129,600 bytes a few times.
    total += POPCOUNT[byte >> 4] + POPCOUNT[byte & 0xf];
  }
  return total;
}

const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** The lookup the browser will do, mirrored here so spot-checks test the real thing. */
export function maskHas(mask: Uint8Array, lat: number, lon: number): boolean {
  const row = Math.floor((90 - lat) / CELL);
  const col = Math.floor((lon + 180) / CELL);
  return getCell(mask, row, col);
}

// ---------------------------------------------------------------------------
// Rasterising polygons
// ---------------------------------------------------------------------------

type Position = [number, number];
type Ring = Position[];
/** Outer ring first, then interior rings (holes). */
type Polygon = Ring[];
type Geometry =
  | { type: "Polygon"; coordinates: Ring[] }
  | { type: "MultiPolygon"; coordinates: Ring[][] };
type Feature<P> = { type: "Feature"; properties: P; geometry: Geometry | null };
type FeatureCollection<P> = { type: "FeatureCollection"; features: Feature<P>[] };

export function polygonsOf(geometry: Geometry | null): Polygon[] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

/**
 * Scanline even-odd fill of one polygon, holes included.
 *
 * This is the standard even-odd point-in-polygon test, evaluated a whole row at
 * a time instead of a cell at a time: for the row's centre latitude, find every
 * edge that straddles it, sort the crossing longitudes, and fill between
 * alternate pairs. A cell is inside exactly when an odd number of edges lie to
 * its left, which is the same predicate — but it costs one pass over the edges
 * per row rather than one per cell, and a hole's edges add their crossings
 * naturally, so interior rings carve themselves out with no special case.
 *
 * Every ring of the polygon must be handled in the same pass for that to hold,
 * which is why this takes a polygon rather than a ring.
 *
 * Natural Earth cuts its geometry at the antimeridian, so no edge wraps and
 * there is no seam case to handle.
 */
export function fillPolygon(mask: Uint8Array, polygon: Polygon): void {
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const ring of polygon) {
    for (const [, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLat)) return;

  // Rows whose centre can fall inside this polygon's latitude range.
  const firstRow = Math.max(0, Math.floor((90 - maxLat) / CELL) - 1);
  const lastRow = Math.min(HEIGHT - 1, Math.ceil((90 - minLat) / CELL) + 1);

  const crossings: number[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    const lat = rowLat(row);
    crossings.length = 0;

    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [x1, y1] = ring[j];
        const [x2, y2] = ring[i];
        // Half-open comparison: a vertex exactly on the scanline counts once,
        // and a horizontal edge contributes nothing.
        if (y1 > lat !== y2 > lat) {
          crossings.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }
    if (crossings.length < 2) continue;

    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      // Cell centres strictly inside the span. A span narrower than a cell
      // covers no centre and drops out, which is correct at this resolution.
      const from = Math.ceil((crossings[k] + 180) / CELL - 0.5);
      const to = Math.floor((crossings[k + 1] + 180) / CELL - 0.5);
      if (to >= from) setSpan(mask, row, Math.max(0, from), Math.min(WIDTH - 1, to));
    }
  }
}

export function fillFeatures<P>(
  mask: Uint8Array,
  features: Feature<P>[],
  keep: (properties: P) => boolean = () => true,
): void {
  for (const feature of features) {
    if (!keep(feature.properties)) continue;
    for (const polygon of polygonsOf(feature.geometry)) fillPolygon(mask, polygon);
  }
}

// ---------------------------------------------------------------------------
// Discs
// ---------------------------------------------------------------------------

/**
 * Paints a disc of the given radius in kilometres around a point.
 *
 * A cell is a fixed 0.25° both ways, but 0.25° of longitude is only 27.8 km at
 * the equator and 9.6 km at 70°N. Ignoring that would draw Norwegian towns with
 * three times the reach of Kenyan ones. So the column half-width is recomputed
 * for each row from that row's own latitude.
 */
export function paintDisc(mask: Uint8Array, lat: number, lon: number, radiusKm: number): void {
  const radiusLat = radiusKm / KM_PER_DEGREE;
  const firstRow = Math.max(0, Math.floor((90 - (lat + radiusLat)) / CELL));
  const lastRow = Math.min(HEIGHT - 1, Math.ceil((90 - (lat - radiusLat)) / CELL));

  for (let row = firstRow; row <= lastRow; row += 1) {
    const rowCentre = rowLat(row);
    const northSouthKm = Math.abs(rowCentre - lat) * KM_PER_DEGREE;
    if (northSouthKm > radiusKm) continue;
    const eastWestKm = Math.sqrt(radiusKm * radiusKm - northSouthKm * northSouthKm);
    // Clamped so a disc near the pole widens without diverging.
    const shrink = Math.max(0.05, Math.cos((rowCentre * Math.PI) / 180));
    const halfLon = eastWestKm / (KM_PER_DEGREE * shrink);

    const from = Math.ceil((lon - halfLon + 180) / CELL - 0.5);
    const to = Math.floor((lon + halfLon + 180) / CELL - 0.5);
    // setCell wraps the column, so a disc straddling the antimeridian is fine.
    if (to >= from) setSpan(mask, row, from, to);
  }
}

/**
 * Grows a mask outwards by roughly the given distance, so a coastline-derived
 * mask reaches a little way offshore. Done as two separable passes (rows, then
 * columns) — an approximation of a true disc dilation, but the error is under a
 * cell and this runs in milliseconds instead of seconds.
 */
export function dilate(mask: Uint8Array, distanceKm: number): Uint8Array {
  const grown = createMask();
  const rowRadius = Math.round(distanceKm / KM_PER_DEGREE / CELL);

  // Vertical, into a scratch mask.
  const vertical = createMask();
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let col = 0; col < WIDTH; col += 1) {
      if (!getCell(mask, row, col)) continue;
      for (let d = -rowRadius; d <= rowRadius; d += 1) setCell(vertical, row + d, col);
    }
  }

  // Horizontal, with the column radius recomputed per row for convergence.
  for (let row = 0; row < HEIGHT; row += 1) {
    const shrink = Math.max(0.05, Math.cos((rowLat(row) * Math.PI) / 180));
    const colRadius = Math.round(distanceKm / (KM_PER_DEGREE * shrink) / CELL);
    for (let col = 0; col < WIDTH; col += 1) {
      if (!getCell(vertical, row, col)) continue;
      setSpan(grown, row, col - colRadius, col + colRadius);
    }
  }
  return grown;
}

// ---------------------------------------------------------------------------
// Mask algebra
// ---------------------------------------------------------------------------

export function and(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = createMask();
  for (let i = 0; i < MASK_BYTES; i += 1) out[i] = a[i] & b[i];
  return out;
}

export function or(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = createMask();
  for (let i = 0; i < MASK_BYTES; i += 1) out[i] = a[i] | b[i];
  return out;
}

/** Clears every cell outside the given latitude band. */
export function clampLatitude(mask: Uint8Array, minLat: number, maxLat: number): Uint8Array {
  const out = createMask();
  out.set(mask);
  for (let row = 0; row < HEIGHT; row += 1) {
    const lat = rowLat(row);
    if (lat >= minLat && lat <= maxLat) continue;
    out.fill(0, (row * WIDTH) / 8, ((row + 1) * WIDTH) / 8);
  }
  return out;
}

export function toBase64(mask: Uint8Array): string {
  return Buffer.from(mask).toString("base64");
}

// ---------------------------------------------------------------------------
// Model parameters — the knobs that decide what the mobile mask looks like
// ---------------------------------------------------------------------------

/** popRank 0 (a hamlet) reaches ~40 km; popRank 10 (a megacity) ~180 km. */
export function cityRadiusKm(popRank: number): number {
  const rank = Math.min(10, Math.max(0, popRank));
  return 40 + rank * 14;
}

/** Antarctica and the deep Southern Ocean are out of the simplified model. */
const MOBILE_MIN_LAT = -60;

/**
 * Consumer Starlink terminals are sold and supported within roughly ±70°.
 * Higher latitudes are served in places but the constellation's coverage there
 * is not something this prototype should imply.
 */
const STARLINK_LAT_LIMIT = 70;

/** How far offshore the Starlink mask reaches past a 110m coastline. */
const STARLINK_NEARSHORE_KM = 55;

/** starlink.com statuses that mean a customer can order service today. */
const SERVICED_STATUSES = new Set(["available", "launched"]);

/**
 * Countries the availability file drops from its admin0 layer because it draws
 * them with sub-national polygons instead (to geofence occupied territory).
 * They are serviced; we just cannot reproduce the sub-national detail, so they
 * are treated as serviced nationwide and the meta records the simplification.
 */
const ADMIN1_COUNTRIES = new Set(["CY", "GE", "UA"]);

/**
 * Natural Earth codes two de-facto states as -99. Both sit inside a parent the
 * availability file does know about.
 */
const ISO_FALLBACK: Record<string, string> = { CYN: "CY", SOL: "SO" };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

type CountryProperties = { NAME: string; ISO_A2: string; ISO_A2_EH: string; ADM0_A3: string };
type AvailabilityFile = { admin0: Record<string, { status: string }> };
type PackedCity = [lon: number, lat: number, popRank: number];

export function countryIsoA2(properties: CountryProperties): string | null {
  for (const candidate of [properties.ISO_A2_EH, properties.ISO_A2]) {
    if (candidate && candidate !== "-99") return candidate;
  }
  return ISO_FALLBACK[properties.ADM0_A3] ?? null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json,*/*" },
    // The 10m urban areas file is ~28 MB.
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function readJson<T>(name: string): T {
  const path = join(OUT_DIR, name);
  if (!existsSync(path)) {
    throw new Error(`${name} is missing — run \`node scripts/fetch-geodata.ts\` first`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function write(name: string, contents: string): number {
  const path = join(OUT_DIR, name);
  writeFileSync(path, contents);
  return statSync(path).size;
}

// ---------------------------------------------------------------------------
// Starlink gateways
// ---------------------------------------------------------------------------

/**
 * Where the gateway coordinates come from.
 *
 * SpaceX publishes no gateway register. The regulator sources that would be
 * authoritative are not usable from a script: the FCC's IBFS search answers a
 * non-browser client with 403, and Australia's ACMA mirror withholds
 * coordinates outright because its licence conditions reserve them.
 *
 * What is available is Mike Puchol's Starlink Coverage Tracker (starlink.sx),
 * the long-running community register that reconstructs gateway sites from FCC
 * filings, satellite imagery and field reports. It is unofficial and explicitly
 * not affiliated with SpaceX, and some of its entries are flagged as
 * unconfirmed — we drop those. It is also served without CORS headers, which
 * settles the question of whether to fetch it at runtime: we cannot, so it is
 * vendored here like every other dataset.
 *
 * Nothing is invented. Every coordinate in the output file came out of that
 * feed; sites the feed itself could not confirm are filtered out below.
 */
const GATEWAYS_URL = "https://starlink.sx/gateways.json";

type GatewayRecord = { town?: string; notes?: string; freq?: string; lat?: number; lng?: number };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Reduces the feed to the [lon, lat] pairs the globe draws.
 *
 * Three filters, each for a stated reason:
 *
 *   * `freq === "TTC"` marks telemetry/tracking/command stations (Tromsø,
 *     Brewster, Awarua, Córdoba). They talk to the satellites but carry no user
 *     traffic, so drawing them as ground stations would misteach the route.
 *   * A blank `town` is how the feed marks a site it has heard about but not
 *     confirmed — its own `notes` say "Reported, unconfirmed".
 *   * 2 dp (~1 km) because these are real facilities on real private land, the
 *     globe only ever draws a dot, and more precision than the reconstruction
 *     actually has would be fake precision.
 *
 * Rounding merges a handful of near-neighbours, so the result is deduplicated.
 */
export function packGateways(records: GatewayRecord[]): [number, number][] {
  const seen = new Set<string>();
  const packed: [number, number][] = [];
  for (const record of records) {
    if (record.freq === "TTC") continue;
    if (!record.town || record.town.trim() === "") continue;
    if (!Number.isFinite(record.lat) || !Number.isFinite(record.lng)) continue;
    const lon = round2(record.lng as number);
    const lat = round2(record.lat as number);
    const key = `${lon},${lat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packed.push([lon, lat]);
  }
  return packed;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

type Report = { name: string; coveredCells: number; percentOfGrid: number };

function describe(name: string, mask: Uint8Array): Report {
  const coveredCells = countCells(mask);
  return {
    name,
    coveredCells,
    percentOfGrid: round2((coveredCells / (WIDTH * HEIGHT)) * 100),
  };
}

const SPOT_CHECKS: [string, number, number][] = [
  ["London", 51.5, -0.13],
  ["Sydney", -33.87, 151.21],
  ["central Sahara", 23, 13],
  ["Amazon interior", -4, -63],
  ["central Greenland", 72, -40],
  ["mid-Pacific", 0, -140],
  ["Antarctica", -80, 0],
  ["Siberia interior", 66, 105],
  ["Beijing", 39.9, 116.4],
  ["Moscow", 55.75, 37.6],
  ["Tokyo", 35.68, 139.69],
  ["Nairobi", -1.29, 36.82],
];

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // --- Land, from the already-vendored coastline -------------------------
  console.log("· rasterising land from public/data/land-50m.geojson");
  const land = readJson<FeatureCollection<unknown>>("land-50m.geojson");
  const landMask = createMask();
  fillFeatures(landMask, land.features);
  const landCells = countCells(landMask);
  if (landCells < 100_000) throw new Error(`only ${landCells} land cells — the land raster is wrong`);

  // --- Populated places, from the already-vendored cities -----------------
  console.log("· painting reach discs around populated places");
  const cities = readJson<PackedCity[]>("cities.json");
  const cityMask = createMask();
  for (const [lon, lat, popRank] of cities) paintDisc(cityMask, lat, lon, cityRadiusKm(popRank));

  // --- Urban areas --------------------------------------------------------
  console.log("· fetching Natural Earth urban areas (~28 MB)");
  const urban = await fetchJson<FeatureCollection<unknown>>(URBAN_URL);
  if (urban.features.length < 1000) throw new Error("urban areas came back suspiciously empty");
  const urbanMask = createMask();
  fillFeatures(urbanMask, urban.features);

  // land ∧ (near a city ∨ urban) ∧ not Antarctica
  const mobileMask = clampLatitude(and(landMask, or(cityMask, urbanMask)), MOBILE_MIN_LAT, 90);

  // --- Starlink -----------------------------------------------------------
  console.log("· fetching starlink.com availability statuses");
  const availability = await fetchJson<AvailabilityFile>(AVAILABILITY_URL);
  const statuses = availability.admin0;
  if (!statuses || Object.keys(statuses).length < 100) {
    throw new Error("availability file has no usable admin0 layer");
  }

  const serviced = new Set(
    Object.entries(statuses)
      .filter(([, value]) => SERVICED_STATUSES.has(value.status))
      .map(([code]) => code),
  );
  for (const code of ADMIN1_COUNTRIES) serviced.add(code);

  console.log("· rasterising serviced countries");
  const countries = await fetchJson<FeatureCollection<CountryProperties>>(COUNTRIES_URL);
  const unmatched: string[] = [];
  const servicedMask = createMask();
  fillFeatures(servicedMask, countries.features, (properties) => {
    const iso = countryIsoA2(properties);
    if (!iso) {
      unmatched.push(properties.NAME);
      return false;
    }
    if (!(iso in statuses) && !ADMIN1_COUNTRIES.has(iso)) unmatched.push(`${properties.NAME} (${iso})`);
    return serviced.has(iso);
  });

  const starlinkMask = clampLatitude(
    dilate(servicedMask, STARLINK_NEARSHORE_KM),
    -STARLINK_LAT_LIMIT,
    STARLINK_LAT_LIMIT,
  );

  // --- Write --------------------------------------------------------------
  const coverageBytes = write(
    "coverage.json",
    `${JSON.stringify({
      width: WIDTH,
      height: HEIGHT,
      masks: { mobile: toBase64(mobileMask), starlink: toBase64(starlinkMask) },
    })}\n`,
  );

  console.log("· fetching community-mapped Starlink gateway sites");
  const gatewayFeed = await fetchJson<GatewayRecord[]>(GATEWAYS_URL);
  if (!Array.isArray(gatewayFeed) || gatewayFeed.length < 100) {
    throw new Error("gateway feed came back too short to be the real register");
  }
  const gateways = packGateways(gatewayFeed);
  const gatewayBytes = write("starlink-gateways.json", `${JSON.stringify(gateways)}\n`);

  const servicedList = [...serviced].sort();
  const metaBytes = write(
    "coverage.meta.json",
    `${JSON.stringify(
      {
        fetchedAt,
        grid: {
          width: WIDTH,
          height: HEIGHT,
          degreesPerCell: CELL,
          projection: "equirectangular, row 0 = +90° lat, column 0 = -180° lon",
          encoding: "1 bit per cell, packed 8 cells per byte MSB-first, row-major, then base64",
        },
        masks: {
          mobile: {
            model:
              "Simplified educational model of where a mobile/5G request can plausibly begin. NOT an operator coverage map — no free global 5G coverage dataset exists, and this makes no claim about any individual address.",
            method:
              "land ∧ (within a population-scaled radius of a populated place ∨ inside a mapped urban area) ∧ latitude > -60°",
            inputs: [
              "public/data/land-50m.geojson (Natural Earth 1:50m land, already vendored)",
              "public/data/cities.json (Natural Earth 1:10m populated places, already vendored)",
              URBAN_URL,
            ],
            cityRadiusKm: { popRank0: cityRadiusKm(0), popRank10: cityRadiusKm(10) },
            antarcticaExcludedBelowLat: MOBILE_MIN_LAT,
            coveredCells: countCells(mobileMask),
            landCells,
            percentOfLandCovered: round2((countCells(and(mobileMask, landMask)) / landCells) * 100),
          },
          starlink: {
            model:
              "Where Starlink consumer service is licensed, at country resolution. A dated snapshot of a published status list, not a live availability check and not a link-budget model.",
            method:
              "country marked available/launched by starlink.com ∧ (land ∨ within ~55 km offshore) ∧ |latitude| ≤ 70°",
            inputs: [AVAILABILITY_URL, COUNTRIES_URL],
            statusSource: AVAILABILITY_URL,
            statusSourceNote:
              "The same per-country status file starlink.com/map reads. Keys are ISO 3166-1 alpha-2. Statuses treated as serviced: available, launched.",
            servicedCountryCount: servicedList.length,
            servicedCountries: servicedList,
            countriesTreatedAsServicedDespiteAdmin1Geofencing: [...ADMIN1_COUNTRIES].sort(),
            admin1Caveat:
              "starlink.com marks CY, GE and UA `exclude` at country level because it draws them with sub-national polygons to geofence occupied territory. Those polygons are keyed by opaque Mapbox boundary ids, so this mask treats those countries as serviced nationwide — coarser than the real licensing map.",
            latitudeLimit: STARLINK_LAT_LIMIT,
            nearShoreKm: STARLINK_NEARSHORE_KM,
            countryGeometry: "Natural Earth 1:110m — blunt coastlines, hence the near-shore dilation",
            coveredCells: countCells(starlinkMask),
            percentOfLandCovered: round2((countCells(and(starlinkMask, landMask)) / landCells) * 100),
            unmatchedCountries: unmatched,
          },
        },
        gateways: {
          file: "starlink-gateways.json",
          count: gateways.length,
          format: "[lon, lat] pairs, degrees, rounded to 2 dp (~1 km)",
          model:
            "Community-mapped Starlink gateway (ground station) sites — unofficial, partial, and a snapshot. These are user-traffic gateways only, not internet peering points and not telemetry stations.",
          source: "Starlink Coverage Tracker by Mike Puchol (starlink.sx), not affiliated with SpaceX",
          sourceUrl: GATEWAYS_URL,
          sourceRecords: gatewayFeed.length,
          derivedFrom:
            "The tracker reconstructs sites from FCC earth-station filings, satellite imagery and field reports. SpaceX publishes no gateway register, and the regulator databases that would be authoritative are not machine-readable (FCC IBFS blocks non-browser clients; ACMA withholds coordinates).",
          filters: [
            "Dropped freq=TTC entries — telemetry/tracking/command stations carry no user traffic.",
            "Dropped entries with a blank town, which is how the feed marks sites it lists as reported but unconfirmed.",
            "Deduplicated after rounding to 2 dp.",
          ],
          caveats: [
            "Unofficial and incomplete — SpaceX brings new gateways online continuously and the feed lags.",
            "Positions represent the served locality at ~1 km, not a surveyed antenna position.",
            "No coordinate is invented; every point came from the feed above.",
          ],
        },
      },
      null,
      2,
    )}\n`,
  );

  // --- Report -------------------------------------------------------------
  const mobileReport = describe("mobile", mobileMask);
  const starlinkReport = describe("starlink", starlinkMask);
  const percentOfLand = round2((countCells(and(mobileMask, landMask)) / landCells) * 100);

  console.log(`\n✓ public/data/coverage.json: ${coverageBytes} bytes`);
  console.log(`✓ public/data/coverage.meta.json: ${metaBytes} bytes`);
  console.log(`✓ public/data/starlink-gateways.json: ${gateways.length} sites, ${gatewayBytes} bytes`);
  console.log(`\nland cells: ${landCells}`);
  console.log(`mobile:   ${mobileReport.coveredCells} cells, ${percentOfLand}% of land`);
  const starlinkOfLand = round2((countCells(and(starlinkMask, landMask)) / landCells) * 100);
  console.log(
    `starlink: ${starlinkReport.coveredCells} cells, ${starlinkOfLand}% of land, ${starlinkReport.percentOfGrid}% of grid`,
  );
  console.log(`serviced countries: ${servicedList.length}`);
  if (unmatched.length > 0) console.log(`unmatched country codes: ${unmatched.join(", ")}`);

  console.log("\nspot checks              mobile  starlink");
  for (const [label, lat, lon] of SPOT_CHECKS) {
    const mobile = maskHas(mobileMask, lat, lon);
    const starlink = maskHas(starlinkMask, lat, lon);
    console.log(`  ${label.padEnd(20)} ${String(mobile).padEnd(7)} ${String(starlink)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
