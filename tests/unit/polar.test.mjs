import { test } from "node:test";
import assert from "node:assert/strict";
import { physics } from "../helpers/terrain.mjs";
const { WINGS, sinkRate, windProfile, BEAT_SINK_FACTOR } = physics;

test("sink rate: minimum at min-sink speed, parabolic growth, steeply unusable beyond full speed", () => {
  for (const [key, w] of Object.entries(WINGS)) {
    const at = (v) => sinkRate(w, v);
    assert.ok(Math.abs(at(0) - w.minSink * BEAT_SINK_FACTOR) < 1e-9, key);
    assert.equal(at(w.vMinSink * 0.5), at(0), `${key}: below min-sink speed you fly at min sink`);
    assert.ok(at(w.trim) > at(w.vMinSink), key);
    assert.ok(Math.abs(at(w.vMax) - w.sinkAtVMax * BEAT_SINK_FACTOR) < 1e-9, key);
    // beyond full speed the wing is blown back: sink rises steeply but stays continuous
    assert.ok(at(w.vMax + 1) > at(w.vMax) + 3.5, `${key}: unusable beyond full speed`);
    assert.ok(at(w.vMax + 0.001) - at(w.vMax) < 0.01, `${key}: continuous at full speed`);
    let prev = 0;
    for (let v = w.vMinSink; v <= w.vMax; v += 0.5) { assert.ok(at(v) >= prev); prev = at(v); }
  }
});

test("wing ordering is physically sensible", () => {
  const { "pg-school": a, "pg-typical": b, "pg-perf": c, hg } = WINGS;
  assert.ok(a.minSink >= b.minSink && b.minSink >= c.minSink && c.minSink > hg.minSink, "sink");
  assert.ok(a.vMax < b.vMax && b.vMax < c.vMax && c.vMax < hg.vMax, "top speed");
});

test("log wind profile: 1 at the 10 m reference, 0 at the ground, increasing, ~+40% at 80 m", () => {
  assert.ok(Math.abs(windProfile(10) - 1) < 1e-12);
  assert.ok(windProfile(0) < 0.01);
  let prev = -1;
  for (const d of [0.5, 2, 5, 10, 30, 80, 200, 450]) { assert.ok(windProfile(d) > prev); prev = windProfile(d); }
  assert.ok(windProfile(80) > 1.3 && windProfile(80) < 1.5);
  assert.ok(windProfile(2) > 0.65 && windProfile(2) < 0.8, "hand-held anemometer height");
});
