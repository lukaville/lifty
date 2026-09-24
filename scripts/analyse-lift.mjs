// Diagnostic: realistic ridge-lift ceiling and best climb per site and wing, for a
// range of forecast winds from the middle of each site's working arc.
//   node scripts/analyse-lift.mjs [mph ...]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.atob ??= (s) => Buffer.from(s, "base64").toString("binary");
const { SitePhysics, WINGS } = await import(`${ROOT}/public/js/physics.js`);
const { decodeLandcover } = await import(`${ROOT}/public/js/landcover.js`);
const { decodePNG } = await import(`${ROOT}/scripts/lib/png.mjs`);
const landcover = (slug) => {
  const f = `${ROOT}/public/data/landcover/${slug}.png`;
  if (!fs.existsSync(f)) return null;
  const png = decodePNG(fs.readFileSync(f));
  return decodeLandcover(png.data, png.width, 3200, png.channels);
};
const { sites } = JSON.parse(fs.readFileSync(`${ROOT}/public/data/sites.json`, "utf8"));
const MPH = 0.44704, FT = 3.28084;
const winds = process.argv.slice(2).map(Number);

console.log("ceiling above take-off / best net climb (m/s); winds in mph");
console.log("fcst site              " + Object.keys(WINGS).map((w) => w.padStart(12)).join("") + "   on-TO  @200ft  peak w");
for (const mph of winds.length ? winds : [10, 14, 20, 26]) {
  for (const s of sites) {
    const phys = new SitePhysics(JSON.parse(fs.readFileSync(`${ROOT}/public/data/terrain/${s.slug}.json`, "utf8")), landcover(s.slug));
    const span = (s.windFrom[1] - s.windFrom[0] + 360) % 360;
    const b = (((s.windFrom[0] + span / 2) % 360) * Math.PI) / 180;
    const L = phys.computeLift(-Math.sin(b) * mph * MPH, -Math.cos(b) * mph * MPH);
    let st;
    const cols = Object.values(WINGS).map((w) => {
      st = phys.bandStats(L, w);
      return (st.soarable ? `${Math.round(st.ceilingAboveTakeoff * FT)}ft/${st.maxClimb.toFixed(1)}` : "—").padStart(12);
    });
    console.log(`${String(mph).padStart(4)} ${s.name.padEnd(17)}${cols.join("")}   ${(st.windTakeoff / MPH).toFixed(0).padStart(5)}  ${(st.windAloft / MPH).toFixed(0).padStart(6)}  ${L.max.toFixed(1).padStart(6)}`);
  }
}
