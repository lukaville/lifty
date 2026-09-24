import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { ROOT } from "../helpers/terrain.mjs";
const { createServer } = await import(`${ROOT}/scripts/serve.mjs`);

let server, base;
before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("serves the app shell and ES modules with the right MIME types", async () => {
  const html = await fetch(base + "/");
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /text\/html/);
  assert.match(await html.text(), /<canvas id="scene"[ >]/);
  const js = await fetch(base + "/js/physics.js");
  assert.match(js.headers.get("content-type"), /javascript/);
});

test("missing files are real 404s (no SPA fallback), like production", async () => {
  const r = await fetch(base + "/data/terrain/nope.json");
  assert.equal(r.status, 404);
});

test("path traversal is refused", async () => {
  const r = await fetch(base + "/..%2f..%2fpackage.json");
  assert.ok(r.status === 403 || r.status === 404);
});

test("text assets are gzipped when accepted", async () => {
  const r = await fetch(base + "/data/sites.json", { headers: { "accept-encoding": "gzip" } });
  assert.equal(r.headers.get("content-encoding"), "gzip");
  const body = JSON.parse(await r.text());          // fetch transparently inflates
  assert.ok(body.sites.length >= 1);
  assert.ok(zlib);
});
