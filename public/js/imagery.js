// Satellite texture for a site, streamed at runtime from Esri World Imagery
// ("Clarity" — cloud-free over these sites; standard imagery where Clarity has
// no tile). Tiles are stitched into one canvas; the terrain mesh gets exact
// per-vertex UVs from the same local projection the terrain grid uses.

import * as THREE from "three";

const TILE = 256;
const SOURCES = [
  (z, x, y) => `https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
];
export const IMAGERY_CREDIT = "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community";

const lonPx = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const latPx = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
};

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });
}

// Returns { texture, uv(e, n) -> [u, v] }. Throws if nothing could be loaded.
export async function loadSatellite({ lat, lon, windowM }, { zoom = 16, onProgress } = {}) {
  const mLat = 111320, mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const toPx = (e, n) => [lonPx(lon + e / mLon, zoom), latPx(lat + n / mLat, zoom)];
  const h = windowM / 2 + 20;
  const [xa, ya] = toPx(-h, h), [xb, yb] = toPx(h, -h);
  const tx0 = Math.floor(xa / TILE), tx1 = Math.floor(xb / TILE);
  const ty0 = Math.floor(ya / TILE), ty1 = Math.floor(yb / TILE);
  const W = (tx1 - tx0 + 1) * TILE, H = (ty1 - ty0 + 1) * TILE;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext("2d");
  g.fillStyle = "#3d5a3a";
  g.fillRect(0, 0, W, H);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  let done = 0, ok = 0;
  await Promise.all(jobs.map(async ([tx, ty]) => {
    for (const src of SOURCES) {
      try {
        const im = await loadImage(src(zoom, tx, ty));
        g.drawImage(im, (tx - tx0) * TILE, (ty - ty0) * TILE);
        ok++;
        break;
      } catch { /* next source */ }
    }
    onProgress?.(++done / jobs.length);
  }));
  if (!ok) throw new Error("no imagery tiles loaded");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  const ox = tx0 * TILE, oy = ty0 * TILE;
  const uv = (e, n) => {
    const [px, py] = toPx(e, n);
    return [(px - ox) / W, 1 - (py - oy) / H];
  };
  return { texture, uv, tiles: ok };
}
