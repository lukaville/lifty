// Validate and sanitise an untrusted PR preview before it is uploaded to
// Cloudflare Pages (used by .github/workflows/preview-deploy.yml, always run
// from main — never from the PR's own code).
//
//   node scripts/preview-sanitize.mjs <untrusted-dir> <out-dir>
//
// Only plain static files are allowed through. Everything that could make
// Cloudflare run code or change routing/headers is dropped:
//   _worker.js / functions/   (server-side code: Pages Functions, metered)
//   _redirects / _headers / _routes.json
// Symlinks and special files are rejected, file types are allow-listed, and
// the size and file count are capped. Exits non-zero on anything suspicious.

import fs from "node:fs";
import path from "node:path";

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error("usage: preview-sanitize.mjs <src> <out>"); process.exit(2); }

const ALLOWED = new Set([".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".txt",
  ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".woff", ".woff2"]);
const DROP = new Set(["_worker.js", "_redirects", "_headers", "_routes.json"]);
const MAX_FILES = 2000;
const MAX_FILE = 25 * 1024 * 1024;       // Cloudflare Pages per-file limit
const MAX_TOTAL = 100 * 1024 * 1024;

let files = 0, total = 0;
const problems = [], dropped = [];

function walk(rel) {
  const abs = path.join(src, rel);
  for (const name of fs.readdirSync(abs)) {
    const r = path.join(rel, name), a = path.join(src, r);
    const st = fs.lstatSync(a);
    if (st.isSymbolicLink()) { problems.push(`symlink: ${r}`); continue; }
    if (st.isDirectory()) {
      if (rel === "" && name === "functions") { dropped.push(r + "/"); continue; }
      walk(r);
      continue;
    }
    if (!st.isFile()) { problems.push(`not a regular file: ${r}`); continue; }
    if (rel === "" && DROP.has(name)) { dropped.push(r); continue; }
    if (name.startsWith(".")) { dropped.push(r); continue; }
    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED.has(ext)) { problems.push(`file type not allowed: ${r}`); continue; }
    if (st.size > MAX_FILE) { problems.push(`too large (${st.size} B): ${r}`); continue; }
    files++; total += st.size;
    const dest = path.join(out, r);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // read + write rather than copyFileSync: libuv's copy_file_range fast path
    // can spin forever on some Linux filesystems (seen in Docker)
    fs.writeFileSync(dest, fs.readFileSync(a));
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
walk("");
if (files > MAX_FILES) problems.push(`too many files: ${files} > ${MAX_FILES}`);
if (total > MAX_TOTAL) problems.push(`too large in total: ${(total / 1e6).toFixed(1)} MB > ${MAX_TOTAL / 1e6} MB`);
if (!fs.existsSync(path.join(out, "index.html"))) problems.push("no index.html");

// our own headers: previews are not for search engines
fs.writeFileSync(path.join(out, "_headers"), "/*\n  X-Robots-Tag: noindex, nofollow\n");

if (dropped.length) console.log(`dropped: ${dropped.join(", ")}`);
if (problems.length) {
  console.error("preview rejected:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`ok: ${files} files, ${(total / 1e6).toFixed(1)} MB`);
