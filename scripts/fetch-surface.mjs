// Build the surface layer for each site from open 1 m LiDAR plus satellite imagery:
//
//   · Environment Agency LiDAR composite DTM (bare earth) and first-return DSM,
//     1 m, Open Government Licence — DSM − DTM is the height of whatever stands on
//     the ground (trees, hedges, buildings).
//   · Esri World Imagery "Clarity" (z17, ~0.75 m/px here) — colour tells vegetation from
//     roofs where LiDAR alone can't (a flat-topped hedge vs a flat roof).
//
// Outputs, per site:
//   public/data/terrain/<slug>.json   — terrain grid rebuilt from the 1 m DTM
//                                       (physics 128², plus a 512² render mesh);
//                                       sea keeps the terrarium bathymetry
//   public/data/landcover/<slug>.png  — 4 m obstacle raster, RGB:
//                                       R = obstacle height ×4 (m), G = class,
//                                       B = obstacle cover fraction ×255
//   public/data/landcover/<slug>.json — 3D instances: trees, bushes, buildings
//
// Classes: 0 open ground, 1 bush/scrub/hedge, 2 tree, 3 building.
//
// Downloads are cached under .cache/ so classification can be re-tuned offline.
//   node scripts/fetch-surface.mjs [slug ...]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { wgs84ToBNG } from "./lib/osgb.mjs";
import { encodePNG } from "./lib/png.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache");
const TERRAIN_DIR = path.join(ROOT, "public", "data", "terrain");
const LC_DIR = path.join(ROOT, "public", "data", "landcover");
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(LC_DIR, { recursive: true });

const WINDOW_M = 3200;
const HALF = WINDOW_M / 2;
const R1 = 3200;            // 1 m working raster (R1 × R1 samples)
const LC_N = 800;           // 4 m landcover raster
const RENDER_N = 512;       // render mesh
const IMG_ZOOM = 17;

const WCS = {
  dtm: {
    url: "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs",
    id: "13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m",
  },
  dsm: {
    // FIRST return: the top of the canopy. (The last-return DSM passes through
    // foliage — especially in leaf-off surveys — and loses most of the trees.)
    url: "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-surface-model-first-return-dsm-1m/wcs",
    id: "df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m",
  },
};
// Esri "Clarity" World Imagery: cloud-free over all eight sites (the default
// World Imagery has cumulus over Beachy Head). The app streams the same source.
export const IMG_URL = (z, x, y) =>
  `https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
// Clarity has no deep-zoom tiles over open sea; fall back to standard imagery there
const IMG_FALLBACK = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// ------------------------------------------------------------------ utilities
async function cachedFetch(url, file) {
  const p = path.join(CACHE, file);
  if (fs.existsSync(p)) return fs.readFileSync(p);
  if (fs.existsSync(p + ".404")) return null;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "shgc-paragliding-sites build" } });
      if (res.status === 404) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p + ".404", ""); return null; }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
      return buf;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

// Minimal GeoTIFF reader: uncompressed float32, strips, either byte order.
function readTiff(buf) {
  const le = buf.toString("ascii", 0, 2) === "II";
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = (o) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  const ifd = u32(4), count = u16(ifd);
  const tags = {};
  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), n = u32(e + 4);
    const size = typeSize[type] * n;
    const off = size <= 4 ? e + 8 : u32(e + 8);
    const vals = [];
    for (let k = 0; k < n; k++) {
      const o = off + k * typeSize[type];
      vals.push(type === 3 ? u16(o) : type === 4 ? u32(o) : type === 12 ? f64(o) : type === 2 ? buf[o] : u32(o));
    }
    tags[tag] = type === 2 ? String.fromCharCode(...vals).replace(/\0+$/, "") : vals;
  }
  const W = tags[256][0], H = tags[257][0];
  if (tags[259] && tags[259][0] !== 1) throw new Error("compressed TIFF not supported");
  if (tags[258][0] !== 32) throw new Error("expected float32 TIFF");
  const data = new Float32Array(W * H);
  const rd = (o) => (le ? buf.readFloatLE(o) : buf.readFloatBE(o));
  if (tags[324]) {
    // tiled
    const TW = tags[322][0], TH = tags[323][0], across = Math.ceil(W / TW);
    tags[324].forEach((off, t) => {
      const tx = (t % across) * TW, ty = Math.floor(t / across) * TH;
      for (let y = 0; y < TH && ty + y < H; y++) {
        for (let x = 0; x < TW && tx + x < W; x++) data[(ty + y) * W + tx + x] = rd(off + (y * TW + x) * 4);
      }
    });
  } else {
    const offsets = tags[273], rps = tags[278] ? tags[278][0] : H;
    let px = 0;
    for (let s = 0; s < offsets.length; s++) {
      const rows = Math.min(rps, H - s * rps);
      for (let k = 0; k < rows * W; k++) data[px++] = rd(offsets[s] + k * 4);
    }
  }
  const nodata = tags[42113] !== undefined ? parseFloat(tags[42113]) : NaN;
  for (let k = 0; k < data.length; k++) {
    const v = data[k];
    // outside its coverage the EA service returns exact zeros rather than
    // nodata — a real LiDAR height is never exactly 0.0 (the sea surveys ≈ −3 m)
    if (v === nodata || v === 0 || !(v > -1000 && v < 10000)) data[k] = NaN;
  }
  // georeference: ModelTransformation, or tiepoint + pixel scale
  const mt = tags[34264], scale = tags[33550], tie = tags[33922];
  if (mt) return { W, H, data, x0: mt[3], y0: mt[7], sx: mt[0], sy: -mt[5] };
  return { W, H, data, x0: tie[3], y0: tie[4], sx: scale[0], sy: scale[1] };
}

// Solve the affine map (e, n) -> (X, Y) from three exact point conversions. Over
// 3.2 km, both Transverse Mercator and Web Mercator are affine to well under 1 m.
function fitAffine(fn) {
  const p0 = fn(0, 0), pe = fn(1000, 0), pn = fn(0, 1000);
  const A = { x0: p0[0], y0: p0[1], xe: (pe[0] - p0[0]) / 1000, ye: (pe[1] - p0[1]) / 1000,
              xn: (pn[0] - p0[0]) / 1000, yn: (pn[1] - p0[1]) / 1000 };
  const chk = fn(-1600, 1600);
  const ax = A.x0 + A.xe * -1600 + A.xn * 1600, ay = A.y0 + A.ye * -1600 + A.yn * 1600;
  A.err = Math.hypot(chk[0] - ax, chk[1] - ay);
  return A;
}

function bilinear(grid, W, H, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) return NaN;
  const fx = x - x0, fy = y - y0, k = y0 * W + x0;
  const a = grid[k], b = grid[k + 1], c = grid[k + W], d = grid[k + W + 1];
  if (a !== a || b !== b || c !== c || d !== d) {
    // nearest valid of the four
    const v = [a, b, c, d].filter((q) => q === q);
    return v.length ? v[0] : NaN;
  }
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

// ------------------------------------------------------------------ LiDAR mosaic
// The Environment Agency composite covers England only. Elsewhere (or if the
// service fails) we return an all-NaN mosaic: the terrain then falls back to
// the terrarium DEM and there are no trees or buildings — the app still works.
const inEngland = (lat, lon) => lat > 49.8 && lat < 55.9 && lon > -6.5 && lon < 1.9;

async function lidarMosaic(kind, slug, bbox, available = true) {
  if (!available) {
    const W = Math.ceil(bbox.E1 - Math.floor(bbox.E0)), H = Math.ceil(bbox.N1 - Math.floor(bbox.N0));
    return { data: new Float32Array(W * H).fill(NaN), W, H, E0: Math.floor(bbox.E0), Ntop: Math.floor(bbox.N0) + H };
  }
  const CH = 900;
  const E0 = Math.floor(bbox.E0), N0 = Math.floor(bbox.N0);
  const W = Math.ceil(bbox.E1 - E0), H = Math.ceil(bbox.N1 - N0);
  const out = new Float32Array(W * H).fill(NaN);   // row 0 = north edge
  for (let e = E0; e < E0 + W; e += CH) {
    for (let n = N0; n < N0 + H; n += CH) {
      const e1 = Math.min(e + CH, E0 + W), n1 = Math.min(n + CH, N0 + H);
      const url = `${WCS[kind].url}?service=WCS&version=2.0.1&request=GetCoverage&CoverageId=${WCS[kind].id}` +
        `&format=image/tiff&subset=E(${e},${e1})&subset=N(${n},${n1})`;
      let t;
      try {
        t = readTiff(await cachedFetch(url, `lidar/${kind}_${e}_${n}_${e1}_${n1}.tif`));
      } catch (err) {
        console.warn(`    no ${kind.toUpperCase()} LiDAR for ${slug} tile ${e},${n}: ${err.message}`);
        continue;
      }
      for (let r = 0; r < t.H; r++) {
        const Nc = t.y0 - (r + 0.5) * t.sy;             // pixel centre northing
        const row = Math.floor(N0 + H - Nc);
        if (row < 0 || row >= H) continue;
        for (let c = 0; c < t.W; c++) {
          const Ec = t.x0 + (c + 0.5) * t.sx;
          const col = Math.floor(Ec - E0);
          if (col < 0 || col >= W) continue;
          const v = t.data[r * t.W + c];
          if (v === v) out[row * W + col] = v;
        }
      }
    }
  }
  // grid index (col,row) holds the pixel centred at (E0+col+0.5, N0+H-row-0.5)
  return { data: out, W, H, E0, Ntop: N0 + H };
}

// ------------------------------------------------------------------ imagery mosaic
const TILE = 256;
const lonPx = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const latPx = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
};

async function imageryMosaic(site, toLatLon) {
  const corners = [[-HALF - 40, -HALF - 40], [HALF + 40, HALF + 40]].map(([e, n]) => toLatLon(e, n));
  const x0 = Math.floor(lonPx(corners[0][1], IMG_ZOOM) / TILE), x1 = Math.floor(lonPx(corners[1][1], IMG_ZOOM) / TILE);
  const y0 = Math.floor(latPx(corners[1][0], IMG_ZOOM) / TILE), y1 = Math.floor(latPx(corners[0][0], IMG_ZOOM) / TILE);
  const W = (x1 - x0 + 1) * TILE, H = (y1 - y0 + 1) * TILE;
  const rgb = new Uint8Array(W * H * 3);
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push([tx, ty]);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      const buf = (await cachedFetch(IMG_URL(IMG_ZOOM, tx, ty), `clarity/${IMG_ZOOM}_${tx}_${ty}.jpg`)) ||
        (await cachedFetch(IMG_FALLBACK(IMG_ZOOM, tx, ty), `img/${IMG_ZOOM}_${tx}_${ty}.jpg`));
      if (!buf) continue;
      const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const ox = (tx - x0) * TILE, oy = (ty - y0) * TILE;
      for (let y = 0; y < info.height; y++) {
        data.copy(rgb, ((oy + y) * W + ox) * 3, y * info.width * 3, (y + 1) * info.width * 3);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  return { rgb, W, H, px0: x0 * TILE, py0: y0 * TILE };
}

// separable running max over a (2r+1)² window; NaN treated as missing
function maxFilter(src, n, r) {
  const tmp = new Float32Array(n * n), out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let d = -r; d <= r; d++) { const ii = i + d; if (ii >= 0 && ii < n) { const v = src[j * n + ii]; if (v > m) m = v; } }
    tmp[j * n + i] = m;
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let d = -r; d <= r; d++) { const jj = j + d; if (jj >= 0 && jj < n) { const v = tmp[jj * n + i]; if (v > m) m = v; } }
    out[j * n + i] = m;
  }
  return out;
}

// ------------------------------------------------------------------ per site
async function buildSite(site) {
  const t0 = Date.now();
  const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos((site.lat * Math.PI) / 180);
  // same local projection the terrain grid uses
  const toLatLon = (e, n) => [site.lat + n / mPerDegLat, site.lon + e / mPerDegLon];
  const bng = fitAffine((e, n) => { const [la, lo] = toLatLon(e, n); const r = wgs84ToBNG(la, lo); return [r.E, r.N]; });
  const merc = fitAffine((e, n) => { const [la, lo] = toLatLon(e, n); return [lonPx(lo, IMG_ZOOM), latPx(la, IMG_ZOOM)]; });

  // BNG bounding box of the (slightly rotated) window
  let E0 = Infinity, E1 = -Infinity, N0 = Infinity, N1 = -Infinity;
  for (const [e, n] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const X = bng.x0 + bng.xe * e * (HALF + 30) + bng.xn * n * (HALF + 30);
    const Y = bng.y0 + bng.ye * e * (HALF + 30) + bng.yn * n * (HALF + 30);
    E0 = Math.min(E0, X); E1 = Math.max(E1, X); N0 = Math.min(N0, Y); N1 = Math.max(N1, Y);
  }
  const bbox = { E0, E1, N0, N1 };
  const lidar = inEngland(site.lat, site.lon);
  if (!lidar) console.log(`  ${site.name}: outside the Environment Agency LiDAR (England) — terrain from terrarium, no landcover`);
  const [dtmM, dsmM, img] = await Promise.all([
    lidarMosaic("dtm", site.slug, bbox, lidar), lidarMosaic("dsm", site.slug, bbox, lidar), imageryMosaic(site, toLatLon),
  ]);

  // ---- resample everything onto the 1 m local grid (row 0 = south, like terrain)
  const N1m = R1 * R1;
  const dtm = new Float32Array(N1m), dsm = new Float32Array(N1m);
  const R = new Uint8Array(N1m), G = new Uint8Array(N1m), B = new Uint8Array(N1m);
  for (let j = 0; j < R1; j++) {
    const n = -HALF + j + 0.5;
    for (let i = 0; i < R1; i++) {
      const e = -HALF + i + 0.5, k = j * R1 + i;
      const X = bng.x0 + bng.xe * e + bng.xn * n, Y = bng.y0 + bng.ye * e + bng.yn * n;
      const cx = X - dtmM.E0 - 0.5, cy = dtmM.Ntop - Y - 0.5;
      dtm[k] = bilinear(dtmM.data, dtmM.W, dtmM.H, cx, cy);
      dsm[k] = bilinear(dsmM.data, dsmM.W, dsmM.H, cx, cy);
      const px = merc.x0 + merc.xe * e + merc.xn * n - img.px0;
      const py = merc.y0 + merc.ye * e + merc.yn * n - img.py0;
      const ix = Math.max(0, Math.min(img.W - 1, Math.round(px))), iy = Math.max(0, Math.min(img.H - 1, Math.round(py)));
      const o = (iy * img.W + ix) * 3;
      R[k] = img.rgb[o]; G[k] = img.rgb[o + 1]; B[k] = img.rgb[o + 2];
    }
  }

  // ---- classification at 1 m
  // nDSM = height of objects above bare earth. Roughness = |Laplacian| of the DSM:
  // tree crowns are lumpy, roofs are planes (a pitched roof has zero Laplacian
  // except along the ridge). Colour: excess-green index ExG = (2G−R−B)/(R+G+B).
  const ndsm = new Float32Array(N1m), cls = new Uint8Array(N1m);
  // Highest bare ground within ±3 m. On a near-vertical cliff the DSM and DTM
  // disagree by the whole cliff height (one samples the top, the other the
  // foot), which would read as a 50 m "tree" on the cliff face. A real object
  // stands above the ground around it; a cliff edge doesn't.
  const dtmMax = maxFilter(dtm, R1, 3);
  let cliffPx = 0;
  for (let k = 0; k < N1m; k++) {
    const v = dsm[k] - dtm[k];
    ndsm[k] = v === v ? Math.max(0, Math.min(60, v)) : 0;
    // only on cliff-steep ground (> 3 m of relief within 3 m, i.e. ≳ 45°), so
    // bushes and hedges on ordinary slopes are untouched
    if (ndsm[k] > 0.6 && dtmMax[k] - dtm[k] > 3 && !(dsm[k] - dtmMax[k] > 1.5)) { ndsm[k] = 0; cliffPx++; }
  }
  const rough = new Float32Array(N1m);
  for (let j = 1; j < R1 - 1; j++) for (let i = 1; i < R1 - 1; i++) {
    const k = j * R1 + i;
    const L = 4 * ndsm[k] - ndsm[k - 1] - ndsm[k + 1] - ndsm[k - R1] - ndsm[k + R1];
    rough[k] = Math.abs(L);
  }
  // smooth roughness and greenness over 3×3 so single pixels don't decide
  const box3 = (src) => {
    const out = new Float32Array(N1m);
    for (let j = 1; j < R1 - 1; j++) for (let i = 1; i < R1 - 1; i++) {
      const k = j * R1 + i;
      out[k] = (src[k - R1 - 1] + src[k - R1] + src[k - R1 + 1] + src[k - 1] + src[k] + src[k + 1] +
                src[k + R1 - 1] + src[k + R1] + src[k + R1 + 1]) / 9;
    }
    return out;
  };
  const exgRaw = new Float32Array(N1m);
  for (let k = 0; k < N1m; k++) exgRaw[k] = (2 * G[k] - R[k] - B[k]) / (R[k] + G[k] + B[k] + 1);
  const exg = box3(exgRaw), rgh = box3(rough);
  for (let k = 0; k < N1m; k++) {
    const h = ndsm[k];
    if (h < 0.6) continue;
    const green = exg[k] > 0.03;
    const brightness = (R[k] + G[k] + B[k]) / 3;
    // Water: the DSM sees waves and a different tide than the DTM, which reads
    // as metre-high "objects" over the sea and the Ouse. Low-lying, blue-ish
    // pixels without real height are water, not scrub.
    const bluish = B[k] >= R[k] - 4 && G[k] >= R[k] - 4 && exg[k] < 0.06;
    if (!(dtm[k] > 4) && (bluish || !(dtm[k] > 1.5)) && h < 5) continue;
    // bare chalk / rock on steep ground (cliff faces, quarries) is
    // bright (crowns in this imagery are ~40–110 brightness), whatever the LiDAR says
    if (h >= 2.5 && brightness > 155 && dtmMax[k] - dtm[k] > 1.5) { ndsm[k] = 0; cliffPx++; continue; }
    if (h >= 2.5) {
      // planar and not lush green -> roof; everything else tall is canopy.
      // Flatness (LiDAR) is the primary test: imagery colour varies between
      // vintages and roofs can look green-tinted, but crowns are never planes.
      const planar = rgh[k] < 0.7;
      if (planar && exg[k] < 0.1 && brightness > 40) cls[k] = 3;
      else if (!planar && exg[k] < -0.04 && brightness > 150) cls[k] = 0;  // bright junk (cranes, noise)
      else cls[k] = 2;
    } else if (green || (rgh[k] > 0.5 && exg[k] > -0.01)) {
      cls[k] = 1;   // bushes, scrub, hedges (cars, walls and fences are not green)
    }
  }

  // ---- connected components: drop specks, collect buildings
  const lab = new Int32Array(N1m).fill(-1);
  const buildings = [];
  const masts = [];                 // [e, n, height]: radio masts, pylons, poles
  const stack = new Int32Array(N1m);
  for (let s = 0; s < N1m; s++) {
    if (cls[s] === 0 || lab[s] >= 0) continue;
    const c = cls[s];
    let sp = 0, cnt = 0;
    stack[sp++] = s; lab[s] = s;
    const members = [];
    while (sp) {
      const k = stack[--sp]; members.push(k); cnt++;
      const i = k % R1, j = (k / R1) | 0;
      if (i > 0 && cls[k - 1] === c && lab[k - 1] < 0) { lab[k - 1] = s; stack[sp++] = k - 1; }
      if (i < R1 - 1 && cls[k + 1] === c && lab[k + 1] < 0) { lab[k + 1] = s; stack[sp++] = k + 1; }
      if (j > 0 && cls[k - R1] === c && lab[k - R1] < 0) { lab[k - R1] = s; stack[sp++] = k - R1; }
      if (j < R1 - 1 && cls[k + R1] === c && lab[k + R1] < 0) { lab[k + R1] = s; stack[sp++] = k + R1; }
    }
    const minArea = c === 3 ? 20 : c === 2 ? 4 : 3;
    // Masts, pylons and poles: tall but far too slender to be a tree. A tree's
    // crown radius is at least ~0.12 × its height (a 40 m beech spreads 10–16 m);
    // a lattice mast is a few metres wide. They barely affect the wind, so they
    // leave the obstacle raster and are drawn as masts instead of giant trees.
    if (c === 2) {
      let hm = 0, km = 0;
      for (const k of members) if (ndsm[k] > hm) { hm = ndsm[k]; km = k; }
      // a crown cut by the edge of the window looks slender too: never a mast
      const edge = members.some((k) => { const i = k % R1, j = (k / R1) | 0; return i < 2 || j < 2 || i > R1 - 3 || j > R1 - 3; });
      // and it stands clear of other canopy: a slender crown inside a wood is a
      // tree whose crown the LiDAR split from its neighbours, not a mast
      let ring = 0, other = 0;
      if (!edge && hm > 15 && cnt < Math.PI * (0.12 * hm) ** 2) {
        const ci = km % R1, cj = (km / R1) | 0;
        for (let dj = -12; dj <= 12; dj++) for (let di = -12; di <= 12; di++) {
          const rr = di * di + dj * dj, ii = ci + di, jj = cj + dj;
          if (rr < 16 || rr > 144 || ii < 0 || jj < 0 || ii >= R1 || jj >= R1) continue;
          ring++;
          const q = jj * R1 + ii;
          if (cls[q] === 2 && lab[q] !== s) other++;
        }
      }
      if (ring && other / ring < 0.1) {
        for (const k of members) { cls[k] = 0; ndsm[k] = 0; }
        // on cliff-steep ground it's a DSM/DTM artefact, not a structure: drop it
        // (checked 8 m around: at the foot of a cliff the ground itself is flat)
        let relief = 0;
        for (let dj = -8; dj <= 8; dj += 2) for (let di = -8; di <= 8; di += 2) {
          const q = km + dj * R1 + di;
          if (q >= 0 && q < N1m && dtm[q] === dtm[q]) relief = Math.max(relief, dtm[q] - dtm[km]);
        }
        if (relief > 8) { cliffPx += cnt; continue; }
        masts.push([+((km % R1) - HALF + 0.5).toFixed(1), +(((km / R1) | 0) - HALF + 0.5).toFixed(1), +hm.toFixed(1)]);
        continue;
      }
    }
    // a roof is flat as a whole; a patch of flat-ish canopy is still a tree
    let mr = 0;
    for (const k of members) mr += rgh[k];
    mr /= cnt;
    // a big, smooth, low "bush" is a standing crop (oilseed rape, maize) at the
    // time of the LiDAR flight: surface roughness, not an obstacle
    if (c === 1 && cnt > 1500 && mr < 0.3) {
      for (const k of members) cls[k] = 0;
      continue;
    }
    if (c === 3 && cnt >= minArea && mr > 0.4) {
      for (const k of members) cls[k] = 2;
      continue;
    }
    if (cnt < minArea) {
      // too small to be real: roofs this small are sheds/cars; demote
      for (const k of members) cls[k] = c === 3 ? 1 : 0;
      continue;
    }
    if (c === 3) buildings.push(members);
  }

  // ---- buildings: oriented footprint from PCA, heights from nDSM percentiles
  const bOut = [];
  for (const m of buildings) {
    let se = 0, sn = 0;
    for (const k of m) { se += k % R1; sn += (k / R1) | 0; }
    const ce = se / m.length, cn = sn / m.length;
    let cee = 0, cnn = 0, cen = 0;
    for (const k of m) { const de = (k % R1) - ce, dn = ((k / R1) | 0) - cn; cee += de * de; cnn += dn * dn; cen += de * dn; }
    const ang = 0.5 * Math.atan2(2 * cen, cee - cnn);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    const hs = [];
    let rr = 0, gg = 0, bb = 0;
    for (const k of m) {
      const de = (k % R1) - ce, dn = ((k / R1) | 0) - cn;
      const a = de * ca + dn * sa, b = -de * sa + dn * ca;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
      hs.push(ndsm[k]); rr += R[k]; gg += G[k]; bb += B[k];
    }
    hs.sort((x, y) => x - y);
    const len = a1 - a0 + 1, wid = b1 - b0 + 1;
    // fill ratio: very ragged blobs are merged roofs / yards; still keep, as a box
    const eaves = hs[Math.floor(hs.length * 0.35)], ridge = hs[Math.floor(hs.length * 0.97)];
    const midA = (a0 + a1) / 2, midB = (b0 + b1) / 2;
    const cx = ce + midA * ca - midB * sa, cy = cn + midA * sa + midB * ca;
    bOut.push([
      +(cx - HALF + 0.5).toFixed(1), +(cy - HALF + 0.5).toFixed(1),
      +len.toFixed(1), +wid.toFixed(1), +ang.toFixed(3),
      +Math.max(2.5, eaves).toFixed(1), +Math.max(0, ridge - eaves).toFixed(1),
      ((rr / m.length) << 16) | ((gg / m.length) << 8) | (bb / m.length),
    ]);
  }

  // ---- trees and bushes: crown tops = local maxima of the smoothed nDSM
  const ns = box3(ndsm);
  const peaks = (c, win, minH) => {
    const out = [];
    for (let j = win; j < R1 - win; j++) for (let i = win; i < R1 - win; i++) {
      const k = j * R1 + i;
      if (cls[k] !== c || ns[k] < minH) continue;
      const v = ns[k];
      let isMax = true;
      for (let dj = -win; dj <= win && isMax; dj++) for (let di = -win; di <= win; di++) {
        if ((di || dj) && ns[k + dj * R1 + di] > v) { isMax = false; break; }
      }
      if (isMax) out.push(k);
    }
    return out.sort((a, b) => ns[b] - ns[a]);
  };
  // non-maximum suppression with a height-dependent crown spacing
  const suppress = (cands, spacing) => {
    const cellSz = 8, gw = Math.ceil(R1 / cellSz);
    const bucket = new Map();
    const kept = [];
    for (const k of cands) {
      const i = k % R1, j = (k / R1) | 0, h = ns[k], r = spacing(h);
      const bi = (i / cellSz) | 0, bj = (j / cellSz) | 0, reach = Math.ceil(8 / cellSz) + 1;
      let ok = true;
      for (let dj = -reach; dj <= reach && ok; dj++) for (let di = -reach; di <= reach; di++) {
        const lst = bucket.get((bj + dj) * gw + bi + di);
        if (!lst) continue;
        for (const [i2, j2, r2] of lst) {
          if ((i - i2) ** 2 + (j - j2) ** 2 < (Math.min(r, r2)) ** 2) { ok = false; break; }
        }
        if (!ok) break;
      }
      if (!ok) continue;
      const key = bj * gw + bi;
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push([i, j, r]);
      kept.push(k);
    }
    return kept;
  };
  const crownR = (h) => Math.max(1.6, Math.min(7, 0.26 * h + 1));
  const treeK = suppress(peaks(2, 2, 3), (h) => crownR(h) * 1.1);
  const bushK = suppress(peaks(1, 1, 0.7), () => 2.2);
  const colourAt = (k, rad) => {
    let rr = 0, gg = 0, bb = 0, c = 0;
    const i = k % R1, j = (k / R1) | 0, r = Math.max(1, Math.round(rad * 0.6));
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const q = (j + dj) * R1 + i + di;
      if (q < 0 || q >= N1m) continue;
      rr += R[q]; gg += G[q]; bb += B[q]; c++;
    }
    return ((rr / c) << 16) | ((gg / c) << 8) | (bb / c);
  };
  const inst = (k, h, r) => [
    +((k % R1) - HALF + 0.5).toFixed(1), +(((k / R1) | 0) - HALF + 0.5).toFixed(1),
    +h.toFixed(1), +r.toFixed(1), colourAt(k, r),
  ];
  const trees = treeK.map((k) => inst(k, ndsm[k] > 0 ? Math.max(ns[k], ndsm[k]) : ns[k], crownR(ns[k])));
  // bush height from the UNSMOOTHED nDSM, clamped to the bush class: the 3×3
  // smoothing lets a hedge next to a wood inherit the trees' height
  const bushH = (k) => Math.max(0.8, Math.min(2.5, ndsm[k]));
  const bushes = bushK.map((k) => inst(k, bushH(k), Math.max(0.9, Math.min(2.2, 0.6 + 0.5 * bushH(k)))));

  // ---- 4 m landcover raster for the airflow
  const f = R1 / LC_N;
  const lc = new Uint8Array(LC_N * LC_N * 3);
  const counts = [0, 0, 0, 0];
  for (let J = 0; J < LC_N; J++) for (let I = 0; I < LC_N; I++) {
    const hist = [0, 0, 0, 0];
    let hmax = 0;
    for (let dj = 0; dj < f; dj++) for (let di = 0; di < f; di++) {
      const k = (J * f + dj) * R1 + I * f + di;
      hist[cls[k]]++;
      if (cls[k] && ndsm[k] > hmax) hmax = ndsm[k];
    }
    const occ = hist[1] + hist[2] + hist[3];
    let c = 0;
    if (occ) c = hist[3] >= hist[2] && hist[3] >= hist[1] ? 3 : hist[2] >= hist[1] ? 2 : 1;
    const o = (J * LC_N + I) * 3;
    lc[o] = Math.min(255, Math.round(hmax * 4));
    lc[o + 1] = c;
    lc[o + 2] = Math.round((occ / (f * f)) * 255);
    counts[c]++;
  }
  fs.writeFileSync(path.join(LC_DIR, `${site.slug}.png`), encodePNG(LC_N, LC_N, lc));
  fs.writeFileSync(path.join(LC_DIR, `${site.slug}.json`), JSON.stringify({
    source: "Environment Agency LiDAR composite DSM/DTM 1 m (OGL v3) + Esri World Imagery classification",
    windowM: WINDOW_M, lcN: LC_N,
    fields: { trees: "e,n,h,r,rgb", bushes: "e,n,h,r,rgb", buildings: "e,n,length,width,angle,eaves,roofRise,rgb", masts: "e,n,h" },
    trees, bushes, buildings: bOut, masts,
  }));

  // ---- terrain from the DTM (sea / gaps keep the terrarium DEM)
  const tFile = path.join(TERRAIN_DIR, `${site.slug}.json`);
  const terr = JSON.parse(fs.readFileSync(tFile, "utf8"));
  if (!terr.terrarium_b64) terr.terrarium_b64 = terr.heights_b64, terr.terrarium = { offset: terr.offset, scale: terr.scale };
  const traw = Buffer.from(terr.terrarium_b64, "base64");
  const tn = terr.n, tcell = WINDOW_M / (tn - 1);
  const terrH = (e, n) => {
    const fi = (e + HALF) / tcell, fj = (n + HALF) / tcell;
    const i0 = Math.max(0, Math.min(tn - 2, Math.floor(fi))), j0 = Math.max(0, Math.min(tn - 2, Math.floor(fj)));
    const tx = Math.min(1, Math.max(0, fi - i0)), ty = Math.min(1, Math.max(0, fj - j0));
    const g = (i, j) => terr.terrarium.offset + traw.readUInt16LE(2 * (j * tn + i)) * terr.terrarium.scale;
    return g(i0, j0) * (1 - tx) * (1 - ty) + g(i0 + 1, j0) * tx * (1 - ty) + g(i0, j0 + 1) * (1 - tx) * ty + g(i0 + 1, j0 + 1) * tx * ty;
  };
  // box-average the 1 m DTM over each grid cell's footprint (the physics wants
  // the cell mean, the render mesh a smooth surface); fall back where no LiDAR
  const grid = (n) => {
    const cell = WINDOW_M / (n - 1), rad = Math.max(1, Math.round(cell / 2));
    const out = new Float32Array(n * n);
    let valid = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const e = -HALF + i * cell, nn = -HALF + j * cell;
      const ci = Math.round(e + HALF - 0.5), cj = Math.round(nn + HALF - 0.5);
      let s = 0, c = 0;
      for (let dj = -rad; dj <= rad; dj += 2) for (let di = -rad; di <= rad; di += 2) {
        const ii = ci + di, jj = cj + dj;
        if (ii < 0 || jj < 0 || ii >= R1 || jj >= R1) continue;
        const v = dtm[jj * R1 + ii];
        if (v === v) { s += v; c++; }
      }
      const tot = (Math.floor(rad / 2) * 2 + 1) ** 2;
      if (c > tot * 0.5) { out[j * n + i] = s / c; valid++; }
      else out[j * n + i] = terrH(e, nn);
    }
    return { h: out, valid: valid / (n * n) };
  };
  const enc = (h) => {
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (const v of h) { mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; }
    const scale = Math.max(1e-6, mx - mn) / 65535;
    const b = Buffer.alloc(h.length * 2);
    h.forEach((v, k) => b.writeUInt16LE(Math.round((v - mn) / scale), 2 * k));
    return { minH: mn, maxH: mx, meanH: sum / h.length, scale, offset: mn, b64: b.toString("base64") };
  };
  const phys = grid(tn), rend = grid(RENDER_N);
  const pe = enc(phys.h), re = enc(rend.h);
  Object.assign(terr, {
    source: phys.valid > 0.5 ? "Environment Agency LiDAR composite DTM 1 m (OGL v3); sea: Mapzen terrarium" : "Mapzen terrarium DEM (no LiDAR coverage)",
    minH: pe.minH, maxH: pe.maxH, meanH: pe.meanH, scale: pe.scale, offset: pe.offset, heights_b64: pe.b64,
    render: { n: RENDER_N, minH: re.minH, maxH: re.maxH, scale: re.scale, offset: re.offset, heights_b64: re.b64 },
    imagery: { zoom: IMG_ZOOM, lat: site.lat, lon: site.lon },
  });
  fs.writeFileSync(tFile, JSON.stringify(terr));

  console.log(`  ${site.name.padEnd(17)} lidar ${(phys.valid * 100).toFixed(0)}%  cliff-artefact px ${cliffPx}  trees ${trees.length}  masts ${masts.length}  bushes ${bushes.length}` +
    `  buildings ${bOut.length}  cells(open/bush/tree/bldg) ${counts.join("/")}  affine err ${bng.err.toFixed(2)}/${merc.err.toFixed(2)}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { R, G, B, cls, ndsm };
}

const { sites } = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "data", "sites.json"), "utf8"));
const only = process.argv.slice(2);
for (const s of sites) {
  if (only.length && !only.includes(s.slug)) continue;
  const res = await buildSite(s);
  if (process.env.DEBUG_PNG) {
    // debug overlay: imagery with classes tinted, 1 m, central 1.2 km
    const W = 1200, o = (R1 - W) / 2, out = Buffer.alloc(W * W * 3);
    const tint = [null, [255, 220, 0], [0, 255, 60], [255, 40, 200]];
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const k = (R1 - 1 - (o + y)) * R1 + o + x, p = (y * W + x) * 3, c = res.cls[k];
      const base = [res.R[k], res.G[k], res.B[k]];
      const col = c ? base.map((v, i) => (v * 0.45 + tint[c][i] * 0.55) | 0) : base;
      out[p] = col[0]; out[p + 1] = col[1]; out[p + 2] = col[2];
    }
    await sharp(out, { raw: { width: W, height: W, channels: 3 } }).png().toFile(path.join(process.env.DEBUG_PNG, `${s.slug}-classes.png`));
  }
}
