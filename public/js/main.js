import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SitePhysics, WINGS, DEFAULT_WING, USABLE_CLIMB } from "./physics.js";
import { loadLandcover } from "./landcover.js";
import { loadSatellite, IMAGERY_CREDIT } from "./imagery.js";
import { buildVegetation, buildWindsock, poseWindsock } from "./vegetation.js";
import { AirViz } from "./airviz.js";
import { seedRandom } from "./rng.js";
import { SiteBrowser } from "./sitebrowser.js";
import { CfdStore, cfdFields } from "./cfd.js";

// ---------------------------------------------------------------- URL options
//   ?site=<slug>&dir=<deg>&mph=<n>&lift=<m/s>&wing=<key>   deep link to a state
//   ?imagery=off                                          elevation colours only
//   ?test[&seed=n]   deterministic mode for automated tests: seeded randomness,
//                    no network imagery, animation advanced only by __view.settle()
const PARAMS = new URLSearchParams(location.search);
const TEST = PARAMS.has("test");
if (TEST) seedRandom(Number(PARAMS.get("seed") || 1));
const IMAGERY = !TEST && PARAMS.get("imagery") !== "off";
// Precomputed simulated flow where a site has it (cfd/): the FluidX3D
// large-eddy simulations in data/les/. ?cfd=off forces the fast built-in
// model; test mode uses it unless ?cfd=on. ?flow=rans loads OpenFOAM results
// from data/cfd/ instead, for comparison (not deployed; pack them there locally
// with cfd/pack.mjs).
const CFD = TEST ? PARAMS.get("cfd") === "on" : PARAMS.get("cfd") !== "off";
const cfdStore = new CfdStore(PARAMS.get("flow") === "rans" ? "./data/cfd/" : "./data/les/");

// ---------------------------------------------------------------- constants
// Vertical exaggeration (visual only; all physics uses true metres). Trees and
// buildings are exaggerated by the same factor so the air around them lines up.
const EXAG = 1.4;
const MS_PER_MPH = 0.44704;
const FT = 3.28084;
const SKY_TOP = new THREE.Color(0x5d8fc9), SKY_HORIZON = new THREE.Color(0xc9dbea);

// ---------------------------------------------------------------- scene setup
const canvas = document.getElementById("scene");
// phones / tablets: lighter GPU load (pixel ratio, shadow map, tracer count)
const MOBILE = matchMedia("(max-width: 760px), (pointer: coarse)").matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(SKY_HORIZON, 3500, 11000);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 2, 40000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;

// sky dome: horizon haze to zenith blue, brighter toward the sun
const sunDir = new THREE.Vector3(-0.45, 0.62, 0.64).normalize();   // afternoon sun from the SSW
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(20000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: SKY_TOP }, horizon: { value: SKY_HORIZON }, sun: { value: sunDir } },
    vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sun; varying vec3 vD;
      void main(){ float h = max(vD.y, 0.0); vec3 c = mix(horizon, top, pow(h, 0.55));
        float s = max(dot(normalize(vD), sun), 0.0); c += vec3(1.0,0.93,0.8) * (pow(s, 40.0) * 0.6 + pow(s, 4.0) * 0.08);
        if (vD.y < 0.0) c = horizon * 0.92; gl_FragColor = vec4(c, 1.0); }`,
  })
);
scene.add(sky);

scene.add(new THREE.HemisphereLight(0xdbe9f7, 0x6b6045, 1.25));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(MOBILE ? 2048 : 4096, MOBILE ? 2048 : 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 1.2;
const sc = sun.shadow.camera;
sc.left = -1900; sc.right = 1900; sc.top = 1900; sc.bottom = -1900; sc.near = 10; sc.far = 9000;
scene.add(sun, sun.target);

// group holding everything for the active site (cleared on switch)
let siteGroup = new THREE.Group();
scene.add(siteGroup);

// ---------------------------------------------------------------- state
const app = {
  sites: [], site: null, terrain: null, phys: null, lc: null,
  dirDeg: 330, speedMph: 14, minLift: 1.0,
  wing: DEFAULT_WING,
  liftField: null, turbField: null, fineWake: null, net: null, stats: null,
  viz: null, veg: null, windsock: null, windArrow: null, terrainMesh: null,
  satellite: null, satLoaded: false, loadToken: 0,
  show: { tracers: true, band: true, rotor: true, wind: true, veg: true },
  needsRecompute: false, lastCompute: 0,
  loading: true, simTime: 0,
};

// ---------------------------------------------------------------- helpers
const CARD16 = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const cardinal = (deg) => CARD16[Math.round(((deg % 360) / 22.5)) % 16];
const worldY = (elev) => (elev - app.terrain.minH) * EXAG;

function inArc(deg, a, b) {
  deg = ((deg % 360) + 360) % 360;
  if (a <= b) return deg >= a && deg <= b;
  return deg >= a || deg <= b;
}
function arcCenter(a, b) {
  const span = ((b - a + 360) % 360);
  return ((a + span / 2) % 360);
}
function lerp3(a, b, t) {
  return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
}

// elevation colour ramp (0..1), with sea below 0
const RAMP = [
  [0.00, [0x3f/255,0x6b/255,0x39/255]],
  [0.35, [0x6f/255,0x8c/255,0x49/255]],
  [0.60, [0x9c/255,0x9a/255,0x5f/255]],
  [0.80, [0xb6/255,0xab/255,0x8c/255]],
  [1.00, [0xdd/255,0xd6/255,0xc4/255]],
];
function terrainColor(elev, minH, relief) {
  if (elev < 0) {
    const d = Math.min(1, -elev / 25);
    return lerp3([0.16,0.34,0.48], [0.06,0.16,0.28], d);
  }
  let t = relief > 0 ? (elev - minH) / relief : 0;
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const f = (t - RAMP[i-1][0]) / (RAMP[i][0] - RAMP[i-1][0]);
      return lerp3(RAMP[i-1][1], RAMP[i][1], f);
    }
  }
  return RAMP[RAMP.length-1][1];
}


// ---------------------------------------------------------------- terrain mesh
function decodeGrid(g, n) {
  const raw = atob(g.heights_b64), h = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) h[k] = g.offset + (raw.charCodeAt(k * 2) | (raw.charCodeAt(k * 2 + 1) << 8)) * g.scale;
  return h;
}

function buildTerrain() {
  const t = app.terrain, half = t.windowM / 2;
  const R = t.render || { n: t.n, heights_b64: t.heights_b64, offset: t.offset, scale: t.scale };
  const n = R.n, cell = t.windowM / (n - 1);
  const h = decodeGrid(R, n);
  const relief = t.maxH - Math.max(0, t.minH);
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, e = -half + i * cell, no = -half + j * cell;
    pos[k * 3] = e; pos[k * 3 + 1] = worldY(h[k]); pos[k * 3 + 2] = -no;
    const c = terrainColor(h[k], Math.max(0, t.minH), relief);
    col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  siteGroup.add(mesh);
  app.terrainMesh = mesh;
  app.renderGrid = { n, cell, h };

  // diorama skirt: earth-coloured walls down from the edge of the window
  const base = worldY(Math.min(0, t.minH) - 45);
  const skirt = [];
  const edge = (i, j) => { const k = j * n + i; return [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]]; };
  const sides = [[(s) => [s, 0]], [(s) => [n - 1, s]], [(s) => [n - 1 - s, n - 1]], [(s) => [0, n - 1 - s]]];
  for (const [f] of sides) for (let s = 0; s < n - 1; s++) {
    const [i0, j0] = f(s), [i1, j1] = f(s + 1);
    const a = edge(i0, j0), b = edge(i1, j1);
    skirt.push(...a, a[0], base, a[2], ...b, ...b, a[0], base, a[2], b[0], base, b[2]);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute("position", new THREE.Float32BufferAttribute(skirt, 3));
  sg.computeVertexNormals();
  siteGroup.add(new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ color: 0x6b5a45, roughness: 1, side: THREE.DoubleSide })));

  // sea
  app.water = t.minH < 0 ? buildWater(h, n, t) : null;
  if (app.water) siteGroup.add(app.water);
}

// Sea surface: procedural wind-driven waves (sum of directional wave trains
// plus fine chop, all advancing downwind), Fresnel sky reflection, sun glint,
// colour graded by the real bathymetry (turquoise over the chalk platform, deep
// blue offshore), surf where it shoals and whitecaps once the wind picks up.
function buildWater(h, n, t) {
  const windowM = t.windowM;
  // Depth from the terrarium bathymetry: over the sea the LiDAR "ground" is the
  // water surface at survey time (≈ −3 m everywhere), not the seabed.
  let bathy = null;
  if (t.terrarium_b64) {
    const tn = t.n, tg = decodeGrid({ heights_b64: t.terrarium_b64, ...t.terrarium }, tn), tc = windowM / (tn - 1);
    bathy = (e, no) => {
      const fi = (e + windowM / 2) / tc, fj = (no + windowM / 2) / tc;
      const i0 = Math.max(0, Math.min(tn - 2, Math.floor(fi))), j0 = Math.max(0, Math.min(tn - 2, Math.floor(fj)));
      const tx = Math.min(1, Math.max(0, fi - i0)), ty = Math.min(1, Math.max(0, fj - j0)), k = j0 * tn + i0;
      return tg[k] * (1 - tx) * (1 - ty) + tg[k + 1] * tx * (1 - ty) + tg[k + tn] * (1 - tx) * ty + tg[k + tn + 1] * tx * ty;
    };
  }
  const depth = new Uint8Array(n * n), cell = windowM / (n - 1);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    let dz = -h[k];
    if (bathy && h[k] < 0.5) dz = Math.max(dz, -bathy(-windowM / 2 + i * cell, -windowM / 2 + j * cell));
    depth[k] = Math.round(Math.min(1, Math.max(0, dz / 20)) * 255);
  }
  const depthTex = new THREE.DataTexture(depth, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  depthTex.magFilter = depthTex.minFilter = THREE.LinearFilter;
  depthTex.needsUpdate = true;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 }, depthTex: { value: depthTex }, sun: { value: sunDir },
      skyTop: { value: SKY_TOP }, skyHorizon: { value: SKY_HORIZON },
      wind: { value: new THREE.Vector2(1, 0) }, windMs: { value: 6 }, windowM: { value: windowM },
    },
    vertexShader: `varying vec2 vUv; varying vec3 vW;
      void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float time; uniform sampler2D depthTex; uniform vec3 sun; uniform vec3 skyTop; uniform vec3 skyHorizon;
      uniform vec2 wind; uniform float windMs; uniform float windowM;
      varying vec2 vUv; varying vec3 vW;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
      // Sea surface slope: 12 wave trains spread ±70° around the wind with
      // random wavelengths (deep-water dispersion c = sqrt(g/k)), plus animated
      // multi-scale noise, so the chop is irregular rather than corduroy.
      vec2 waves(vec2 p, float t, float fp, out float crest){
        vec2 g = vec2(0.0); crest = 0.0;
        float amp = 0.015 + 0.01 * windMs;
        for (int i = 0; i < 12; i++){
          float fi = float(i);
          float ang = (hash(vec2(fi, 3.1)) - 0.5) * 2.4;
          vec2 d = vec2(wind.x * cos(ang) - wind.y * sin(ang), wind.x * sin(ang) + wind.y * cos(ang));
          float lambda = 2.5 + 30.0 * pow(hash(vec2(fi, 7.7)), 1.6);
          float k = 6.2832 / lambda, c = sqrt(9.81 / k);
          float ph = k * dot(d, p) - k * c * t + hash(vec2(fi, 1.3)) * 6.2832;
          // fade waves shorter than ~2 pixels (fp = pixel footprint, m) to avoid aliasing
          float a = amp * (0.35 + lambda / 30.0) / 1.35 * smoothstep(2.0, 5.0, lambda / fp);
          g += d * a * k * cos(ph);
          crest += a * sin(ph);
        }
        return g;
      }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
      vec2 chop(vec2 p, float t, float fp){
        vec2 q = p * 0.35 + wind * t * 0.6;
        float e = 0.15;
        float h0 = fbm(q), hx = fbm(q + vec2(e, 0.0)), hy = fbm(q + vec2(0.0, e));
        return vec2(hx - h0, hy - h0) / e * (0.12 + 0.02 * windMs) * smoothstep(1.2, 0.3, fp);
      }
      void main(){
        vec2 p = vec2(vW.x, -vW.z);
        float fp = max(length(fwidth(p)), 0.05);
        float crest;
        vec2 g = waves(p, time, fp, crest);
        g += chop(p, time, fp);
        // longer, slower undulation keeps texture visible from a distance
        g += (vec2(noise(p * 0.04 + wind * time * 0.05), noise(p.yx * 0.04 - time * 0.03)) - 0.5) * 0.1;
        vec3 N = normalize(vec3(-g.x, 1.0, g.y));
        vec3 V = normalize(cameraPosition - vW);
        vec3 R = reflect(-V, N);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 sky = mix(skyHorizon, skyTop, pow(clamp(R.y, 0.0, 1.0), 0.5));
        float d = texture2D(depthTex, vUv).r;                       // 0 = shore, 1 = 20 m+
        // matched to a photo of the sea off Newhaven: clear mid teal-blue,
        // darker blue in the troughs (linear-light values; sRGB ≈ 40/140/170 and 20/95/140)
        vec3 shallow = vec3(0.03, 0.30, 0.38), deep = vec3(0.012, 0.13, 0.24);
        vec3 body = mix(shallow, deep, smoothstep(0.02, 0.45, d));
        body *= 0.8 + 0.35 * clamp(crest * 6.0 + 0.5, 0.0, 1.0);        // brighter crests, darker troughs
        float diffuse = 0.55 + 0.45 * max(dot(N, sun), 0.0);
        vec3 col = mix(body * diffuse, sky * 0.85, fres);
        float spec = pow(max(dot(R, sun), 0.0), 380.0) * 5.0 + pow(max(dot(R, sun), 0.0), 40.0) * 0.25;
        col += vec3(1.0, 0.95, 0.85) * spec;
        // glitter: tiny facets from fine chop catching the sun
        float facet = noise(p * 2.6 + vec2(time * 1.7, -time * 1.3));
        float glint = smoothstep(0.86, 0.97, facet) * pow(max(dot(R, sun), 0.0), 6.0) * smoothstep(1.5, 0.4, fp);
        col += vec3(1.0, 0.97, 0.9) * glint * 1.6;
        // surf line where it shoals, plus whitecaps above ~12 kt
        float n1 = noise(p * 0.35 + vec2(time * 0.4, 0.0));
        float surf = smoothstep(0.025, 0.0, d) * smoothstep(0.55, 0.9, n1 + 0.35 * sin(time * 1.3 + dot(p, wind) * 0.12));
        float caps = smoothstep(6.0, 11.0, windMs) * smoothstep(0.82, 0.95, noise(p * 0.12 - wind * time * 0.8) + crest * 3.0);
        col = mix(col, vec3(0.92, 0.95, 0.97), clamp(surf * 0.65 + caps * 0.55, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.extensions = { derivatives: true };
  const wp = new THREE.Mesh(new THREE.PlaneGeometry(windowM, windowM), mat);
  wp.rotation.x = -Math.PI / 2;
  wp.position.y = worldY(0) + 0.3;
  return wp;
}

// ground height under (e, n) from the render mesh — what the eye sees
function groundAt(e, n) {
  const G = app.renderGrid, half = app.terrain.windowM / 2;
  const fi = (e + half) / G.cell, fj = (n + half) / G.cell;
  const i0 = Math.max(0, Math.min(G.n - 2, Math.floor(fi))), j0 = Math.max(0, Math.min(G.n - 2, Math.floor(fj)));
  const tx = Math.min(1, Math.max(0, fi - i0)), ty = Math.min(1, Math.max(0, fj - j0));
  const k = j0 * G.n + i0, h = G.h;
  return h[k] * (1 - tx) * (1 - ty) + h[k + 1] * tx * (1 - ty) + h[k + G.n] * (1 - tx) * ty + h[k + G.n + 1] * tx * ty;
}

async function applySatellite(token) {
  const t = app.terrain, site = app.site;
  try {
    const sat = await loadSatellite({ lat: site.lat, lon: site.lon, windowM: t.windowM });
    if (token !== app.loadToken) { sat.texture.dispose(); return; }
    const mesh = app.terrainMesh, n = app.renderGrid.n, cell = app.renderGrid.cell, half = t.windowM / 2;
    const uv = mesh.geometry.attributes.uv;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const [u, v] = sat.uv(-half + i * cell, -half + j * cell);
      uv.setXY(j * n + i, u, v);
    }
    uv.needsUpdate = true;
    sat.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    app.satellite = sat.texture;
    app.satLoaded = true;
    setSatellite(true);
  } catch (e) {
    console.warn("satellite imagery unavailable, using elevation colours", e);
  }
}
function setSatellite(on) {
  const m = app.terrainMesh?.material;
  if (!m) return;
  m.map = on && app.satellite ? app.satellite : null;
  m.vertexColors = !m.map;
  m.color.set(m.map ? 0xffffff : 0xffffff);
  m.needsUpdate = true;
}

// ---------------------------------------------------------------- wind arrow
// A clean 3-D arrow floating high on the upwind side, pointing downwind.
function buildWindArrow() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xeaf4ff, emissive: 0x3a6b9a, emissiveIntensity: 0.5,
    roughness: 0.4, transparent: true, opacity: 0.82 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 1, 16), mat);
  const head = new THREE.Mesh(new THREE.ConeGeometry(22, 60, 20), mat);
  shaft.rotation.z = head.rotation.z = -Math.PI / 2;     // along +x
  const arrow = new THREE.Group();
  arrow.add(shaft, head);
  arrow.userData = { shaft, head };
  siteGroup.add(arrow);
  app.windArrow = arrow;
}
function updateWindArrow() {
  const b = app.dirDeg * Math.PI / 180;
  const fe = -Math.sin(b), fn = -Math.cos(b);       // flow (to) direction
  const A = app.windArrow, { shaft, head } = A.userData;
  const len = 160 + 22 * app.speedMph;              // longer in stronger wind
  shaft.scale.y = len; shaft.position.x = len / 2;
  head.position.x = len + 30;
  A.rotation.set(0, Math.atan2(fn, fe), 0);
  const r = app.terrain.windowM * 0.36;
  A.position.set(-fe * r, worldY(app.terrain.maxH) + 230, fn * r);
  A.visible = app.show.wind;
}

// ---------------------------------------------------------------- recompute
function recompute() {
  const b = app.dirDeg * Math.PI / 180;
  const fe = -Math.sin(b), fn = -Math.cos(b);
  const spd = app.speedMph * MS_PER_MPH;
  const wing = WINGS[app.wing];
  const slug = app.site.slug;
  // One model throughout: the simulations, or (?cfd=off) the fast model. A
  // simulated view never falls back to the fast model: missing data is an error.
  if (CFD) {
    const pair = cfdStore.pair(slug, app.dirDeg, () => { if (app.site?.slug === slug) TEST ? recompute() : scheduleRecompute(); });
    if (!pair) {
      const why = cfdStore.problem(slug, app.dirDeg);
      if (why) showFlowError(why);
      app.needsRecompute = false;           // still loading: keep the current view until it arrives
      return;
    }
    ({ field: app.liftField, turb: app.turbField } = cfdFields(app.phys, pair, fe, fn, spd));
    if (app.flowError) clearFlowError();
  } else {
    app.liftField = app.phys.computeLift(fe * spd, fn * spd);
    app.turbField = app.phys.computeTurbulence(fe, fn, spd);
  }
  app.fineWake = app.phys.obstacleWakes(fe, fn);
  app.net = app.phys.netClimb(app.liftField, wing, app.minLift, app.turbField);
  app.stats = app.phys.bandStats(app.liftField, wing, app.net);
  app.stats.obstacleTurb = obstacleTurbNearTakeoff(spd);
  app.viz.setFields({ field: app.liftField, net: app.net, turb: app.turbField, fine: app.fineWake, wing, speed: spd });
  updateWindArrow();
  app.browser?.refresh();
  if (app.water) {
    app.water.material.uniforms.wind.value.set(fe, fn);
    app.water.material.uniforms.windMs.value = spd;
  }
  updateStatus();
  app.lastCompute = performance.now();
  app.needsRecompute = false;
}
function scheduleRecompute() { app.needsRecompute = true; }

// the simulated airflow can't be shown: say so, and show no airflow at all
function showFlowError(why) {
  app.flowError = why;
  app.liftField = app.turbField = app.net = app.stats = null;
  if (app.viz) app.viz.field = null;
  const el = document.getElementById("loading");
  el.style.display = "flex"; el.style.opacity = "1"; el.classList.add("error");
  document.getElementById("loadingText").textContent =
    `Airflow simulation unavailable: ${why}. Reload to try again, or open the page with ?cfd=off for the fast built-in model.`;
}
function clearFlowError() {
  app.flowError = null;
  const el = document.getElementById("loading");
  el.classList.remove("error"); el.style.opacity = "0"; el.style.display = "none";
}

// strongest tree / building turbulence within 150 m of take-off (0..1)
function obstacleTurbNearTakeoff(spd) {
  const W = app.fineWake;
  if (!W) return 0;
  const half = app.terrain.windowM / 2, fac = Math.min(1.4, Math.max(0, (spd - 1.5) / 6));
  let m = 0;
  for (let j = 0; j < W.n; j++) for (let i = 0; i < W.n; i++) {
    const x = -half + (i + 0.5) * W.cell, y = -half + (j + 0.5) * W.cell;
    // the launch area and the air flowing onto it — not the lee behind it
    if (x * x + y * y < 120 * 120 && x * app.liftField.fe + y * app.liftField.fn < 25) {
      m = Math.max(m, W.intensity[j * W.n + i] * fac);
    }
  }
  return Math.min(1, m);
}

// ---------------------------------------------------------------- status / UI
function updateStatus() {
  const s = app.site;
  document.getElementById("dirDeg").textContent = Math.round(app.dirDeg)+"°";
  document.getElementById("dirCard").textContent = cardinal(app.dirDeg);
  document.getElementById("spdVal").textContent = app.speedMph;
  document.getElementById("spdVal2").textContent = app.speedMph;
  document.getElementById("spdKmh").textContent = Math.round(app.speedMph*1.60934)+" km/h";
  document.getElementById("sheetSummary").textContent =
    `Wind ${Math.round(app.dirDeg)}° ${cardinal(app.dirDeg)} · ${app.speedMph} mph`;

  const [a,bnd] = [s.windFrom[0], s.windFrom[1]];
  const on = inArc(app.dirDeg, a, bnd);
  const band = s.strengthBand_mph;
  const st2 = app.stats;
  const wing = WINGS[app.wing];
  // What matters on the hill is the wind there, not the forecast: take-off
  // wind includes the crest speed-up, and the air the pilot soars in is faster
  // again (wind gradient). A wing only makes progress upwind if it can outfly
  // the wind in the lift band it is actually flying in.
  const toMph = st2 ? st2.windTakeoff/MS_PER_MPH : app.speedMph;
  const aloft = st2 ? (st2.windBand ?? st2.windAloft) : app.speedMph*MS_PER_MPH;
  let cls, txt;
  if (app.speedMph < 3) { cls="warn"; txt="Calm — nothing to soar"; }
  else if (!on) { cls="bad"; txt=`Off wind (${cardinal(app.dirDeg)}) — this site won't work`; }
  else if (aloft >= wing.vMax*0.95) { cls="bad"; txt="Too strong — you cannot penetrate, even at full speed"; }
  else if (aloft >= wing.trim) { cls="bad"; txt="Too strong aloft — faster than trim speed, you'll be pushed back"; }
  else if (!st2 || !st2.soarable) { cls="warn"; txt="Not soarable — lift is weaker than your sink rate"; }
  else if (toMph < band[0]) { cls="warn"; txt="Light — soaring may be marginal"; }
  else if (toMph > band[1]) { cls="bad"; txt="Strong — serious rotor & penetration risk"; }
  else { cls="good"; txt="Good soaring window"; }

  // realistic band readout
  const bandEl = document.getElementById("bandInfo");
  if (st2 && st2.soarable) {
    const ft = Math.round(st2.ceilingAboveTakeoff*FT);
    bandEl.innerHTML =
      `Best climb <b>${st2.maxClimb.toFixed(1)} m/s</b> · realistic top of lift band ` +
      `<b>~${ft} ft</b> above take-off <span class="dim">(${Math.round(st2.ceiling*FT)} ft amsl)</span>`;
  } else {
    bandEl.innerHTML = `<span class="dim">No soarable band — a ${wing.label.toLowerCase()} ` +
      `sinks at ${wing.minSink} m/s or more and the air here isn't rising that fast.</span>`;
  }
  if (st2) {
    bandEl.innerHTML += `<br><span class="dim">Wind on take-off ≈ ${Math.round(toMph)} mph (hand-held) · ` +
      `${Math.round(aloft/MS_PER_MPH)} mph ${st2.windBand != null ? "in the lift band" : "at 200 ft"} (gradient + speed-up)</span>`;
  }
  bandEl.innerHTML += app.liftField?.source === "cfd"
    ? `<br><span class="dim">Airflow: ${app.liftField.les ? "FluidX3D LES" : "OpenFOAM"} simulation (${app.liftField.dirs.map((d) => Math.round(d) + "°").join(" / ")} blended)</span>`
    : `<br><span class="dim">Airflow: fast model</span>`;
  // wakes shed by trees, hedges and buildings (LiDAR landcover) around take-off
  if (st2 && on && st2.obstacleTurb > 0.3) {
    bandEl.innerHTML += `<br><span style="color:var(--warn)">⚠ ${st2.obstacleTurb > 0.6 ? "Strong" : "Moderate"} ` +
      `turbulence from trees / buildings near take-off</span>`;
  }

  const colors = { good:"var(--good)", warn:"var(--warn)", bad:"var(--bad)" };
  const st = document.getElementById("status");
  st.style.background = `color-mix(in srgb, ${colors[cls]} 16%, transparent)`;
  st.style.color = colors[cls];
  st.querySelector(".dot").style.background = colors[cls];
  st.querySelector(".txt").textContent = txt;
}


// ---------------------------------------------------------------- compass dial
const dial = document.getElementById("dial");
const dctx = dial.getContext("2d");
const DCX=100, DCY=100, DR=78;
function d2xy(deg, r){ const a=deg*Math.PI/180; return [DCX+r*Math.sin(a), DCY-r*Math.cos(a)]; }
function drawDial() {
  dctx.clearRect(0,0,200,200);
  // base ring
  dctx.beginPath(); dctx.arc(DCX,DCY,DR,0,Math.PI*2);
  dctx.fillStyle="rgba(255,255,255,0.03)"; dctx.fill();
  dctx.lineWidth=2; dctx.strokeStyle="#2b3946"; dctx.stroke();
  // working-wind arc
  if (app.site) {
    const a=app.site.windFrom[0], b=app.site.windFrom[1];
    const span=((b-a+360)%360);
    dctx.lineWidth=8; dctx.strokeStyle="#3fae7a"; dctx.lineCap="round";
    dctx.beginPath();
    for (let d=0; d<=span; d+=1.5) {
      const [x,y]=d2xy(a+d, DR);
      if (d===0) dctx.moveTo(x,y); else dctx.lineTo(x,y);
    }
    dctx.stroke();
  }
  // ticks + labels
  dctx.fillStyle="#9fb0c0"; dctx.font="10px Inter, sans-serif";
  dctx.textAlign="center"; dctx.textBaseline="middle";
  for (let d=0; d<360; d+=30) {
    const [x1,y1]=d2xy(d,DR-4), [x2,y2]=d2xy(d,DR-11);
    dctx.beginPath(); dctx.moveTo(x1,y1); dctx.lineTo(x2,y2);
    dctx.strokeStyle="#3a4a5a"; dctx.lineWidth=1; dctx.stroke();
  }
  for (const [lab,deg] of [["N",0],["E",90],["S",180],["W",270]]) {
    const [x,y]=d2xy(deg, DR-24);
    dctx.fillStyle = deg===0 ? "#ff6a5a" : "#c8d4de";
    dctx.fillText(lab,x,y);
  }
  // current wind FROM: arrow pointing inward (the way wind blows)
  const [fx,fy]=d2xy(app.dirDeg, DR);
  const [tx,ty]=d2xy(app.dirDeg, 20);
  dctx.strokeStyle="#9fe0ff"; dctx.lineWidth=3; dctx.lineCap="round";
  dctx.beginPath(); dctx.moveTo(fx,fy); dctx.lineTo(tx,ty); dctx.stroke();
  // source dot
  dctx.beginPath(); dctx.arc(fx,fy,6,0,Math.PI*2); dctx.fillStyle="#9fe0ff"; dctx.fill();
  // arrow head at centre
  const ah=app.dirDeg*Math.PI/180;
  dctx.save(); dctx.translate(tx,ty); dctx.rotate(ah+Math.PI);
  dctx.beginPath(); dctx.moveTo(0,-9); dctx.lineTo(6,4); dctx.lineTo(-6,4); dctx.closePath();
  dctx.fillStyle="#9fe0ff"; dctx.fill(); dctx.restore();
  // centre hub
  dctx.beginPath(); dctx.arc(DCX,DCY,3,0,Math.PI*2); dctx.fillStyle="#5a6a7a"; dctx.fill();
}
let dialDrag=false;
function dialSet(ev){
  const r=dial.getBoundingClientRect();
  // canvas is 200×200 internally but CSS-scaled; map pointer to canvas pixels
  const px=((ev.touches?ev.touches[0].clientX:ev.clientX)-r.left)*dial.width/r.width;
  const py=((ev.touches?ev.touches[0].clientY:ev.clientY)-r.top)*dial.height/r.height;
  let deg=Math.atan2(px-DCX, -(py-DCY))*180/Math.PI;
  deg=((deg%360)+360)%360;
  app.dirDeg=Math.round(deg);
  drawDial(); scheduleRecompute();
}
dial.addEventListener("pointerdown", e=>{dialDrag=true; dial.setPointerCapture(e.pointerId); dialSet(e);});
dial.addEventListener("pointermove", e=>{ if(dialDrag) dialSet(e); });
dial.addEventListener("pointerup", ()=>dialDrag=false);


// ---------------------------------------------------------------- site loading
async function loadSite(slug) {
  const token = ++app.loadToken;
  app.loading = true;
  const loading = document.getElementById("loading");
  loading.style.opacity = "1";
  loading.style.display = "flex";
  document.getElementById("loadingText").textContent = "Loading terrain & LiDAR landcover…";
  const site = app.sites.find((s) => s.slug === slug);
  // default wind = centre of working arc, or the deep-linked one on first load
  const dir0 = app.pendingDir ?? Math.round(arcCenter(site.windFrom[0], site.windFrom[1]));
  app.pendingDir = null;
  const [, terrain, lcRaster, lcObjects] = await Promise.all([
    // a simulated site's first view is already the simulation: fetch it alongside
    CFD ? cfdStore.ensure(slug, dir0) : null,
    fetch(`./data/terrain/${slug}.json`).then((r) => r.json()),
    loadLandcover(`./data/landcover/${slug}.png`, 800, 3200).catch(() => null),
    fetch(`./data/landcover/${slug}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (token !== app.loadToken) return;
  app.site = site;
  app.terrain = terrain;
  app.lc = lcObjects;
  document.getElementById("loadingText").textContent = "Computing airflow…";
  await new Promise((r) => setTimeout(r, 10));
  app.phys = new SitePhysics(terrain, lcRaster);

  // reset scene group
  if (app.viz) app.viz.dispose();
  scene.remove(siteGroup);
  siteGroup.traverse((o) => { o.geometry?.dispose(); });
  siteGroup = new THREE.Group();
  scene.add(siteGroup);
  app.satellite?.dispose();
  app.satellite = null; app.satLoaded = false;

  buildTerrain();
  buildWindArrow();
  if (lcObjects) {
    app.veg = buildVegetation({ lc: lcObjects, groundAt, worldY, exag: EXAG });
    app.veg.visible = app.show.veg;
    siteGroup.add(app.veg);
  } else app.veg = null;
  app.windsock = buildWindsock(EXAG);
  app.windsock.position.set(0, worldY(groundAt(0, 0)), 0);
  siteGroup.add(app.windsock);
  app.viz = new AirViz(siteGroup, { phys: app.phys, worldY, exag: EXAG, tracers: MOBILE ? 1300 : 2600 });
  Object.assign(app.viz.show, { tracers: app.show.tracers, band: app.show.band, rotor: app.show.rotor });

  app.dirDeg = dir0;

  // camera: from behind-and-above the pilot's shoulder... i.e. looking INTO the
  // wind at the face of the ridge, slightly from the side
  const wm = terrain.windowM, b = app.dirDeg * Math.PI / 180;
  const ue = Math.sin(b), un = Math.cos(b);          // toward where the wind comes from
  const tY = worldY(groundAt(0, 0));
  controls.target.set(0, tY, 0);
  // portrait screens have a narrow horizontal field of view: back off to fit
  const fit = camera.aspect < 1 ? Math.pow(1 / camera.aspect, 0.5) : 1;
  const dist = wm * 0.62 * fit, side = 0.45;
  camera.position.set((ue - un * side) * dist, tY + wm * 0.3, -(un + ue * side) * dist);
  controls.minDistance = 60; controls.maxDistance = wm * 2.2;
  controls.update();
  sun.position.copy(sunDir).multiplyScalar(5000);
  sun.target.position.set(0, 0, 0);

  // info panel
  // (site data is contributed: text only, never innerHTML)
  document.getElementById("siteName").textContent = site.name;
  document.getElementById("siteMeta").textContent = [site.workingWind, `take-off ${site.takeoffAmsl_ft} ft`,
    `${site.relief_ft} ft relief`, site.region, site.gridRef].filter(Boolean).join(" · ");
  document.getElementById("siteChar").textContent = site.character || "";
  const hz = document.getElementById("siteHazard");
  hz.replaceChildren();
  if (site.hazards) { const b = document.createElement("b"); b.textContent = "Hazards: "; hz.append(b, site.hazards); }
  const src = document.getElementById("siteSource");
  src.replaceChildren();
  if (site.club) {
    src.append("Site information: ");
    const a = document.createElement("a");
    a.textContent = `${site.club} site guide`;
    if (/^https:\/\//.test(site.source || "")) { a.href = site.source; a.target = "_blank"; a.rel = "noopener"; }
    src.append(a, ". Always follow the club's own guide and briefings.");
  }
  app.browser.setCurrent(slug);
  // keep the URL shareable
  const u = new URL(location.href);
  u.searchParams.set("site", slug);
  history.replaceState(null, "", u);

  drawDial();
  app.flowError = null;
  loading.classList.remove("error");
  recompute();
  fitViewToPanels();
  if (!app.flowError) {
    loading.style.opacity = "0";
    setTimeout(() => { if (token === app.loadToken && !app.flowError) loading.style.display = "none"; }, TEST ? 0 : 500);
  }
  app.loading = false;
  if (IMAGERY) applySatellite(token);
}

// ---------------------------------------------------------------- controls wiring
const speedEl = document.getElementById("speed");
speedEl.addEventListener("input", () => { app.speedMph = +speedEl.value; document.getElementById("spdVal2").textContent = app.speedMph; scheduleRecompute(); });

const minLiftEl = document.getElementById("minLift");
minLiftEl.value = app.minLift;
function syncMinLift() { document.getElementById("minLiftVal").textContent = app.minLift.toFixed(1); }
syncMinLift();
minLiftEl.addEventListener("input", () => { app.minLift = +minLiftEl.value; syncMinLift(); scheduleRecompute(); });

const wingEl = document.getElementById("wing");
for (const [key, w] of Object.entries(WINGS)) {
  const o = document.createElement("option");
  o.value = key; o.textContent = w.label; o.selected = key === DEFAULT_WING;
  wingEl.appendChild(o);
}
function syncWingLabel() { const w = WINGS[app.wing]; document.getElementById("wingSink").textContent = `min sink ${w.minSink} m/s · trim ${Math.round(w.trim * 3.6)} km/h`; }
syncWingLabel();
wingEl.addEventListener("change", () => { app.wing = wingEl.value; syncWingLabel(); recompute(); });
for (const [id, key] of [["tBand", "band"], ["tFlow", "tracers"], ["tRotor", "rotor"],
                         ["tVeg", "veg"], ["tWind", "wind"]]) {
  document.getElementById(id).addEventListener("change", (e) => {
    app.show[key] = e.target.checked;
    if (key in app.viz.show) app.viz.show[key] = e.target.checked;
    if (key === "veg" && app.veg) app.veg.visible = e.target.checked;
    if (key === "wind") updateWindArrow();
  });
}
document.getElementById("credits").textContent =
  `${IMAGERY_CREDIT} · LiDAR © Environment Agency (OGL v3) · Terrain: Mapzen/SRTM`;
// phone layout: collapsible wind sheet and site-info card
const controlsEl = document.getElementById("controls"), handleEl = document.getElementById("sheetHandle");
const infoEl = document.getElementById("info");
function setSheet(open) {
  controlsEl.classList.toggle("open", open);
  handleEl.setAttribute("aria-expanded", String(open));
  if (open) { infoEl.classList.remove("open"); drawDial(); }
  fitViewToPanels();
}
let sheetSwiped = false;          // a swipe on the handle shouldn't also count as a tap
handleEl.addEventListener("click", () => {
  if (sheetSwiped) { sheetSwiped = false; return; }
  if (isPhone()) setSheet(!controlsEl.classList.contains("open"));
  else setCollapsed(controlsEl, handleEl, !controlsEl.classList.contains("collapsed"));
});

// Desktop: the Wind, Site and Legend panels collapse to their header. The
// state is a per-browser convenience (localStorage; failures are ignored).
// On phones these panels use the sheet / card behaviour instead.
function isPhone() { return matchMedia("(max-width: 760px)").matches; }
const PANEL_KEY = "lifty:panels";
let panelState = {};
try { panelState = JSON.parse(localStorage.getItem(PANEL_KEY) || "{}") || {}; } catch { /* private mode */ }
function setCollapsed(panel, button, collapsed) {
  panel.classList.toggle("collapsed", collapsed);
  button.setAttribute("aria-expanded", String(!collapsed));
  if (!collapsed && panel === controlsEl) drawDial();
  panelState[panel.id] = collapsed;
  try { localStorage.setItem(PANEL_KEY, JSON.stringify(panelState)); } catch { /* ignore */ }
}

// Swipe gestures for the bottom sheet: drag down to close (from the handle, or
// anywhere on the sheet once it is scrolled to the top), drag up to open.
// Sliders, the wing selector and the dial keep their own touch behaviour.
{
  let y0 = 0, t0 = 0, dy = 0, tracking = false, dragging = false;
  controlsEl.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || e.target.closest("input, select, #dial")) { tracking = false; return; }
    tracking = true; dragging = false; dy = 0;
    y0 = e.touches[0].clientY; t0 = performance.now();
  }, { passive: true });
  controlsEl.addEventListener("touchmove", (e) => {
    if (!tracking) return;
    dy = e.touches[0].clientY - y0;
    const open = controlsEl.classList.contains("open");
    if (open && dy > 0 && controlsEl.scrollTop <= 0) {
      dragging = true;
      e.preventDefault();                         // we own this gesture, not page scroll
      controlsEl.style.transition = "none";
      controlsEl.style.transform = `translateY(${dy}px)`;
    } else if (!open && dy < 0) {
      dragging = true;
      e.preventDefault();
    }
  }, { passive: false });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    controlsEl.style.transition = "";
    controlsEl.style.transform = "";
    if (!dragging) return;
    sheetSwiped = true;
    setTimeout(() => { sheetSwiped = false; }, 400);
    const v = dy / Math.max(1, performance.now() - t0);   // px/ms
    const open = controlsEl.classList.contains("open");
    if (open && (dy > 70 || v > 0.45)) setSheet(false);
    else if (!open && (dy < -30 || v < -0.3)) setSheet(true);
  };
  controlsEl.addEventListener("touchend", end);
  controlsEl.addEventListener("touchcancel", end);

  // a tap on the map (not a drag to orbit) closes whichever panel is open
  let pd = null;
  canvas.addEventListener("pointerdown", (e) => { pd = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener("pointerup", (e) => {
    if (!pd || !matchMedia("(max-width: 760px)").matches) return;
    const moved = Math.hypot(e.clientX - pd.x, e.clientY - pd.y), dt = performance.now() - pd.t;
    pd = null;
    if (moved < 8 && dt < 350) {
      if (controlsEl.classList.contains("open")) setSheet(false);
      if (infoEl.classList.contains("open")) { infoEl.classList.remove("open"); fitViewToPanels(); }
    }
  });
}
const infoToggle = document.getElementById("infoToggle");
const legendEl = document.getElementById("legend"), legendToggle = document.getElementById("legendToggle");
infoToggle.addEventListener("click", (e) => {
  e.stopPropagation();                              // not the phone card's tap-to-expand
  setCollapsed(infoEl, infoToggle, !infoEl.classList.contains("collapsed"));
});
legendToggle.addEventListener("click", () => setCollapsed(legendEl, legendToggle, !legendEl.classList.contains("collapsed")));
if (!isPhone()) {
  for (const [panel, button] of [[controlsEl, handleEl], [infoEl, infoToggle], [legendEl, legendToggle]]) {
    const collapsed = Boolean(panelState[panel.id]);
    panel.classList.toggle("collapsed", collapsed);
    button.setAttribute("aria-expanded", String(!collapsed));
  }
}
infoEl.addEventListener("click", (e) => {
  if (e.target.closest("a")) return;
  if (infoEl.classList.toggle("open")) setSheet(false);
  else fitViewToPanels();
});

// On phones the panels cover the top and bottom of the screen: shift the
// projection centre into the visible gap so the site sits in the middle of it.
function fitViewToPanels() {
  if (!matchMedia("(max-width: 760px)").matches) { camera.clearViewOffset(); return; }
  const top = infoEl.getBoundingClientRect().bottom, bottom = controlsEl.getBoundingClientRect().top;
  const shift = (top + bottom) / 2 - innerHeight / 2;
  camera.setViewOffset(innerWidth, innerHeight, 0, -shift, innerWidth, innerHeight);
}
document.getElementById("creditsMobile").textContent = "Imagery © Esri · LiDAR © Environment Agency";

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  fitViewToPanels();
});

// ---------------------------------------------------------------- animate
const clock = new THREE.Clock();
// advance the animated parts (tracers, rotor swirl, water, windsock) by dt
function advance(dt) {
  app.simTime += dt;
  if (app.viz) app.viz.update(dt, camera, renderer);
  if (app.water) app.water.material.uniforms.time.value = app.simTime;
  if (app.windsock && app.stats) {
    const b = app.dirDeg * Math.PI / 180;
    poseWindsock(app.windsock, app.stats.windTakeoff, -Math.sin(b), -Math.cos(b), app.simTime);
  }
}
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (app.needsRecompute && performance.now() - app.lastCompute > 70) recompute();
  if (!TEST) advance(dt);       // in test mode time only moves via __view.settle()
  controls.update();
  // test mode renders only on demand (__view.settle): software WebGL is slow,
  // and input events and screenshots would otherwise wait on every frame
  if (!TEST) renderer.render(scene, camera);
}

// ---------------------------------------------------------------- boot
async function boot() {
  const res = await fetch("./data/sites.json");
  if (CFD) await cfdStore.loadIndex();
  const data = await res.json();
  app.sites = data.sites;
  app.browser = new SiteBrowser({ sites: app.sites, onSelect: (slug) => loadSite(slug), getWindDir: () => app.dirDeg });
  // the sites panel and the phone panels don't stack
  document.getElementById("sitesPanel").addEventListener("sites:open", () => {
    if (typeof setSheet === "function") setSheet(false);
    infoEl.classList.remove("open");
  });
  animate();
  const first = app.sites.find((s) => s.slug === PARAMS.get("site")) || app.sites[0];
  if (PARAMS.has("dir")) app.pendingDir = ((Number(PARAMS.get("dir")) % 360) + 360) % 360;
  await loadSite(first.slug);
  // deep-link state
  let changed = false;
  if (PARAMS.has("dir")) { app.dirDeg = ((Number(PARAMS.get("dir")) % 360) + 360) % 360; changed = true; }
  if (PARAMS.has("mph")) { app.speedMph = Math.max(0, Math.min(35, Number(PARAMS.get("mph")))); speedEl.value = app.speedMph; changed = true; }
  if (PARAMS.has("lift")) { app.minLift = Math.max(0, Math.min(5, Number(PARAMS.get("lift")))); minLiftEl.value = app.minLift; syncMinLift(); changed = true; }
  if (WINGS[PARAMS.get("wing")]) { app.wing = PARAMS.get("wing"); wingEl.value = app.wing; syncWingLabel(); changed = true; }
  if (changed) { drawDial(); recompute(); }
}
boot();

// debug hook (for automated verification / console inspection)
window.__view = {
  camera, controls, scene, app, recompute, renderer, loadSite,
  // resolves once no site load or recompute is pending
  whenIdle: () => new Promise((res) => {
    const poll = () => (!app.loading && !app.needsRecompute && !cfdStore.pending().length ? res(true) : setTimeout(poll, 20));
    poll();
  }),
  // test mode: advance the animation by n fixed frames and render
  settle(frames = 120, dt = 1 / 60) {
    for (let i = 0; i < frames; i++) advance(dt);
    controls.update();
    renderer.render(scene, camera);
    return true;
  },
};
