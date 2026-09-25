// Write idealised terrains (same format as public/data/terrain) for validating
// the CFD against published hill / escarpment behaviour and the app's models.
//   node cfd/synthetic.mjs            -> cfd/runs/synthetic/<name>.json
// Shapes run north–south, so a wind from 270° (west) blows across them in +x.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { syntheticTerrain } = await import(path.join(ROOT, "tests/helpers/terrain.mjs"));

const H = 100;
const ramp = (deg) => (x) => {                     // plateau of height H east of x = 0, face rising toward +x
  const run = H / Math.tan((deg * Math.PI) / 180);
  return x < -run ? 20 : x > 0 ? 20 + H : 20 + H * (1 + x / run);
};
export const SHAPES = {
  "ridge-23deg": (x) => 20 + 150 * Math.exp(-(x * x) / 300 ** 2),
  "escarpment-30deg": ramp(30),
  "escarpment-45deg": ramp(45),
  "cliff-75deg": ramp(75),
};
const out = path.join(ROOT, "cfd/runs/synthetic");
fs.mkdirSync(out, { recursive: true });
for (const [name, f] of Object.entries(SHAPES)) {
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(syntheticTerrain(f)));
  console.log(path.join(out, `${name}.json`));
}
