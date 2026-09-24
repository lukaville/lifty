// Instanced 3-D models for the trees, bushes, buildings and masts detected from LiDAR +
// imagery (scripts/fetch-surface.mjs). Every instance is placed, sized and
// tinted from its own measurements: crown top height and spread for trees, the
// oriented footprint, eaves height and roof rise for buildings, and the colour
// the satellite sees there.

import * as THREE from "three";

// deterministic hash noise, so crowns are lumpy but stable between loads
function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

// A lumpy, slightly irregular crown: subdivided icosahedron with noise, darker
// underneath (cheap ambient occlusion baked into vertex colours).
function crownGeometry(seed, detail = 1) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const n = 0.78 + 0.34 * hash3(Math.round(v.x * 3) + seed, Math.round(v.y * 3), Math.round(v.z * 3));
    v.multiplyScalar(n);
    p.setXYZ(i, v.x, v.y, v.z);
    const ao = 0.55 + 0.45 * (v.y * 0.5 + 0.5);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// Walls: unit box standing on y=0. Roof: unit gabled prism, ridge along x,
// eaves at y=0, ridge at y=1, overhanging slightly.
function wallGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}
function roofGeometry() {
  const o = 0.54; // half-width incl. overhang
  const L = 0.52;
  const v = [
    // two slopes
    -L, 0, -o,  L, 0, -o,  L, 1, 0,   -L, 0, -o,  L, 1, 0,  -L, 1, 0,
    -L, 0, o,  -L, 1, 0,   L, 1, 0,   -L, 0, o,   L, 1, 0,   L, 0, o,
    // gable ends
    -L, 0, -o,  -L, 1, 0,  -L, 0, o,   L, 0, -o,  L, 0, o,   L, 1, 0,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

const tmpC = new THREE.Color();
// imagery colours are dark and hazy; lift them into a plausible foliage range
function foliage(rgb, variation) {
  tmpC.setRGB(((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255, THREE.SRGBColorSpace);
  const hsl = {};
  tmpC.getHSL(hsl);
  const h = hsl.h > 0.12 && hsl.h < 0.45 ? hsl.h : 0.26 + (hsl.h - 0.26) * 0.3;
  tmpC.setHSL(h + (variation - 0.5) * 0.03, Math.min(0.55, hsl.s * 1.25 + 0.12), Math.min(0.32, Math.max(0.12, hsl.l * 0.95 + 0.03)));
  return tmpC;
}

export function buildVegetation({ lc, groundAt, worldY, exag, castShadow = true }) {
  const group = new THREE.Group();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const stats = { trees: 0, bushes: 0, buildings: 0, masts: 0 };

  // ---- trees: crown + trunk
  const leaf = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const bark = new THREE.MeshStandardMaterial({ color: 0x4a3b2c, roughness: 1 });
  const variants = [crownGeometry(1), crownGeometry(7), crownGeometry(13)];
  const trunkG = new THREE.CylinderGeometry(0.1, 0.16, 1, 5);
  trunkG.translate(0, 0.5, 0);
  const trees = lc.trees || [];
  const perVariant = variants.map(() => []);
  trees.forEach((t, i) => perVariant[i % variants.length].push(t));
  const trunks = new THREE.InstancedMesh(trunkG, bark, trees.length);
  let ti = 0;
  perVariant.forEach((list, vi) => {
    const mesh = new THREE.InstancedMesh(variants[vi], leaf, list.length);
    list.forEach(([e, n, h, r, rgb], i) => {
      const g = groundAt(e, n);
      const var_ = hash3(e, n, 3);
      const crownH = Math.min(h * 0.62, r * 2.2);      // crown depth
      const cy = g + h - crownH / 2;
      q.setFromAxisAngle(up, var_ * Math.PI * 2);
      s.set(r * (0.9 + 0.2 * var_), (crownH / 2) * exag, r * (1.1 - 0.2 * var_));
      p.set(e, worldY(cy), -n);
      mesh.setMatrixAt(i, m4.compose(p, q, s));
      mesh.setColorAt(i, foliage(rgb, var_));
      // trunk up into the crown
      s.set(r * 0.9, (h - crownH * 0.6) * exag, r * 0.9);
      p.set(e, worldY(g), -n);
      trunks.setMatrixAt(ti++, m4.compose(p, q, s));
    });
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  });
  trunks.castShadow = castShadow;
  group.add(trunks);
  stats.trees = trees.length;

  // ---- bushes: low, wide, sitting on the ground
  const bushes = lc.bushes || [];
  if (bushes.length) {
    const bushG = crownGeometry(21, 1);
    const mesh = new THREE.InstancedMesh(bushG, leaf, bushes.length);
    bushes.forEach(([e, n, h, r, rgb], i) => {
      const g = groundAt(e, n), var_ = hash3(e, n, 5);
      q.setFromAxisAngle(up, var_ * 6.283);
      s.set(r * 1.1, (h / 2) * exag * 1.05, r * (0.8 + 0.4 * var_));
      p.set(e, worldY(g + h * 0.45), -n);
      mesh.setMatrixAt(i, m4.compose(p, q, s));
      const c = foliage(rgb, var_);
      c.offsetHSL(0.01, 0, 0.03);
      mesh.setColorAt(i, c);
    });
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    stats.bushes = bushes.length;
  }

  // ---- buildings: walls + gabled or flat roof
  const blds = lc.buildings || [];
  if (blds.length) {
    const wallMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    const roofMat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide });
    const walls = new THREE.InstancedMesh(wallGeometry(), wallMat, blds.length);
    const pitched = blds.filter((b) => b[6] >= 0.8);
    const flats = blds.filter((b) => b[6] < 0.8);
    const roofs = new THREE.InstancedMesh(roofGeometry(), roofMat, Math.max(1, pitched.length));
    const flatRoofs = new THREE.InstancedMesh(wallGeometry(), roofMat, Math.max(1, flats.length));
    roofs.count = pitched.length;
    flatRoofs.count = flats.length;
    let ri = 0, fi = 0;
    blds.forEach(([e, n, len, wid, ang, eaves, rise, rgb], i) => {
      // sit on the lowest ground under the footprint so nothing floats
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let g = Infinity;
      for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]]) {
        g = Math.min(g, groundAt(e + a * len * ca - b * wid * sa, n + a * len * sa + b * wid * ca));
      }
      const var_ = hash3(e, n, 9);
      // footprint axes: local x along `ang` (east=0, CCW); world z = −north
      q.setFromAxisAngle(up, ang);
      const wallH = Math.max(2.4, eaves);
      s.set(len * 0.94, (wallH + 0.5) * exag, wid * 0.94);
      p.set(e, worldY(g - 0.5), -n);
      walls.setMatrixAt(i, m4.compose(p, q, s));
      tmpC.setHSL(0.09 + var_ * 0.04, 0.18 + var_ * 0.12, 0.62 + var_ * 0.18);
      walls.setColorAt(i, tmpC);
      tmpC.setRGB(((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255, THREE.SRGBColorSpace);
      const hsl = {}; tmpC.getHSL(hsl);
      tmpC.setHSL(hsl.h, Math.min(0.5, hsl.s), Math.min(0.55, Math.max(0.18, hsl.l)));
      if (rise >= 0.8) {
        // ridge runs along the longer side
        s.set(len, Math.min(rise, wid * 0.7) * exag, wid);
        p.set(e, worldY(g + wallH), -n);
        roofs.setMatrixAt(ri, m4.compose(p, q, s));
        roofs.setColorAt(ri++, tmpC);
      } else {
        s.set(len * 0.98, 0.35 * exag, wid * 0.98);
        p.set(e, worldY(g + wallH), -n);
        flatRoofs.setMatrixAt(fi, m4.compose(p, q, s));
        flatRoofs.setColorAt(fi++, tmpC);
      }
    });
    for (const m of [walls, roofs, flatRoofs]) { m.castShadow = castShadow; m.receiveShadow = true; group.add(m); }
    stats.buildings = blds.length;
  }
  // ---- masts, pylons and poles: slim tapered grey structures with an
  // equipment platform near the top (heights from the LiDAR)
  const masts = lc.masts || [];
  if (masts.length) {
    const metal = new THREE.MeshStandardMaterial({ color: 0xb9c0c7, roughness: 0.5, metalness: 0.6 });
    const shaftG = new THREE.CylinderGeometry(0.35, 0.9, 1, 6);
    shaftG.translate(0, 0.5, 0);
    const platG = new THREE.CylinderGeometry(1.2, 1.2, 0.5, 8);
    const shafts = new THREE.InstancedMesh(shaftG, metal, masts.length);
    const plats = new THREE.InstancedMesh(platG, metal, masts.length);
    masts.forEach(([e, n, h], i) => {
      const g = groundAt(e, n);
      q.identity();
      s.set(1, h * exag, 1); p.set(e, worldY(g), -n);
      shafts.setMatrixAt(i, m4.compose(p, q, s));
      s.set(1, 1, 1); p.set(e, worldY(g + h * 0.82), -n);
      plats.setMatrixAt(i, m4.compose(p, q, s));
    });
    for (const m of [shafts, plats]) { m.castShadow = castShadow; group.add(m); }
    stats.masts = masts.length;
  }
  group.userData.stats = stats;
  return group;
}

// A windsock on the take-off: red/white cone that hangs down in light air and
// streams out horizontally from about 15 knots, pointing downwind.
export function buildWindsock(exag) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 6),
    new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.6, roughness: 0.4 }));
  pole.position.y = 3;
  pole.scale.y = exag;
  pole.position.y *= exag;
  g.add(pole);
  const sockG = new THREE.CylinderGeometry(0.2, 0.42, 3.2, 12, 5, true);
  sockG.rotateZ(-Math.PI / 2);            // along +x
  sockG.translate(1.6, 0, 0);
  const pa = sockG.attributes.position, col = new Float32Array(pa.count * 3);
  for (let i = 0; i < pa.count; i++) {
    const band = Math.floor((pa.getX(i) / 3.2) * 5 - 1e-4);
    const red = band % 2 === 0;
    col[i * 3] = red ? 0.9 : 0.95; col[i * 3 + 1] = red ? 0.25 : 0.95; col[i * 3 + 2] = red ? 0.12 : 0.95;
  }
  sockG.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const sock = new THREE.Mesh(sockG, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 }));
  const pivot = new THREE.Group();
  pivot.position.y = 6 * exag;
  pivot.add(sock);
  g.add(pivot);
  g.userData = { pivot, sock };
  return g;
}

// wind speed (m/s at 10 m) and flow direction (east, north) -> sock pose
export function poseWindsock(sock, windMs, fe, fn, t) {
  const kt = windMs * 1.94384;
  const ext = Math.max(0.08, Math.min(1, kt / 15));
  const droop = (1 - ext) * 1.35;                        // radians below horizontal
  const flutter = 0.06 * Math.sin(t * (4 + kt * 0.3)) * ext;
  const { pivot } = sock.userData;
  pivot.rotation.set(0, Math.atan2(fn, fe) + flutter, -droop + flutter * 0.5, "YXZ");
}
