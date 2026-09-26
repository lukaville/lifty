// Write public/data/cfd/index.json: the simulated wind directions per site,
// from the dNNN.bin files present. The app only uses sites listed here.
//   node cfd/index.mjs [dir=public/data/cfd]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2] || path.join(ROOT, "public/data/cfd");
const index = {};
for (const slug of fs.readdirSync(dir).sort()) {
  const sub = path.join(dir, slug);
  if (!fs.statSync(sub).isDirectory()) continue;
  const dirs = fs.readdirSync(sub).filter((f) => /^d\d{3}\.bin$/.test(f))
    .map((f) => { let buf = fs.readFileSync(path.join(sub, f)); if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf); return JSON.parse(buf.subarray(0, buf.indexOf(10)).toString()).dir; })
    .sort((a, b) => a - b);
  if (dirs.length) index[slug] = dirs;
}
fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index) + "\n");
console.log(Object.entries(index).map(([s, d]) => `${s}: ${d.length} directions`).join("\n"));
