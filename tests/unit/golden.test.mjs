// Golden regression values for every site: lift-band ceilings, climbs, winds
// and rotor coverage at each site's mid-arc wind. Any change to the physics or
// data that moves these numbers fails the test; if the change is intended,
// regenerate with:   UPDATE_GOLDEN=1 npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, sites, sitePhysics, physics, wind, arcCentre } from "../helpers/terrain.mjs";

const FILE = path.join(ROOT, "tests/golden/physics.json");
const FT = 3.28084, MPH = 0.44704;
const WING_KEYS = ["pg-typical", "hg"];

function measure(s) {
  const p = sitePhysics(s.slug), out = {};
  for (const mph of [10, 14, 20]) {
    const w = wind(arcCentre(s), mph);
    const F = p.computeLift(w.u, w.v), T = p.computeTurbulence(w.fe, w.fn, w.U), W = p.obstacleWakes(w.fe, w.fn);
    const row = {};
    for (const wk of WING_KEYS) {
      const st = p.bandStats(F, physics.WINGS[wk]);
      row[wk] = {
        ceilingFt: st.soarable ? Math.round(st.ceilingAboveTakeoff * FT) : null,
        maxClimb: st.soarable ? +st.maxClimb.toFixed(2) : null,
      };
      if (wk === "pg-typical") { row.windTakeoffMph = +(st.windTakeoff / MPH).toFixed(1); row.windAloftMph = +(st.windAloft / MPH).toFixed(1); }
    }
    // fraction of the window in rotor (terrain) and in significant obstacle wakes
    row.rotorCover = +(T.intensity.filter((v) => v >= 0.12).length / T.intensity.length).toFixed(4);
    const f = Math.min(1.4, Math.max(0, (w.U - 1.5) / 6));
    row.wakeCover = +(W.intensity.filter((v) => v * f >= 0.4).length / W.intensity.length).toFixed(4);
    out[`${mph}mph`] = row;
  }
  return out;
}

const actual = Object.fromEntries(sites.map((s) => [s.slug, measure(s)]));

if (process.env.UPDATE_GOLDEN) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(actual, null, 1) + "\n");
  test("golden values regenerated", () => {});
} else {
  const golden = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const close = (a, b, abs, rel = 0) => (a === null || b === null ? a === b : Math.abs(a - b) <= abs + rel * Math.abs(b));
  for (const s of sites) {
    test(`${s.name}: physics matches golden values`, () => {
      assert.ok(golden[s.slug], `no golden values for "${s.slug}" yet (a new site?) — run: npm run test:golden:update`);
      for (const [k, row] of Object.entries(golden[s.slug])) {
        const a = actual[s.slug][k];
        for (const wk of WING_KEYS) {
          assert.ok(close(a[wk].ceilingFt, row[wk].ceilingFt, 8, 0.03), `${k} ${wk} ceiling ${a[wk].ceilingFt} vs ${row[wk].ceilingFt}`);
          assert.ok(close(a[wk].maxClimb, row[wk].maxClimb, 0.05), `${k} ${wk} climb ${a[wk].maxClimb} vs ${row[wk].maxClimb}`);
        }
        assert.ok(close(a.windTakeoffMph, row.windTakeoffMph, 0.3), `${k} take-off wind`);
        assert.ok(close(a.windAloftMph, row.windAloftMph, 0.3), `${k} wind aloft`);
        assert.ok(close(a.rotorCover, row.rotorCover, 0.003, 0.05), `${k} rotor ${a.rotorCover} vs ${row.rotorCover}`);
        assert.ok(close(a.wakeCover, row.wakeCover, 0.003, 0.05), `${k} wakes ${a.wakeCover} vs ${row.wakeCover}`);
      }
    });
  }
}
