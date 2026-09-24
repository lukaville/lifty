import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOT } from "../helpers/terrain.mjs";
const { fft, fft2d } = await import(`${ROOT}/public/js/fft.js`);

const rnd = (n, seed = 1) => { let s = seed; return Float64Array.from({ length: n }, () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5); };

test("1-D forward + inverse is the identity", () => {
  const re = rnd(64), im = rnd(64, 7), r0 = re.slice(), i0 = im.slice();
  fft(re, im, false); fft(re, im, true);
  for (let k = 0; k < 64; k++) { assert.ok(Math.abs(re[k] - r0[k]) < 1e-12); assert.ok(Math.abs(im[k] - i0[k]) < 1e-12); }
});

test("impulse has a flat spectrum; constant has only DC", () => {
  const re = new Float64Array(32), im = new Float64Array(32);
  re[0] = 1; fft(re, im);
  for (let k = 0; k < 32; k++) { assert.ok(Math.abs(re[k] - 1) < 1e-12 && Math.abs(im[k]) < 1e-12); }
  const c = new Float64Array(32).fill(2), ci = new Float64Array(32);
  fft(c, ci);
  assert.ok(Math.abs(c[0] - 64) < 1e-9);
  for (let k = 1; k < 32; k++) assert.ok(Math.hypot(c[k], ci[k]) < 1e-9);
});

test("a pure cosine lands in the right bins (sign convention e^{-ikx} forward)", () => {
  const n = 64, re = new Float64Array(n), im = new Float64Array(n);
  for (let j = 0; j < n; j++) re[j] = Math.sin((2 * Math.PI * 3 * j) / n);
  fft(re, im);
  // sin = (e^{i} - e^{-i}) / 2i  ->  bin 3 = -i n/2, bin n-3 = +i n/2
  assert.ok(Math.abs(im[3] + n / 2) < 1e-9 && Math.abs(im[n - 3] - n / 2) < 1e-9);
});

test("2-D round trip and Parseval", () => {
  const n = 32, re = rnd(n * n, 3), im = new Float64Array(n * n), r0 = re.slice();
  const e0 = r0.reduce((s, v) => s + v * v, 0);
  fft2d(re, im, n, false);
  const e1 = re.reduce((s, v, k) => s + v * v + im[k] * im[k], 0) / (n * n);
  assert.ok(Math.abs(e1 - e0) / e0 < 1e-10, "energy preserved");
  fft2d(re, im, n, true);
  for (let k = 0; k < n * n; k++) assert.ok(Math.abs(re[k] - r0[k]) < 1e-12);
});
