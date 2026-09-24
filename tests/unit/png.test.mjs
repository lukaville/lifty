import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOT } from "../helpers/terrain.mjs";
const { encodePNG, decodePNG } = await import(`${ROOT}/scripts/lib/png.mjs`);
const { decodeLandcover } = await import(`${ROOT}/public/js/landcover.js`);

test("PNG encode/decode round trip is lossless", () => {
  const W = 37, H = 23, rgb = Buffer.alloc(W * H * 3);
  for (let k = 0; k < rgb.length; k++) rgb[k] = (k * 131 + 7) & 255;
  const d = decodePNG(encodePNG(W, H, rgb));
  assert.equal(d.width, W); assert.equal(d.height, H); assert.equal(d.channels, 3);
  assert.deepEqual(Buffer.from(d.data), rgb);
});

test("decodePNG rejects non-PNG input", () => {
  assert.throws(() => decodePNG(Buffer.from("definitely not a png")));
});

test("landcover decoding: height ×4, class, cover ×255 — RGB and RGBA", () => {
  const rgb = Uint8Array.from([40, 2, 255, 0, 0, 0, 255, 3, 128, 9, 1, 51]);
  const lc = decodeLandcover(rgb, 2, 3200, 3);
  assert.equal(lc.cell, 1600);
  assert.deepEqual(Array.from(lc.height), [10, 0, 63.75, 2.25]);
  assert.deepEqual(Array.from(lc.cls), [2, 0, 3, 1]);
  assert.ok(Math.abs(lc.cover[0] - 1) < 1e-6 && Math.abs(lc.cover[3] - 0.2) < 1e-6);
  const rgba = Uint8Array.from([40, 2, 255, 255, 0, 0, 0, 255, 255, 3, 128, 255, 9, 1, 51, 255]);
  assert.deepEqual(Array.from(decodeLandcover(rgba, 2, 3200, 4).cls), [2, 0, 3, 1]);
});
