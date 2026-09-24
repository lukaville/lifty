// Along-wind cross-section through take-off: terrain #, trees T, bushes b, buildings B, rotor R,
// usable net climb as digits in 0.5 m/s steps.
//   node scripts/section.mjs <slug> <dirDeg> <mph> [wing] [centreEast centreNorth]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.atob ??= (s) => Buffer.from(s, "base64").toString("binary");
const { SitePhysics, WINGS, sinkRate } = await import(R + "/public/js/physics.js");
const { decodeLandcover } = await import(R + "/public/js/landcover.js");
const { decodePNG } = await import(R + "/scripts/lib/png.mjs");
const [slug = "devils-dyke", dirS = "326", mphS = "10", wingK = "pg-typical", e0S = "0", n0S = "0"] = process.argv.slice(2);
const E0 = +e0S, N0 = +n0S;   // section centre (m east/north of take-off)
const t = JSON.parse(fs.readFileSync(`${R}/public/data/terrain/${slug}.json`));
const png = decodePNG(fs.readFileSync(`${R}/public/data/landcover/${slug}.png`));
const p = new SitePhysics(t, decodeLandcover(png.data, png.width, 3200, png.channels));
const b = +dirS * Math.PI / 180, fe = -Math.sin(b), fn = -Math.cos(b), U = +mphS * 0.44704;
const F = p.computeLift(fe * U, fn * U), T = p.computeTurbulence(fe, fn, U), net = p.netClimb(F, WINGS[wingK], undefined, T);
const st = p.bandStats(F, WINGS[wingK], net);
const layerAt = (x, y, alt) => {           // net climb at absolute altitude via terrain-following layers
  const base = p._sample(F.base, x, y), d = alt - base;
  if (d < F.agl[0]) return d < 0 ? null : -9;
  let li = 0; while (li < F.agl.length - 2 && F.agl[li + 1] < d) li++;
  const tz = Math.min(1, (d - F.agl[li]) / (F.agl[li + 1] - F.agl[li]));
  return p._sample(net[li], x, y) * (1 - tz) + p._sample(net[li + 1], x, y) * tz;
};
const zs = []; for (let z = 400; z >= 0; z -= 12) zs.push(z);
const xs = []; for (let s = -1100; s <= 500; s += 20) xs.push(s);   // s along flow; negative = upwind
console.log(`${slug} ${dirS}° ${mphS} mph ${wingK}: ceiling ${Math.round(st.ceilingAboveTakeoff * 3.28)} ft ATO, best ${st.maxClimb.toFixed(1)} m/s  (take-off at s=0, wind blows left->right)`);
for (const z of zs) {
  let row = String(z).padStart(4) + " ";
  for (const s of xs) {
    const x = E0 + fe * s, y = N0 + fn * s, g = p.groundAt(x, y);
    if (z < g) { row += "#"; continue; }
    // vegetation / buildings from the LiDAR landcover (4 m raster)
    const lc = p.landcover, q = lc ? (Math.floor((y + 1600) / lc.cell) * lc.n + Math.floor((x + 1600) / lc.cell)) : -1;
    if (lc && q >= 0 && q < lc.n * lc.n && lc.cls[q] && z < g + lc.height[q] * Math.max(1, 12 / 12)) {
      row += lc.cls[q] === 3 ? "B" : lc.cls[q] === 2 ? "T" : "b"; continue;
    }
    // rotor / turbulence (intensity ≥ 0.35, below its top): R
    if (p._sample(T.intensity, x, y) >= 0.35 && z < p._sample(T.top, x, y)) { row += "R"; continue; }
    const c = layerAt(x, y, z);
    row += c === null ? "#" : c > 0 ? String(Math.min(9, Math.floor(c / 0.5))) : ".";
  }
  console.log(row);
}
console.log("     " + xs.map((s) => (s % 200 === 0 ? "|" : " ")).join("") + "   (| every 200 m)");
