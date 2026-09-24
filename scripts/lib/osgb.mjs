// WGS84 lat/lon -> OSGB36 British National Grid easting/northing (EPSG:27700).
// Helmert datum shift (~5 m accuracy, far below the 25 m physics grid) followed by
// the Ordnance Survey Transverse Mercator projection ("A guide to coordinate
// systems in Great Britain", OS 2020).

const rad = Math.PI / 180;

function toCartesian(lat, lon, a, b) {
  const e2 = 1 - (b * b) / (a * a);
  const s = Math.sin(lat), c = Math.cos(lat);
  const nu = a / Math.sqrt(1 - e2 * s * s);
  return [nu * c * Math.cos(lon), nu * c * Math.sin(lon), (1 - e2) * nu * s];
}

function fromCartesian([x, y, z], a, b) {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 8; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * nu * Math.sin(lat), p);
  }
  return [lat, Math.atan2(y, x)];
}

// WGS84 -> OSGB36 Helmert parameters
const TX = -446.448, TY = 125.157, TZ = -542.06, S = 20.4894e-6;
const RX = (-0.1502 / 3600) * rad, RY = (-0.247 / 3600) * rad, RZ = (-0.8421 / 3600) * rad;

export function wgs84ToBNG(latDeg, lonDeg) {
  const [x1, y1, z1] = toCartesian(latDeg * rad, lonDeg * rad, 6378137.0, 6356752.3142);
  const x2 = TX + (1 + S) * x1 - RZ * y1 + RY * z1;
  const y2 = TY + RZ * x1 + (1 + S) * y1 - RX * z1;
  const z2 = TZ - RY * x1 + RX * y1 + (1 + S) * z1;
  const [lat, lon] = fromCartesian([x2, y2, z2], 6377563.396, 6356256.909);

  // Airy 1830, national grid TM
  const a = 6377563.396, b = 6356256.909, F0 = 0.9996012717;
  const lat0 = 49 * rad, lon0 = -2 * rad, N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a), n = (a - b) / (a + b);
  const sl = Math.sin(lat), cl = Math.cos(lat), tl = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sl * sl);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sl * sl, 1.5);
  const eta2 = nu / rho - 1;
  const dl = lat - lat0, sl2 = lat + lat0;
  const M = b * F0 * (
    (1 + n + (5 / 4) * n * n + (5 / 4) * n ** 3) * dl
    - (3 * n + 3 * n * n + (21 / 8) * n ** 3) * Math.sin(dl) * Math.cos(sl2)
    + ((15 / 8) * n * n + (15 / 8) * n ** 3) * Math.sin(2 * dl) * Math.cos(2 * sl2)
    - (35 / 24) * n ** 3 * Math.sin(3 * dl) * Math.cos(3 * sl2));
  const I = M + N0;
  const II = (nu / 2) * sl * cl;
  const III = (nu / 24) * sl * cl ** 3 * (5 - tl * tl + 9 * eta2);
  const IIIA = (nu / 720) * sl * cl ** 5 * (61 - 58 * tl * tl + tl ** 4);
  const IV = nu * cl;
  const V = (nu / 6) * cl ** 3 * (nu / rho - tl * tl);
  const VI = (nu / 120) * cl ** 5 * (5 - 18 * tl * tl + tl ** 4 + 14 * eta2 - 58 * tl * tl * eta2);
  const L = lon - lon0;
  return {
    E: E0 + IV * L + V * L ** 3 + VI * L ** 5,
    N: I + II * L * L + III * L ** 4 + IIIA * L ** 6,
  };
}
