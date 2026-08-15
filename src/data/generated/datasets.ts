// The vendored datasets, and how to load them.
//
// Everything here lives in public/data/ and is produced by scripts/fetch-*.ts —
// nothing in this file is hand-maintained, and nothing the app draws reaches a
// third-party host at runtime.
//
// Vite is configured with `base: "./"` so the site can be served from a GitHub
// Pages subpath. That makes an absolute "/data/x" fetch wrong the moment the
// site is deployed, which is exactly the kind of bug that only shows up after
// you push. Always route through `dataUrl()`.

/** Resolves a vendored dataset against the deployed base path. */
export function dataUrl(file: string): string {
  return new URL(`data/${file}`, new URL(import.meta.env.BASE_URL, window.location.href)).href;
}

/** What scripts/fetch-starlink.ts records about the snapshot on disk. */
export type StarlinkMeta = {
  source: string;
  sourceUrl: string;
  /** ISO 8601 UTC. The elements are a snapshot from this moment, not live. */
  fetchedAt: string;
  satelliteCount: number;
  note: string;
};

/** One satellite's published two-line element set. */
export type TleRecord = { name: string; line1: string; line2: string };

/**
 * A city as a packed triple: `[lon, lat, popRank]`, lon/lat in degrees rounded
 * to 2 dp, popRank 0-10 where 10 is a megacity and 0 a hamlet. Names are not
 * carried — the globe draws points, not labels.
 */
export type PackedCity = [lon: number, lat: number, popRank: number];

/** Land polygons: a GeoJSON FeatureCollection of Polygon/MultiPolygon. */
export type LandCollection = {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    geometry:
      | { type: "Polygon"; coordinates: [number, number][][] }
      | { type: "MultiPolygon"; coordinates: [number, number][][][] };
  }[];
};

async function fetchJson<T>(file: string): Promise<T> {
  const response = await fetch(dataUrl(file));
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Splits the vendored TLE text into name/line1/line2 triples. */
export function parseTle(text: string): TleRecord[] {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const records: TleRecord[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    records.push({ name: lines[i], line1: lines[i + 1], line2: lines[i + 2] });
  }
  return records;
}

export async function loadStarlink(): Promise<{ meta: StarlinkMeta; satellites: TleRecord[] }> {
  const [meta, text] = await Promise.all([
    fetchJson<StarlinkMeta>("starlink.meta.json"),
    fetch(dataUrl("starlink.tle")).then((r) => r.text()),
  ]);
  return { meta, satellites: parseTle(text) };
}

/** `"110m"` is the calm default (~135 KB); `"50m"` is the crisper coastline (~1.2 MB). */
export function loadLand(detail: "110m" | "50m" = "110m"): Promise<LandCollection> {
  return fetchJson<LandCollection>(`land-${detail}.geojson`);
}

export function loadCities(): Promise<PackedCity[]> {
  return fetchJson<PackedCity[]>("cities.json");
}
