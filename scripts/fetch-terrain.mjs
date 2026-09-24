// Fetch real elevation data (Mapzen/Tilezen "terrarium" DEM tiles, hosted on AWS
// open-data, no key required) for each SHGC site and resample it onto a centered
// metric grid. Output: public/data/terrain/<slug>.json
//   node scripts/fetch-terrain.mjs [slug ...]
//
// Terrarium decode:  elevation_m = (R*256 + G + B/256) - 32768
// Tiles: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
//
// No external dependencies — a tiny PNG decoder (8-bit RGB) is included below,
// using Node's built-in zlib for the DEFLATE stream.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "data", "terrain");
fs.mkdirSync(OUT_DIR, { recursive: true });

const ZOOM = 14;         // ~6 m/px at this latitude
const WINDOW_M = 3200;   // physical size of the square window, metres
const N = 128;           // output grid resolution (power of two -> FFT-friendly)
const TILE_BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

import { decodePNG } from "./lib/png.mjs";

// ---------- Web Mercator helpers ----------
const TILE = 256;
function lonToGlobalPx(lon, z) {
  return ((lon + 180) / 360) * TILE * Math.pow(2, z);
}
function latToGlobalPx(lat, z) {
  const s = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return y * TILE * Math.pow(2, z);
}

async function fetchTile(z, x, y) {
  const url = `${TILE_BASE}/${z}/${x}/${y}.png`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const img = decodePNG(buf);
      return img;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

function base64Uint16(arr) {
  const b = Buffer.alloc(arr.length * 2);
  for (let i = 0; i < arr.length; i++) b.writeUInt16LE(arr[i], i * 2);
  return b.toString("base64");
}

async function buildSite(site) {
  const { lat, lon } = site;
  const half = WINDOW_M / 2;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);

  // bounding lon/lat of the window (+ margin) -> tile range
  const dLat = (half + 200) / mPerDegLat;
  const dLon = (half + 200) / mPerDegLon;
  const pxL = lonToGlobalPx(lon - dLon, ZOOM);
  const pxR = lonToGlobalPx(lon + dLon, ZOOM);
  const pyT = latToGlobalPx(lat + dLat, ZOOM); // north -> smaller py
  const pyB = latToGlobalPx(lat - dLat, ZOOM);
  const txMin = Math.floor(pxL / TILE), txMax = Math.floor(pxR / TILE);
  const tyMin = Math.floor(pyT / TILE), tyMax = Math.floor(pyB / TILE);
  const tilesX = txMax - txMin + 1;
  const tilesY = tyMax - tyMin + 1;

  // fetch & mosaic
  const mosaicW = tilesX * TILE;
  const mosaicH = tilesY * TILE;
  const elev = new Float32Array(mosaicW * mosaicH);
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const img = await fetchTile(ZOOM, tx, ty);
      const ch = img.channels;
      const ox = (tx - txMin) * TILE;
      const oy = (ty - tyMin) * TILE;
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const p = (y * img.width + x) * ch;
          const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2];
          const h = r * 256 + g + b / 256 - 32768;
          elev[(oy + y) * mosaicW + (ox + x)] = h;
        }
      }
    }
  }
  const topLeftPx = txMin * TILE;
  const topLeftPy = tyMin * TILE;

  function sampleMeters(east, north) {
    const la = lat + north / mPerDegLat;
    const lo = lon + east / mPerDegLon;
    const gx = lonToGlobalPx(lo, ZOOM) - topLeftPx;
    const gy = latToGlobalPx(la, ZOOM) - topLeftPy;
    const x0 = Math.max(0, Math.min(mosaicW - 2, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(mosaicH - 2, Math.floor(gy)));
    const fx = gx - x0, fy = gy - y0;
    const h00 = elev[y0 * mosaicW + x0];
    const h10 = elev[y0 * mosaicW + x0 + 1];
    const h01 = elev[(y0 + 1) * mosaicW + x0];
    const h11 = elev[(y0 + 1) * mosaicW + x0 + 1];
    return (
      h00 * (1 - fx) * (1 - fy) +
      h10 * fx * (1 - fy) +
      h01 * (1 - fx) * fy +
      h11 * fx * fy
    );
  }

  // resample onto centered metric grid: index i=east, j=north; j=0 is south
  const cell = WINDOW_M / (N - 1);
  const heights = new Float32Array(N * N);
  let minH = Infinity, maxH = -Infinity, sum = 0;
  for (let j = 0; j < N; j++) {
    const north = -half + j * cell;
    for (let i = 0; i < N; i++) {
      const east = -half + i * cell;
      const h = sampleMeters(east, north);
      heights[j * N + i] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      sum += h;
    }
  }
  const meanH = sum / (N * N);

  // quantise to uint16 for compact storage
  const range = Math.max(1e-6, maxH - minH);
  const q = new Uint16Array(N * N);
  for (let k = 0; k < N * N; k++) {
    q[k] = Math.round(((heights[k] - minH) / range) * 65535);
  }

  const out = {
    slug: site.slug,
    name: site.name,
    zoom: ZOOM,
    n: N,
    cell,               // metres per grid step
    windowM: WINDOW_M,
    minH,               // metres AMSL
    maxH,
    meanH,
    scale: range / 65535,
    offset: minH,
    heights_b64: base64Uint16(q),
  };
  fs.writeFileSync(
    path.join(OUT_DIR, `${site.slug}.json`),
    JSON.stringify(out)
  );
  console.log(
    `  ${site.name.padEnd(18)} tiles ${tilesX}x${tilesY}  elev ${minH.toFixed(0)}–${maxH.toFixed(0)} m  relief ${(maxH - minH).toFixed(0)} m`
  );
}

async function main() {
  const sitesFile = path.join(ROOT, "public", "data", "sites.json");
  const { sites } = JSON.parse(fs.readFileSync(sitesFile, "utf8"));
  console.log(`Fetching DEM for ${sites.length} sites (zoom ${ZOOM}, ${WINDOW_M} m window, ${N}x${N} grid)`);
  // optional slugs on the command line: only (re)build those sites
  const only = process.argv.slice(2);
  for (const site of sites) {
    if (only.length && !only.includes(site.slug)) continue;
    await buildSite(site);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
