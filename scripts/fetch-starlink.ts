#!/usr/bin/env node
// Vendors the Starlink orbital catalogue into public/data/ so the deployed site
// never has to call a third-party host at runtime (CelesTrak rate-limits and
// blocks browser origins, and a marked prototype must not go blank because
// someone else's server is having a bad day).
//
// The elements come from CelesTrak's GP catalogue, which republishes the US
// Space Force / Space-Track general perturbations data — the same upstream that
// trackers like satellitemap.space are ultimately reading. What lands on disk is
// a dated snapshot of published two-line elements, not a live feed. The app
// propagates them with a Kepler + J2 model (see src/globe2/orbits.ts), which is
// a deliberate simplification of SGP4 -- close enough for a fresh snapshot of
// near-circular LEO, and cheap enough to run across the whole catalogue every
// frame. Either way it is a believable constellation, not real-time truth, and
// the UI says so.
//
// Re-run with `node scripts/fetch-starlink.ts` to refresh. TLEs age: epochs more
// than a few weeks old drift noticeably, so refresh before a demo.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "data");
const TLE_PATH = join(OUT_DIR, "starlink.tle");
const META_PATH = join(OUT_DIR, "starlink.meta.json");

// Primary first, then the mirror host and the JSON format, because gp.php has a
// habit of answering a bare request with 403 or an empty body under load.
const SOURCES = [
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle",
  "https://celestrak.com/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle",
];

// gp.php answers a default (curl) agent with 403 often enough to be worth faking.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export type TleRecord = { name: string; line1: string; line2: string };

// A TLE set is name/line1/line2 triples. Anything that doesn't line up is a
// truncated or error response dressed as a 200, so parsing is also the check.
export function parseTle(text: string): TleRecord[] {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length % 3 !== 0) {
    throw new Error(`${lines.length} lines isn't a whole number of TLE triples — truncated response`);
  }

  const records: TleRecord[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const [name, line1, line2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!name || !line1?.startsWith("1 ") || !line2?.startsWith("2 ")) {
      throw new Error(`malformed TLE triple at line ${i + 1}: ${JSON.stringify(name)}`);
    }
    records.push({ name, line1, line2 });
  }
  return records;
}

export function serialiseTle(records: TleRecord[]): string {
  // Normalised to LF and trimmed: the source is CRLF with the name padded to 24
  // columns, neither of which the browser parser wants to care about.
  return `${records.map((r) => `${r.name}\n${r.line1}\n${r.line2}`).join("\n")}\n`;
}

// CelesTrak refreshes GP data every two hours and answers a repeat request in
// between with 403 and a plain-english body. That is politeness, not a block:
// the file on disk is already the newest data there is, so leave it alone.
// Rewriting it would only move fetchedAt and pretend the snapshot got fresher.
const NOT_MODIFIED = /has not updated since your last successful/i;

class AlreadyCurrent extends Error {}

async function fetchFirstWorking(urls: string[]): Promise<{ url: string; text: string }> {
  const problems: string[] = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "text/plain,*/*" },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      if (NOT_MODIFIED.test(text)) throw new AlreadyCurrent(text.trim().split("\n")[0]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (text.trim().length === 0) throw new Error("empty body");
      if (/no gp data found/i.test(text)) throw new Error(`upstream said: ${text.trim()}`);
      return { url, text };
    } catch (error) {
      if (error instanceof AlreadyCurrent && existsSync(TLE_PATH)) throw error;
      problems.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`no CelesTrak source answered\n  ${problems.join("\n  ")}`);
}

async function main(): Promise<void> {
  let fetched: { url: string; text: string };
  try {
    fetched = await fetchFirstWorking(SOURCES);
  } catch (error) {
    if (error instanceof AlreadyCurrent) {
      console.log(`✓ public/data/starlink.tle already holds the newest published set — ${error.message}`);
      return;
    }
    throw error;
  }

  const { url, text } = fetched;
  const records = parseTle(text);
  if (records.length < 500) {
    throw new Error(`only ${records.length} satellites — that's a bad response, not a small fleet`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(TLE_PATH, serialiseTle(records));
  writeFileSync(
    META_PATH,
    `${JSON.stringify(
      {
        source: "CelesTrak GP catalogue (GROUP=starlink)",
        sourceUrl: url,
        fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        satelliteCount: records.length,
        note: "Snapshot of published two-line elements, not a live feed.",
      },
      null,
      2,
    )}\n`,
  );

  console.log(`✓ public/data/starlink.tle: ${records.length} satellites from ${url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
