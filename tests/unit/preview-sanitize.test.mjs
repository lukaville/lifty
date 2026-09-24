// The PR-preview sanitiser guards what untrusted pull requests can publish.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../helpers/terrain.mjs";

const SCRIPT = path.join(ROOT, "scripts/preview-sanitize.mjs");
function run(files, setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-"));
  const src = path.join(dir, "src"), out = path.join(dir, "out");
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), content);
  }
  setup?.(src);
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, src, out], { encoding: "utf8", stdio: "pipe" });
    return { ok: true, stdout, out, list: (p = "") => fs.readdirSync(path.join(out, p)).sort() };
  } catch (e) {
    return { ok: false, stderr: String(e.stderr), out };
  }
}

test("the real app passes and is copied unchanged, plus a noindex _headers", () => {
  const r = run({}, (src) => fs.cpSync(path.join(ROOT, "public"), src, { recursive: true }));
  assert.ok(r.ok, r.stderr);
  assert.ok(r.list().includes("index.html") && r.list().includes("data"));
  assert.match(fs.readFileSync(path.join(r.out, "_headers"), "utf8"), /X-Robots-Tag: noindex/);
});

test("server-side code and routing files are dropped", () => {
  const r = run({
    "index.html": "<p>hi</p>", "_worker.js": "export default {}", "_redirects": "/ https://evil.example 302",
    "_headers": "/*\n  Set-Cookie: x", "_routes.json": "{}", "functions/api.js": "export function onRequest(){}",
    ".env": "SECRET=1",
  });
  assert.ok(r.ok, r.stderr);
  assert.deepEqual(r.list(), ["_headers", "index.html"]);
  assert.doesNotMatch(fs.readFileSync(path.join(r.out, "_headers"), "utf8"), /Set-Cookie/);
  assert.match(r.stdout, /dropped: .*_worker\.js/);
});

test("disallowed file types, symlinks and missing index are rejected", () => {
  assert.equal(run({ "index.html": "x", "tool.exe": "MZ" }).ok, false);
  assert.equal(run({ "index.html": "x", "page.php": "<?php" }).ok, false);
  assert.equal(run({ "index.html": "x" }, (src) => fs.symlinkSync("/etc/passwd", path.join(src, "leak.txt"))).ok, false);
  assert.equal(run({ "app.js": "x" }).ok, false);
});

test("size and file-count caps", () => {
  const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`f/${i}.txt`, "x"]));
  const r = run({ "index.html": "x", ...many });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /too many files/);
  const big = run({ "index.html": "x" }, (src) => fs.writeFileSync(path.join(src, "big.png"), Buffer.alloc(26 * 1024 * 1024)));
  assert.equal(big.ok, false);
  assert.match(big.stderr, /too large/);
});
