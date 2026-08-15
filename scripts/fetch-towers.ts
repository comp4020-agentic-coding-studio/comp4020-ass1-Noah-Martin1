#!/usr/bin/env node
// Builds the cell tower layer from the World Bank's rasterised OpenCelliD
// snapshot: a global 30 arc-second (~1 km) grid whose value is the number of
// recorded towers in that cell.
//
// Why a raster and not the OpenCelliD point dump: the point dump is tens of
// millions of rows behind an account token, and we could neither ship nor draw
// it. The raster is a public CC BY 4.0 download of the same underlying data,
// and at 1 km a populated cell *is* a tower location to the precision this
// visualisation can honestly claim.
//
// The output is stratified, not thinned: we keep the densest 1 km cell inside
// every BLOCK_DEG box that has any towers at all. Taking the globally-densest N
// instead would have kept city centres and deleted the countryside, which is
// exactly the case the 5G story exists to explain -- CLAUDE.md's worked example
// is White Cliffs NSW, a village of a few dozen people.
//
//   public/data/towers.json       packed [lon, lat, count] triples
//   public/data/towers.meta.json  provenance, method and the caveats
//
// Usage: node scripts/fetch-towers.ts [--tif <path>]

import { open, mkdir, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "data");

const SOURCE_URL =
  "https://datacatalogfiles.worldbank.org/ddh-published/0038043/1/DR0046250/opencellid_global_1km_int.tif";
const LANDING_PAGE = "https://datacatalog.worldbank.org/search/dataset/0038043/global-opencellid-cell-tower-map";

/** Raster geometry. Read from the file's own tags, not trusted from here. */
const WIDTH = 43_200;
const HEIGHT = 21_600;
const PIXELS_PER_DEGREE = 120;

/**
 * Block size for the stratified pick. 0.25 deg keeps the nearest tower to a
 * remote point within about 30 km, which is the right order for outback
 * Australia, and lands the global count in the tens of thousands rather than
 * the millions.
 */
const BLOCK_DEG = 0.25;
const BLOCK_PX = Math.round(BLOCK_DEG * PIXELS_PER_DEGREE);
const GRID_W = WIDTH / BLOCK_PX;
const GRID_H = HEIGHT / BLOCK_PX;

function pixelToLon(col: number): number {
  return -180 + (col + 0.5) / PIXELS_PER_DEGREE;
}

function pixelToLat(row: number): number {
  return 90 - (row + 0.5) / PIXELS_PER_DEGREE;
}

interface Extracted {
  towers: [number, number, number][];
  totalTowers: number;
  populatedCells: number;
}

/**
 * The bit of TIFF we actually need. This file's strips are NOT laid out in row
 * order — row 0 begins 629 MB into a 933 MB file, and 284 rows are stored back
 * near the front — so StripOffsets has to be read and obeyed. Assuming the
 * pixel data was one contiguous block after the header put London, Paris and
 * Sydney on empty ocean and scattered "towers" across the Arctic.
 */
interface TiffLayout {
  width: number;
  height: number;
  rowsPerStrip: number;
  stripOffsets: number[];
  stripByteCounts: number[];
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 12: 8 };

async function readTiffLayout(file: FileHandle): Promise<TiffLayout> {
  const head = Buffer.alloc(8);
  await file.read(head, 0, 8, 0);
  if (head.toString("latin1", 0, 2) !== "II") throw new Error("expected a little-endian TIFF");
  if (head.readUInt16LE(2) !== 42) throw new Error("expected a classic TIFF, not BigTIFF");

  const ifdOffset = head.readUInt32LE(4);
  const countBuf = Buffer.alloc(2);
  await file.read(countBuf, 0, 2, ifdOffset);
  const entryCount = countBuf.readUInt16LE(0);

  const entriesBuf = Buffer.alloc(entryCount * 12);
  await file.read(entriesBuf, 0, entriesBuf.length, ifdOffset + 2);

  const tags = new Map<number, { type: number; count: number; valueOrOffset: number }>();
  for (let i = 0; i < entryCount; i++) {
    const at = i * 12;
    tags.set(entriesBuf.readUInt16LE(at), {
      type: entriesBuf.readUInt16LE(at + 2),
      count: entriesBuf.readUInt32LE(at + 4),
      valueOrOffset: entriesBuf.readUInt32LE(at + 8),
    });
  }

  const scalar = (tag: number, label: string): number => {
    const entry = tags.get(tag);
    if (!entry) throw new Error(`missing TIFF tag ${tag} (${label})`);
    return entry.valueOrOffset;
  };

  const compression = scalar(259, "Compression");
  if (compression !== 1) throw new Error(`expected uncompressed pixels, got compression ${compression}`);
  const bits = scalar(258, "BitsPerSample");
  if (bits !== 8) throw new Error(`expected 8-bit samples, got ${bits}`);
  const samples = scalar(277, "SamplesPerPixel");
  if (samples !== 1) throw new Error(`expected 1 sample per pixel, got ${samples}`);

  const width = scalar(256, "ImageWidth");
  const height = scalar(257, "ImageLength");
  const rowsPerStrip = scalar(278, "RowsPerStrip");

  const readArray = async (tag: number, label: string): Promise<number[]> => {
    const entry = tags.get(tag);
    if (!entry) throw new Error(`missing TIFF tag ${tag} (${label})`);
    const size = TYPE_SIZE[entry.type];
    if (!size) throw new Error(`${label}: unsupported field type ${entry.type}`);
    // A field small enough to sit inline stores its value in the entry itself.
    if (entry.count * size <= 4) return [entry.valueOrOffset];
    const buf = Buffer.alloc(entry.count * size);
    await file.read(buf, 0, buf.length, entry.valueOrOffset);
    const out: number[] = Array.from({ length: entry.count }, () => 0);
    for (let i = 0; i < entry.count; i++) {
      out[i] = size === 2 ? buf.readUInt16LE(i * 2) : buf.readUInt32LE(i * 4);
    }
    return out;
  };

  const stripOffsets = await readArray(273, "StripOffsets");
  const stripByteCounts = await readArray(279, "StripByteCounts");
  const expectedStrips = Math.ceil(height / rowsPerStrip);
  if (stripOffsets.length !== expectedStrips) {
    throw new Error(`StripOffsets has ${stripOffsets.length} entries, expected ${expectedStrips}`);
  }

  return { width, height, rowsPerStrip, stripOffsets, stripByteCounts };
}

/**
 * Reads the raster a strip at a time, seeking to each strip's declared offset.
 * Nothing is held in memory beyond the block accumulators (~9 MB) and one
 * strip, which is the only reason a 933 MB raster is tractable here.
 */
export async function extract(tifPath: string, onProgress?: (rowsDone: number) => void): Promise<Extracted> {
  const file = await open(tifPath, "r");
  try {
    const layout = await readTiffLayout(file);
    if (layout.width !== WIDTH || layout.height !== HEIGHT) {
      throw new Error(`expected ${WIDTH}x${HEIGHT}, got ${layout.width}x${layout.height}`);
    }

    const best = new Uint8Array(GRID_W * GRID_H);
    const bestCol = new Int32Array(GRID_W * GRID_H).fill(-1);
    const bestRow = new Int32Array(GRID_W * GRID_H).fill(-1);
    const blockTotal = new Uint32Array(GRID_W * GRID_H);

    const strip = Buffer.alloc(layout.rowsPerStrip * WIDTH);

    for (let s = 0; s < layout.stripOffsets.length; s++) {
      const bytes = layout.stripByteCounts[s] ?? layout.rowsPerStrip * WIDTH;
      const { bytesRead } = await file.read(strip, 0, bytes, layout.stripOffsets[s]);
      if (bytesRead !== bytes) throw new Error(`strip ${s}: read ${bytesRead} of ${bytes} bytes`);

      const rowsHere = Math.min(layout.rowsPerStrip, HEIGHT - s * layout.rowsPerStrip);
      for (let r = 0; r < rowsHere; r++) {
        const row = s * layout.rowsPerStrip + r;
        const blockRow = (row / BLOCK_PX) | 0;
        const base = r * WIDTH;
        for (let col = 0; col < WIDTH; col++) {
          const value = strip[base + col];
          if (value === 0) continue;
          const index = blockRow * GRID_W + ((col / BLOCK_PX) | 0);
          blockTotal[index] += value;
          if (value > best[index]) {
            best[index] = value;
            bestCol[index] = col;
            bestRow[index] = row;
          }
        }
      }
      if (onProgress && s % 500 === 0) onProgress(s * layout.rowsPerStrip);
    }

    const towers: [number, number, number][] = [];
    let totalTowers = 0;
    let populatedCells = 0;
    for (let i = 0; i < best.length; i++) {
      if (bestCol[i] < 0) continue;
      populatedCells++;
      totalTowers += blockTotal[i];
      towers.push([
        Number(pixelToLon(bestCol[i]).toFixed(4)),
        Number(pixelToLat(bestRow[i]).toFixed(4)),
        blockTotal[i],
      ]);
    }

    return { towers, totalTowers, populatedCells };
  } finally {
    await file.close();
  }
}

async function main(): Promise<void> {
  const tifArg = process.argv.indexOf("--tif");
  const tifPath = tifArg > -1 ? process.argv[tifArg + 1] : join("/tmp", "opencellid_1km.tif");

  process.stdout.write(`reading ${tifPath} …\n`);
  const { towers, totalTowers, populatedCells } = await extract(tifPath, (rowsDone) => {
    process.stdout.write(`\r  ${((rowsDone / HEIGHT) * 100).toFixed(1)}%`);
  });
  process.stdout.write("\r  100.0%\n");

  await mkdir(OUT_DIR, { recursive: true });

  const towersJson = JSON.stringify(towers);
  await writeFile(join(OUT_DIR, "towers.json"), towersJson);

  const meta = {
    source: "OpenCelliD, rasterised by the World Bank (Global OpenCelliD cell tower map)",
    sourceUrl: SOURCE_URL,
    landingPage: LANDING_PAGE,
    upstream: "https://www.opencellid.org/",
    licence:
      "World Bank Data Catalog, Creative Commons Attribution 4.0 (CC BY 4.0). Derived from OpenCelliD, which is CC BY-SA 4.0 — credit both.",
    snapshot: "OpenCelliD repository downloaded 2020-07-01 by the World Bank and gridded at 30 arc-seconds.",
    fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    raster: { width: WIDTH, height: HEIGHT, degreesPerPixel: 1 / PIXELS_PER_DEGREE, origin: [-180, 90] },
    method:
      `Stratified pick: the globe is divided into ${BLOCK_DEG}° blocks and the single densest 1 km cell in each ` +
      `block that contains any recorded tower is kept, positioned at that cell's centre. The third value in each ` +
      `triple is the total recorded towers in the whole block, not in that one cell.`,
    towerPoints: towers.length,
    populatedBlocks: populatedCells,
    recordedTowersRepresented: totalTowers,
    caveats: [
      "Marker positions are 1 km grid cells, not surveyed mast locations.",
      "OpenCelliD is crowd-sourced, so coverage is denser where contributors are active — absence of a marker is not proof there is no tower.",
      "All radio generations are counted together; the snapshot does not distinguish 5G from older cells.",
      "One marker stands for a whole block, so the drawn count is far smaller than the number of real towers.",
    ],
  };
  await writeFile(join(OUT_DIR, "towers.meta.json"), JSON.stringify(meta, null, 2) + "\n");

  process.stdout.write(
    `✓ public/data/towers.json: ${towers.length.toLocaleString("en-AU")} points, ` +
      `${towersJson.length.toLocaleString("en-AU")} bytes, representing ` +
      `${totalTowers.toLocaleString("en-AU")} recorded towers\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
