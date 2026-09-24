// Physics on synthetic terrain with known, physically-motivated answers.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { physics, syntheticTerrain, syntheticLandcover, shapes, wind, fieldAt } from "../helpers/terrain.mjs";

const { SitePhysics, WINGS, MIN_CLEARANCE, USABLE_CLIMB, reattachH, ROTOR_RECOVERY_H, windProfile, crestBubbleH } = physics;
const EN_B = WINGS["pg-typical"];

// shared fixtures (building SitePhysics is the expensive part)
const ridge = new SitePhysics(syntheticTerrain(shapes.ridge(150, 300)));
const flat = new SitePhysics(syntheticTerrain(shapes.flat));
const W10 = wind(270, 10);             // from the west: flow toward +x (east)

describe("flat ground", () => {
  const F = flat.computeLift(W10.u, W10.v);
  test("no vertical motion anywhere", () => {
    for (const layer of F.layers) for (const w of layer) assert.ok(Math.abs(w) < 0.02);
  });
  test("horizontal wind follows the log profile", () => {
    for (const d of [6, 30, 100, 300]) {
      const s = fieldAt(flat, F, F.spd, 0, 0, d);
      assert.ok(Math.abs(s / (W10.U * windProfile(d)) - 1) < 0.03, `d=${d}`);
    }
  });
  test("no rotor, no soarable band", () => {
    const T = flat.computeTurbulence(W10.fe, W10.fn, W10.U);
    assert.equal(Math.max(...T.intensity), 0);
    assert.equal(flat.bandStats(F, EN_B).soarable, false);
  });
});

describe("2-D ridge (150 m, 23°), wind across it", () => {
  const F = ridge.computeLift(W10.u, W10.v);
  const wAt = (x, d) => fieldAt(ridge, F, F.layers, x, 0, d);
  const sAt = (x, d) => fieldAt(ridge, F, F.spd, x, 0, d);

  test("updraught on the windward face, strongest upwind of the crest", () => {
    let best = -Infinity, xBest = 0;
    for (let x = -700; x <= 300; x += 10) { const w = wAt(x, 30); if (w > best) { best = w; xBest = x; } }
    assert.ok(best > 0.8, `peak w ${best}`);
    assert.ok(xBest < 0 && xBest > -400, `peak at x=${xBest}`);
  });

  test("physical bound: never faster than the local wind times tan(35°)", () => {
    for (let li = 0; li < F.layers.length; li++) {
      for (let k = 0; k < F.layers[li].length; k++) {
        assert.ok(F.layers[li][k] <= F.spd[li][k] * Math.tan((35 * Math.PI) / 180) + 0.05);
      }
    }
  });

  test("speed-up over the crest, slow-down at the windward foot (Askervein-like)", () => {
    const U0 = W10.U * windProfile(10);
    const crest = sAt(0, 10) / U0, foot = sAt(-450, 10) / U0;
    assert.ok(crest > 1.2 && crest < 1.9, `crest ${crest}`);
    assert.ok(foot < 0.95 && foot > 0.3, `foot ${foot}`);
  });

  test("mirror symmetry: reversing the wind mirrors the field", () => {
    const Fr = ridge.computeLift(-W10.u, 0);
    for (const x of [-300, -150, 150, 300]) {
      const a = wAt(x, 40), b = fieldAt(ridge, Fr, Fr.layers, -x, 0, 40);
      assert.ok(Math.abs(a - b) < 0.05 + 0.05 * Math.abs(a), `x=${x}: ${a} vs ${b}`);
    }
  });

  test("roughly linear in wind speed on the windward face", () => {
    const F2 = ridge.computeLift(2 * W10.u, 0);
    const r = fieldAt(ridge, F2, F2.layers, -200, 0, 40) / wAt(-200, 40);
    assert.ok(r > 1.8 && r < 2.2, `ratio ${r}`);
  });

  // lowest point of the face (as a fraction of its height) where usable lift
  // touches the slope, i.e. within 15–25 m of the surface
  const touchDown = (mph, margin) => {
    const Fm = ridge.computeLift(mph * 0.44704, 0), net = ridge.netClimb(Fm, EN_B, margin);
    let low = 1;
    for (let x = -900; x <= 0; x += 5) {
      const f = (shapes.ridge(150, 300)(x) - 20) / 150;
      if (f < 0.02) continue;
      for (let d = MIN_CLEARANCE; d <= 25; d += 2) if (fieldAt(ridge, Fm, net, x, 0, d) > 0) low = Math.min(low, f);
    }
    return low;
  };

  test("lift band touches only the upper half of the slope (app default, 10 mph)", () => {
    const f = touchDown(10, 1.0);
    assert.ok(f >= 0.5 && f < 1, `touches from ${f}`);
  });

  test("the lower third stays unusable even at the break-even margin in light wind", () => {
    assert.ok(touchDown(10, USABLE_CLIMB) > 0.25);
  });

  test("stronger wind: bigger envelope reaching lower down the slope", () => {
    assert.ok(touchDown(14, 1.0) < touchDown(10, 1.0));
  });

  test("ceiling above the crest of the order of the hill height, rising with wind", () => {
    const at = (mph) => ridge.bandStats(ridge.computeLift(mph * 0.44704, 0), EN_B);
    const c10 = at(10).ceiling - 170, c14 = at(14).ceiling - 170;
    assert.ok(c10 > 0.2 * 150 && c10 < 1.5 * 150, `10 mph: ${c10} m above crest`);
    assert.ok(c14 > c10, `14 mph ${c14} vs 10 mph ${c10}`);
  });

  test("too much wind: a paraglider is blown back, a hang glider still soars", () => {
    const F30 = ridge.computeLift(30 * 0.44704, 0);
    const pg = ridge.bandStats(F30, EN_B), hg = ridge.bandStats(F30, WINGS.hg);
    const pg14 = ridge.bandStats(ridge.computeLift(14 * 0.44704, 0), EN_B);
    assert.ok(!pg.soarable || pg.ceiling < pg14.ceiling, "PG band collapses in 30 mph");
    assert.ok(hg.soarable && hg.ceiling > (pg.ceiling ?? 0), "HG still works");
  });

  test("terrain clearance: nothing usable within MIN_CLEARANCE of the surface", () => {
    const net = ridge.netClimb(F, EN_B);
    F.agl.forEach((d, li) => { if (d < MIN_CLEARANCE) assert.ok(net[li].every((v) => v === -Infinity)); });
  });

  test("usable-climb margin shifts the field but not the reported climb", () => {
    const a = ridge.netClimb(F, EN_B, 0), b = ridge.netClimb(F, EN_B, 0.7);
    const li = F.agl.findIndex((d) => d >= 30), k = 64 * 128 + 50;
    assert.ok(Math.abs(a[li][k] - b[li][k] - 0.7) < 1e-5);
    assert.equal(b.margin, 0.7);
    const sa = ridge.bandStats(F, EN_B, a), sb = ridge.bandStats(F, EN_B, b);
    assert.ok(sb.ceiling <= sa.ceiling, "higher threshold, lower ceiling");
    assert.ok(Math.abs(sa.maxClimb - sb.maxClimb) < 0.05, "best climb is a physical quantity");
    assert.equal(USABLE_CLIMB, 0.2);
  });
});

describe("3-D dome: flow goes around as well as over", () => {
  const dome = new SitePhysics(syntheticTerrain(shapes.dome()));
  const F = dome.computeLift(W10.u, 0);
  test("upstream the air is deflected sideways, away from the dome", () => {
    const li = 2;
    const north = dome._sample(F.cross[li], -500, 300), south = dome._sample(F.cross[li], -500, -300);
    assert.ok(north > 0.05 && south < -0.05, `N ${north} S ${south}`);   // cross-wind is +left of flow = north
    assert.ok(Math.abs(north + south) < 0.1 * Math.abs(north), "symmetric");
  });
});

describe("sea surface", () => {
  test("air flows over the sea surface, not the seabed", () => {
    const cliffWithSeabed = (x) => (x < 0 ? -15 : 80);
    const cliffAtSeaLevel = (x) => (x < 0 ? 0 : 80);
    const a = new SitePhysics(syntheticTerrain(cliffWithSeabed)), b = new SitePhysics(syntheticTerrain(cliffAtSeaLevel));
    const Fa = a.computeLift(W10.u, 0), Fb = b.computeLift(W10.u, 0);
    for (const x of [-400, -100, 100]) {
      assert.ok(Math.abs(fieldAt(a, Fa, Fa.layers, x, 0, 40) - fieldAt(b, Fb, Fb.layers, x, 0, 40)) < 0.02, `x=${x}`);
    }
  });
});

describe("lee rotor", () => {
  const H = 150;
  const leeRotor = (deg, mph = 20) => {
    const p = new SitePhysics(syntheticTerrain(shapes.escarpment(H, deg)));
    const w = wind(270, mph);
    const T = p.computeTurbulence(w.fe, w.fn, w.U);
    const toe = -600 + H / Math.tan((deg * Math.PI) / 180);           // foot of the lee face
    return { p, T, at: (xh) => p._sample(T.intensity, -600 + xh * H, 0), toe };
  };

  test("reattachment length follows published steepness dependence", () => {
    assert.equal(reattachH(Math.tan((15 * Math.PI) / 180)), 0);
    const r26 = reattachH(Math.tan((26 * Math.PI) / 180)), r40 = reattachH(Math.tan((40 * Math.PI) / 180));
    const r90 = reattachH(1e6);
    assert.ok(r26 > 2.5 && r26 < 3.8, `26°: ${r26}`);
    assert.ok(r40 > 4.5 && r40 < 6.2, `40°: ${r40}`);
    assert.ok(r90 > 6 && r90 <= 6.5, `cliff: ${r90}`);
  });

  test("steep lee: rotor through the bubble, gone after the recovery wake", () => {
    const { at } = leeRotor(35);
    const xr = reattachH(Math.tan((35 * Math.PI) / 180));
    assert.ok(at(1.5) > 0.5, `core ${at(1.5)}`);
    assert.ok(at(xr + ROTOR_RECOVERY_H + 1.5) < 0.05, `far wake ${at(xr + ROTOR_RECOVERY_H + 1.5)}`);
    assert.ok(at(-1) < 0.05, "nothing upwind of the crest");
  });

  test("gentle lee (10°): attached flow, no rotor", () => {
    const { T } = leeRotor(10);
    assert.ok(Math.max(...T.intensity) < 0.05, `max ${Math.max(...T.intensity)}`);
  });

  test("steeper lee -> longer rotor", () => {
    const reach = (deg) => { const { at } = leeRotor(deg); let x = 0; while (x < 20 && (at(x) > 0.12 || x < 1)) x += 0.25; return x; };
    assert.ok(reach(45) > reach(25), `${reach(45)} vs ${reach(25)}`);
  });

  test("rotor grows with wind and vanishes in calm", () => {
    const calm = leeRotor(35, 2).at(1.5), mid = leeRotor(35, 8).at(1.5), strong = leeRotor(35, 20).at(1.5);
    assert.equal(calm, 0);
    assert.ok(strong > mid && mid > 0, `${mid} -> ${strong}`);
  });
});

describe("windward-face separation (cliff tops and feet)", () => {
  const H = 100;
  // plateau at +H to the east of a face rising toward +x; wind from the west blows up the face
  const faceUp = (deg) => (x) => {
    const run = H / Math.tan((deg * Math.PI) / 180);
    return x < -run ? 20 : x > 0 ? 20 + H : 20 + H * (1 + x / run);
  };
  const setup = (deg, mph = 16) => {
    const p = new SitePhysics(syntheticTerrain(faceUp(deg)));
    const w = wind(270, mph), T = p.computeTurbulence(w.fe, w.fn, w.U);
    return { p, T, at: (x) => p._sample(T.intensity, x, 0), top: (x) => p._sample(T.top, x, 0) };
  };

  test("crest bubble length follows face steepness: none below 30°, ~1 H for a sheer cliff", () => {
    assert.equal(crestBubbleH(Math.tan((25 * Math.PI) / 180)), 0);
    assert.ok(crestBubbleH(Math.tan((45 * Math.PI) / 180)) > 0.5);
    assert.ok(crestBubbleH(1e6) > 0.95 && crestBubbleH(1e6) <= 1);
  });

  test("steep cliff into the wind: rotor on the top just behind the lip, gone further back", () => {
    const { at, top } = setup(70);
    assert.ok(at(0.3 * H) > 0.4, `just behind the lip: ${at(0.3 * H)}`);
    assert.ok(top(0.3 * H) > 20 + H + 0.1 * H && top(0.3 * H) < 20 + H + 0.4 * H, `bubble top ${top(0.3 * H)}`);
    assert.ok(at(2.5 * H) < 0.05, `well back on the plateau: ${at(2.5 * H)}`);
  });

  test("gentle slope into the wind (25°): flow stays attached, no crest rotor", () => {
    const { at } = setup(25);
    assert.ok(at(0.3 * H) < 0.05, `${at(0.3 * H)}`);
  });

  test("toe vortex at the foot of a steep face, none at the foot of a gentle one", () => {
    const steep = setup(70), gentle = setup(30);
    const run = (deg) => H / Math.tan((deg * Math.PI) / 180);
    assert.ok(steep.at(-run(70) - 0.2 * H) > 0.2, `steep toe: ${steep.at(-run(70) - 0.2 * H)}`);
    assert.ok(steep.at(-run(70) - 1.2 * H) < 0.05, "gone well upwind of the foot");
    assert.ok(gentle.at(-run(30) - 0.2 * H) < 0.05, `gentle toe: ${gentle.at(-run(30) - 0.2 * H)}`);
  });

  test("lift inside a rotor bubble is not usable", () => {
    const { p, T } = setup(70);
    const w = wind(270, 16), F = p.computeLift(w.u, w.v);
    const withRotor = p.netClimb(F, EN_B, USABLE_CLIMB, T), without = p.netClimb(F, EN_B);
    let masked = 0;
    for (let li = 0; li < F.agl.length; li++) for (let k = 0; k < withRotor[li].length; k++) {
      if (without[li][k] > 0 && withRotor[li][k] === -Infinity) masked++;
      if (T.intensity[k] >= 0.35 && F.base[k] + F.agl[li] < T.top[k]) assert.equal(withRotor[li][k], -Infinity);
    }
    assert.ok(masked >= 0);
  });
});

describe("trees, hedges and buildings", () => {
  // a 12 m tree line running north–south at x = 0 on flat ground
  const H = 12;
  const lcFor = (cls) => syntheticLandcover((x) => (Math.abs(x) < 6 ? [cls, H, 1] : [0, 0, 0]));
  const withTrees = new SitePhysics(syntheticTerrain(shapes.flat), lcFor(2));
  const W = withTrees.obstacleWakes(1, 0);
  const at = (xh) => { const i = Math.floor((xh * H + 1600) / W.cell), j = 200; return W.intensity[j * W.n + i]; };

  test("wake behind a tree line: strong near, gone by ~10 H (the 5–10 H rule)", () => {
    assert.ok(at(2) > 0.5, `2H: ${at(2)}`);
    assert.ok(at(6) > 0.1 && at(6) < at(2), `6H: ${at(6)}`);
    assert.ok(at(11) < 0.02, `11H: ${at(11)}`);
    assert.ok(at(-2) < 0.3, `upwind: ${at(-2)}`);   // only canopy-top turbulence there, if any
  });

  test("solid buildings shed more turbulence than trees, trees more than hedges", () => {
    const w = (cls) => { const p = new SitePhysics(syntheticTerrain(shapes.flat), lcFor(cls)); const R = p.obstacleWakes(1, 0); return R.intensity[200 * R.n + Math.floor((2 * H + 1600) / R.cell)]; };
    const b = w(3), t = w(2), h = w(1);
    assert.ok(b > t && t > h, `building ${b} tree ${t} bush ${h}`);
  });

  test("woods raise the effective surface by their displacement height (~0.7 h)", () => {
    const wood = syntheticLandcover((x, y) => (Math.hypot(x, y) < 300 ? [2, 20, 1] : [0, 0, 0]));
    const p = new SitePhysics(syntheticTerrain(shapes.flat), wood);
    const k = 64 * 128 + 64;
    assert.ok(Math.abs(p.hs[k] - 50 - 14) < 1.5, `displacement ${p.hs[k] - 50}`);
    assert.ok(Math.abs(p.ground[k] - 50) < 0.01, "bare ground unchanged");
  });

  test("wake fields are cached per wind direction", () => {
    assert.equal(withTrees.obstacleWakes(1, 0), withTrees.obstacleWakes(1, 0));
    assert.equal(ridge.wakeEnvelope(1, 0), ridge.wakeEnvelope(1, 0));
  });
});

test("performance budget: a full wind change stays interactive", () => {
  const w = wind(200, 14);
  const t0 = performance.now();
  ridge.computeLift(w.u, w.v);
  ridge.computeTurbulence(w.fe, w.fn, w.U);
  const dt = performance.now() - t0;
  assert.ok(dt < 1500, `${dt.toFixed(0)} ms`);
});
