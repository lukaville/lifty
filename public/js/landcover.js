// Landcover raster (scripts/fetch-surface.mjs): an 8-bit RGB PNG on a grid of
// n×n cells covering the site window, row 0 = SOUTH edge.
//   R = obstacle height × 4 (m), G = class (0 open, 1 bush, 2 tree, 3 building),
//   B = obstacle cover fraction × 255.
export const LC_CLASSES = ["open", "bush", "tree", "building"];

export function decodeLandcover(rgb, n, windowM, channels = 3) {
  const height = new Float32Array(n * n), cls = new Uint8Array(n * n), cover = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) {
    height[k] = rgb[k * channels] / 4;
    cls[k] = rgb[k * channels + 1];
    cover[k] = rgb[k * channels + 2] / 255;
  }
  return { n, cell: windowM / n, height, cls, cover };
}

// Browser: fetch and decode without any colour management or premultiplication,
// so the bytes come back exactly as written.
export async function loadLandcover(url, n, windowM) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`landcover ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return decodeLandcover(g.getImageData(0, 0, bmp.width, bmp.height).data, n, windowM, 4);
}
