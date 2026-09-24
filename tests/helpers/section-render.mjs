// Render a vertical cross-section of a SitePhysics wind solution as an RGB
// image — the wind simulation itself, no viewer involved. The section runs
// along the wind through (0, 0); wind blows left -> right.
//
// Three stacked panels, same axes (x along the flow, z altitude):
//   1. vertical air velocity w — diverging blue (sink) / white / red (lift),
//      with flow streamlines traced through the full 2-D velocity field
//   2. usable net climb for a wing — violet where you can gain height,
//      with the net = 0 boundary outlined
//   3. rotor / turbulence intensity — orange, up to the turbulent layer's top
// Terrain is drawn in green-brown, the sea surface in blue, and the lee
// separation bubble (air the outer flow rides over) with light grey hatching.

import { physics, fieldAt } from "./terrain.mjs";

const { sinkRate } = physics;

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const TERRAIN = [118, 128, 86], TERRAIN_EDGE = [70, 60, 40], SEA = [70, 130, 175], NODATA = [236, 238, 242];

// diverging colour map for w, ±wMax m/s
function wColour(w, wMax) {
  const t = Math.max(-1, Math.min(1, w / wMax));
  return t >= 0 ? mix([250, 250, 250], [178, 24, 43], Math.pow(t, 0.8)) : mix([250, 250, 250], [33, 102, 172], Math.pow(-t, 0.8));
}
const climbColour = (c, cMax) => (c > 0 ? mix([214, 196, 250], [88, 28, 170], Math.min(1, c / cMax)) : [244, 244, 246]);
const turbColour = (i) => (i > 0.02 ? mix([253, 232, 200], [215, 60, 20], Math.min(1, i)) : [246, 246, 246]);

/**
 * @returns {{ width, height, rgb: Uint8Array }}
 */
export function renderSection(p, { fe, fn, U, wing, margin = physics.USABLE_CLIMB, x0 = -1200, x1 = 900, zMax = 420, width = 700, panelH = 180, wMax = 3, cMax = 3 }) {
  const F = p.computeLift(fe * U, fn * U);
  const T = p.computeTurbulence(fe, fn, U);
  const net = p.netClimb(F, wing, margin, T);
  const gap = 4, height = panelH * 3 + gap * 2;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const put = (px, py, c) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const o = (py * width + px) * 3;
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  };
  const X = (px) => x0 + ((px + 0.5) / width) * (x1 - x0);
  const Z = (py) => zMax * (1 - (py + 0.5) / panelH);
  const topAgl = F.agl[F.agl.length - 1];

  // per-column terrain and field samplers
  const cols = [];
  for (let px = 0; px < width; px++) {
    const s = X(px), x = fe * s, y = fn * s;
    cols.push({ x, y, ground: p._sample(p.ground, x, y), base: p._sample(F.base, x, y), sea: p._sample(p.h, x, y) < 0,
      turb: p._sample(T.intensity, x, y), turbTop: p._sample(T.top, x, y) });
  }

  for (let panel = 0; panel < 3; panel++) {
    const oy = panel * (panelH + gap);
    const netGrid = new Float32Array(width * panelH);
    for (let py = 0; py < panelH; py++) {
      const z = Z(py);
      for (let px = 0; px < width; px++) {
        const c = cols[px];
        let colour;
        if (z < c.ground) colour = z > c.ground - 2 ? TERRAIN_EDGE : TERRAIN;
        else if (c.sea && z < 1.5) colour = SEA;
        else {
          const d = z - c.base;
          if (d > topAgl) colour = NODATA;
          // under the effective surface but above ground = the separation bubble
          else if (d < 0) colour = ((px + py) >> 2) % 2 ? [226, 222, 214] : [238, 235, 229];
          else if (panel === 0) colour = wColour(fieldAt(p, F, F.layers, c.x, c.y, Math.max(d, F.agl[0])), wMax);
          else if (panel === 1) {
            const v = d < F.agl[0] ? -Infinity : fieldAt(p, F, net, c.x, c.y, d);
            netGrid[py * width + px] = v;
            colour = climbColour(v, cMax);
          } else colour = turbColour(z <= c.turbTop ? c.turb : 0);
        }
        put(px, oy + py, colour);
      }
    }
    if (panel === 1) {
      // outline the usable-lift boundary
      for (let py = 1; py < panelH; py++) for (let px = 1; px < width; px++) {
        const a = netGrid[py * width + px] > 0, b = netGrid[py * width + px - 1] > 0, c = netGrid[(py - 1) * width + px] > 0;
        if (a !== b || a !== c) put(px, oy + py, [60, 20, 110]);
      }
    }
  }

  // streamlines on the w panel: integrate the in-section velocity (along-wind
  // speed and w) in terrain-following coordinates, as the viewer's tracers do
  const starts = [10, 25, 45, 70, 100, 140, 190, 250, 320];
  for (const d0 of starts) {
    let s = x0, d = d0;
    const ds = 2;
    for (let step = 0; step < 4000 && s < x1; step++) {
      const x = fe * s, y = fn * s;
      const base = p._sample(F.base, x, y);
      const u = Math.max(0.3, fieldAt(p, F, F.spd, x, y, Math.max(d, F.agl[0])));
      const w = fieldAt(p, F, F.layers, x, y, Math.max(d, F.agl[0]));
      // slope of the effective surface along the section
      const g = (p._sample(F.base, x + fe, y + fn) - p._sample(F.base, x - fe, y - fn)) / 2;
      d = Math.max(1, d + (w / u - g) * ds);
      s += ds;
      const z = base + d;
      if (d > topAgl) break;
      const px = Math.round(((s - x0) / (x1 - x0)) * width - 0.5), py = Math.round((1 - z / zMax) * panelH - 0.5);
      if (py >= 0 && py < panelH) put(px, py, [40, 40, 40]);
    }
  }

  // colour-scale bars at the right edge of each panel (w: ±wMax, climb: 0..cMax, turbulence: 0..1)
  for (let py = 0; py < panelH - 20; py++) {
    const t = 1 - py / (panelH - 21);
    for (let bx = width - 10; bx < width - 3; bx++) {
      put(bx, 10 + py, wColour((t * 2 - 1) * wMax, wMax));
      put(bx, panelH + gap + 10 + py, climbColour(t * cMax, cMax));
      put(bx, 2 * (panelH + gap) + 10 + py, turbColour(t));
    }
  }
  return { width, height, rgb, field: F, net, turb: T };
}

// compare two RGB images: fraction of pixels differing by more than `tol` in any channel
export function diffImages(a, b, tol = 10) {
  if (a.width !== b.width || a.height !== b.height) return { ratio: 1, diff: null };
  const diff = new Uint8Array(a.rgb.length);
  let bad = 0;
  for (let k = 0; k < a.width * a.height; k++) {
    const o = k * 3;
    const d = Math.max(Math.abs(a.rgb[o] - b.rgb[o]), Math.abs(a.rgb[o + 1] - b.rgb[o + 1]), Math.abs(a.rgb[o + 2] - b.rgb[o + 2]));
    if (d > tol) { bad++; diff[o] = 255; diff[o + 1] = 0; diff[o + 2] = 80; }
    else { const g = (a.rgb[o] + a.rgb[o + 1] + a.rgb[o + 2]) / 9 + 170; diff[o] = diff[o + 1] = diff[o + 2] = g; }
  }
  return { ratio: bad / (a.width * a.height), diff: { width: a.width, height: a.height, rgb: diff } };
}
