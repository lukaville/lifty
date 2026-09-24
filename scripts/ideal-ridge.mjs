//   node scripts/ideal-ridge.mjs [H=150] [a=300] [mph=10]
// Ideal hill: 2-D ridge, smooth concave foot and convex top, no vegetation.
// Prints the along-wind section (net climb digits, 0.5 m/s steps) and, per third
// of the face, the best net climb within 15-60 m of the slope ("touching" the slope).
import path from "node:path";
import { fileURLToPath } from "node:url";
const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.atob ??= (s) => Buffer.from(s, "base64").toString("binary");
const { SitePhysics, WINGS } = await import(R + "/public/js/physics.js");
const [H = 150, a = 300, mphS = "10"] = process.argv.slice(2).map(Number);
const n = 128, cell = 3200 / 127, buf = Buffer.alloc(n * n * 2), base = 20;
const hf = (x) => base + H * Math.exp(-(x * x) / (a * a));
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) buf.writeUInt16LE(Math.round(hf(-1600 + i * cell) / 0.01), 2 * (j * n + i));
const p = new SitePhysics({ n, cell, windowM: 3200, minH: base, maxH: base + H, meanH: base + 40, scale: 0.01, offset: 0, heights_b64: buf.toString("base64") });
const U = mphS * 0.44704, F = p.computeLift(U, 0), net = p.netClimb(F, WINGS["pg-typical"]);
const at = (x, z) => {
  const b = p._sample(F.base, x, 0), d = z - b;
  if (d < 0) return null;
  let li = 0; while (li < F.agl.length - 2 && F.agl[li + 1] < d) li++;
  if (d < F.agl[0]) return -9;
  const tz = Math.min(1, (d - F.agl[li]) / (F.agl[li + 1] - F.agl[li]));
  return p._sample(net[li], x, 0) * (1 - tz) + p._sample(net[li + 1], x, 0) * tz;
};
console.log(`ideal ridge H=${H} m, a=${a} m (max slope ${(Math.atan(H * Math.sqrt(2 / Math.E) / a) * 57.3).toFixed(0)}°), ${mphS} mph, EN-B`);
for (let z = base + H * 2.2; z >= base; z -= H / 14) {
  let row = String(Math.round(z - base)).padStart(4) + " ";
  for (let x = -800; x <= 200; x += 12) {
    const c = at(x, z);
    row += c === null ? "#" : c > 0 ? String(Math.min(9, Math.floor(c / 0.5))) : ".";
  }
  console.log(row);
}
// per third of the face (upwind side): best net climb within 15-60 m of the slope
const best = [-Infinity, -Infinity, -Infinity];
for (let x = -900; x <= 0; x += 5) {
  const f = (hf(x) - base) / H; if (f < 0.02) continue;
  const third = Math.min(2, Math.floor(f * 3));
  for (let d = 15; d <= 60; d += 3) { const c = at(x, hf(x) + d); if (c > best[third]) best[third] = c; }
}
console.log("near-slope (15-60 m AGL) best net climb, lower/middle/upper third:", best.map((v) => (v > 0 ? v.toFixed(2) : "none")).join(" / "));
