// Random numbers for the visualisation. Normally Math.random; the test mode
// (?test) seeds a deterministic generator so screenshots are reproducible.

let state = 0;
let seeded = false;

// mulberry32: tiny, fast, good enough for particle placement
function mulberry32() {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function seedRandom(seed) {
  state = seed | 0;
  seeded = true;
}

export function rand() {
  return seeded ? mulberry32() : Math.random();
}

// Independent seeded streams, so separate consumers (tracers, rotor sprites)
// don't shift each other's sequence: a change in how many rotor sprites are
// drawn then leaves every tracer where it was in test screenshots.
export function stream(name) {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let st = 0, init = false;
  return () => {
    if (!seeded) return Math.random();
    if (!init) { st = (state ^ h) | 0; init = true; }
    st = (st + 0x6d2b79f5) | 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
