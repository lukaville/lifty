import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOT, sites } from "../helpers/terrain.mjs";
const { wgs84ToBNG } = await import(`${ROOT}/scripts/lib/osgb.mjs`);

// 100 km square letters used by the Sussex sites
const SQUARES = { TQ: [500000, 100000], TV: [500000, 0] };

test("Greenwich Airy Transit Circle (WGS84) -> OS grid within the ~5 m Helmert accuracy", () => {
  const r = wgs84ToBNG(51.477928, -0.001545);
  assert.ok(Math.abs(r.E - 538874) < 15 && Math.abs(r.N - 177344) < 15, JSON.stringify(r));
});

// The site coordinates (take-off) and the SHGC 100 m grid refs agree to within
// ~300 m. Four sites differ by more than a grid square — Firle, Ditchling
// Beacon, High & Over, Bo Peep (130–275 m) — and are worth verifying on the
// ground. This guards against gross errors (swapped digits, wrong 100 km square).
test("every site's lat/lon is within 300 m of its published grid reference", () => {
  for (const s of sites) {
    const [sq, e, n] = s.gridRef.split(" ");
    const [E0, N0] = SQUARES[sq];
    const r = wgs84ToBNG(s.lat, s.lon);
    const ge = E0 + Number(e) * 100 + 50, gn = N0 + Number(n) * 100 + 50;   // square centre
    const d = Math.hypot(r.E - ge, r.N - gn);
    assert.ok(d < 300, `${s.name}: ${Math.round(d)} m from ${s.gridRef}`);
  }
});

test("moving east/north increases easting/northing by ~the distance moved", () => {
  const a = wgs84ToBNG(50.85, 0.0), b = wgs84ToBNG(50.85, 0.01), c = wgs84ToBNG(50.86, 0.0);
  const mLon = 111320 * Math.cos((50.85 * Math.PI) / 180) * 0.01;
  assert.ok(Math.abs(Math.hypot(b.E - a.E, b.N - a.N) - mLon) < 5);
  assert.ok(c.N - a.N > 1100 && c.N - a.N < 1125);
});
