// Minimal static file server for public/ (no dependencies).
//   node scripts/serve.mjs [port=8123] [host=127.0.0.1]
// Mirrors the production Worker config: real 404s (no SPA fallback), gzip for
// text assets, and the same MIME types.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = Number(process.argv[2] || process.env.PORT || 8123);
const HOST = process.argv[3] || process.env.HOST || "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".json", ".css", ".svg", ".webmanifest", ".txt"]);

export function createServer() {
  return http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) {           // no path traversal
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const headers = { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": "no-cache" };
      const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
      if (gzip) headers["content-encoding"] = "gzip";
      res.writeHead(200, headers);
      if (req.method === "HEAD") return res.end();
      const stream = fs.createReadStream(file);
      (gzip ? stream.pipe(zlib.createGzip()) : stream).pipe(res);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => console.log(`serving ${ROOT} at http://${HOST}:${PORT}/`));
}
