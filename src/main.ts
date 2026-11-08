import * as THREE from "three";
import "./styles.css";
import {
  EARTH_CENTER,
  HOME,
  R,
  dirFromLatLon,
  dirFromOffset,
  fmtKm,
  fmtMi,
  frameAt,
  latLonFromDir,
  offsetFromDir,
  pointAt,
  pointNear,
  rng,
  surfaceDistance,
  type Frame,
} from "./geo";

// ───────────────────────────── renderer, scene, camera ─────────────────────────────
const canvas = document.getElementById("scene") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02040a);
const camera = new THREE.PerspectiveCamera(55, 1, 0.0005, 200000);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const homeFrame = frameAt(new THREE.Vector3(0, 1, 0));
function skyDir(f: Frame, azDeg: number, elDeg: number, out = new THREE.Vector3()) {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return out
    .copy(f.east)
    .multiplyScalar(Math.sin(az) * Math.cos(el))
    .addScaledVector(f.north, Math.cos(az) * Math.cos(el))
    .addScaledVector(f.up, Math.sin(el));
}
const SUN_DIR = skyDir(homeFrame, 225, 38);

scene.add(new THREE.HemisphereLight(0xe4f0ff, 0x4a5a3c, 1.3));
const sun = new THREE.DirectionalLight(0xfff6e8, 1.8);
sun.position.copy(SUN_DIR);
scene.add(sun);

const groundFog = new THREE.Fog(0xcde0f3, 0.06, 6.5);
scene.fog = groundFog; // always present; frame() stretches near/far with altitude so it thins out, never pops

// ───────────────────────────── state ─────────────────────────────
/** height of a standing eye above the ground, in km — this is slider t = 0 */
const EYE_KM = 0.0017;

type Mode = "ground" | "globe";
const state = {
  mode: "ground" as Mode,
  obsE: 0,
  obsN: 0,
  obsDir: new THREE.Vector3(0, 1, 0),
  obsFrame: homeFrame,
  yaw: 104, // degrees clockwise from north
  pitch: 7,
  fov: 55,
  /** CAMERA ALTITUDE above the surface, in km. This is what the altitude slider drives. */
  alt: EYE_KM,
  /** 1 = at the standing eye, 0 = fully in the orbit rig (placeCamera writes it each frame). */
  eyeBlend: 1,
  /** orbit angles around the observer. `dist` is the camera→look-target distance, written by placeCamera. */
  orbit: { az: Math.PI + 0.6, pol: 0.95, dist: 520 },
  follow: false,
  stretch: false,
  labels: true,
  speed: 10,
  selected: 0,
};

// ───────────────────────────── Earth ─────────────────────────────
const earthMat = new THREE.MeshBasicMaterial({ color: 0x4d7a5a });
new THREE.TextureLoader().load("textures/earth-day-4096.jpg", (tex) => {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  earthMat.map = tex;
  earthMat.color.set(0xffffff);
  earthMat.needsUpdate = true;
});

function buildGlobe(): THREE.BufferGeometry {
  const latSeg = 128;
  const lonSeg = 256;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i <= latSeg; i++) {
    const lat = -90 + (180 * i) / latSeg;
    for (let j = 0; j <= lonSeg; j++) {
      const lon = -180 + (360 * j) / lonSeg;
      pointAt(dirFromLatLon(lat, lon, d), -0.8, p);
      pos.push(p.x, p.y, p.z);
      uv.push(j / lonSeg, i / latSeg);
    }
  }
  const row = lonSeg + 1;
  for (let i = 0; i < latSeg; i++)
    for (let j = 0; j < lonSeg; j++) {
      const a = i * row + j;
      idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
const globe = new THREE.Mesh(buildGlobe(), earthMat);
scene.add(globe);

/** High-detail spherical cap around the observer, so the ground is truly round and smooth up close. */
const CAP_RINGS = 140;
const CAP_SEGS = 192;
const CAP_RADIUS = 1800;
const capGeo = new THREE.BufferGeometry();
{
  const n = 1 + CAP_RINGS * (CAP_SEGS + 1);
  capGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  capGeo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  const idx: number[] = [];
  for (let j = 0; j < CAP_SEGS; j++) idx.push(0, 1 + j + 1, 1 + j);
  for (let i = 0; i < CAP_RINGS - 1; i++)
    for (let j = 0; j < CAP_SEGS; j++) {
      const a = 1 + i * (CAP_SEGS + 1) + j;
      const b = a + CAP_SEGS + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  capGeo.setIndex(idx);
}
const grassMat = new THREE.MeshBasicMaterial({ color: 0x7a9a55 });
const cap = new THREE.Mesh(capGeo, earthMat);
cap.frustumCulled = false;
scene.add(cap);

function rebuildCap() {
  const f = state.obsFrame;
  const pos = capGeo.getAttribute("position") as THREE.BufferAttribute;
  const uv = capGeo.getAttribute("uv") as THREE.BufferAttribute;
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  const put = (k: number, dir: THREE.Vector3) => {
    pointAt(dir, 0, p);
    pos.setXYZ(k, p.x, p.y, p.z);
    const ll = latLonFromDir(dir);
    uv.setXY(k, (ll.lon + 180) / 360, (ll.lat + 90) / 180);
  };
  put(0, f.up);
  for (let i = 0; i < CAP_RINGS; i++) {
    const r = 0.004 * Math.pow(CAP_RADIUS / 0.004, i / (CAP_RINGS - 1));
    const th = r / R;
    for (let j = 0; j <= CAP_SEGS; j++) {
      const az = (j / CAP_SEGS) * Math.PI * 2;
      d.copy(f.up)
        .multiplyScalar(Math.cos(th))
        .addScaledVector(f.east, Math.sin(az) * Math.sin(th))
        .addScaledVector(f.north, Math.cos(az) * Math.sin(th));
      put(1 + i * (CAP_SEGS + 1) + j, d);
    }
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  capGeo.computeBoundingSphere();
}

// ───────────────────────────── sky dome + stars ─────────────────────────────
const skyMat = new THREE.ShaderMaterial({
  uniforms: {
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uSun: { value: SUN_DIR.clone() },
    uAlpha: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uUp; uniform vec3 uSun; uniform float uAlpha;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float e = dot(d, uUp);
      vec3 horizon = vec3(0.80, 0.88, 0.96);
      vec3 zenith = vec3(0.16, 0.42, 0.84);
      vec3 col = mix(horizon, zenith, pow(clamp(e, 0.0, 1.0), 0.55));
      col = mix(col, vec3(0.86, 0.90, 0.94), smoothstep(0.0, -0.08, e));
      float s = max(dot(d, uSun), 0.0);
      col += vec3(1.0, 0.95, 0.82) * (pow(s, 900.0) * 2.0 + pow(s, 24.0) * 0.22);
      gl_FragColor = vec4(col * uAlpha, 1.0);
    }`,
  side: THREE.BackSide,
  depthTest: false,
  depthWrite: false,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), skyMat);
sky.renderOrder = -10;
sky.frustumCulled = false;
scene.add(sky);

{
  const r = rng(42);
  const n = 2200;
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = r() * 2 - 1;
    const t = r() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    pts.set([s * Math.cos(t) * 150000, u * 150000, s * Math.sin(t) * 150000], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  var stars = new THREE.Points(
    g,
    new THREE.PointsMaterial({ color: 0xcfd8ff, size: 1.6, sizeAttenuation: false, fog: false }),
  );
  stars.frustumCulled = false;
  scene.add(stars);
}

// ───────────────────────────── contrails ─────────────────────────────
function softTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 64;
  const g = c.getContext("2d")!;
  for (let y = 0; y < 64; y++) {
    const v = (y + 0.5) / 64 - 0.5;
    const a = Math.exp(-(v * v) / 0.045);
    g.fillStyle = `rgba(255,255,255,1)`;
    g.globalAlpha = 1;
    const k = Math.round(a * 255);
    g.fillStyle = `rgb(${k},${k},${k})`;
    g.fillRect(0, y, 4, 1);
  }
  return new THREE.CanvasTexture(c);
}
const contrailMat = new THREE.MeshBasicMaterial({
  vertexColors: true,
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  fog: false,
  alphaMap: softTexture(),
});

class Ribbon {
  readonly mesh: THREE.Mesh;
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private geo = new THREE.BufferGeometry();
  constructor(readonly n: number) {
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 6), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(n * 8), 4);
    const uv = new Float32Array(n * 4);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      uv.set([i / (n - 1), 0, i / (n - 1), 1], i * 4);
      if (i < n - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.pos);
    this.geo.setAttribute("color", this.col);
    this.geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, contrailMat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  private side = new THREE.Vector3();
  private tan = new THREE.Vector3();
  private toCam = new THREE.Vector3();
  update(pts: THREE.Vector3[], widths: number[], alphas: number[], count: number, camPos: THREE.Vector3, pxKm: number) {
    const minPx = state.mode === "ground" ? 2.2 : 3;
    if (count < 2) {
      this.geo.setDrawRange(0, 0);
      return;
    }
    for (let i = 0; i < count; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(count - 1, i + 1)];
      this.tan.subVectors(b, a).normalize();
      this.toCam.subVectors(camPos, p);
      const dist = this.toCam.length();
      this.side.crossVectors(this.tan, this.toCam).normalize();
      const w = Math.max(widths[i], minPx * dist * pxKm) * 0.5;
      // keep apparent brightness roughly constant when we widen a too-thin trail
      const thin = Math.min(1, widths[i] / Math.max(1e-6, minPx * dist * pxKm));
      const alpha = alphas[i] * (0.7 + 0.3 * thin);
      this.pos.setXYZ(i * 2, p.x + this.side.x * w, p.y + this.side.y * w, p.z + this.side.z * w);
      this.pos.setXYZ(i * 2 + 1, p.x - this.side.x * w, p.y - this.side.y * w, p.z - this.side.z * w);
      this.col.setXYZW(i * 2, 1, 1, 1, alpha);
      this.col.setXYZW(i * 2 + 1, 1, 1, 1, alpha);
    }
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.geo.setDrawRange(0, (count - 1) * 6);
  }
}

type Path = { a: [number, number]; b: [number, number]; alt: number };
const pathLen = (p: Path) => Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
function pathPoint(p: Path, s: number, altScale: number, out: THREE.Vector3, wobble = 0, seed = 0) {
  const L = pathLen(p);
  const t = s / L;
  let e = p.a[0] + (p.b[0] - p.a[0]) * t;
  let n = p.a[1] + (p.b[1] - p.a[1]) * t;
  if (wobble) {
    const off = Math.sin(s * 0.021 + seed) * wobble + Math.sin(s * 0.057 + seed * 2.3) * wobble * 0.4;
    e += (-(p.b[1] - p.a[1]) / L) * off;
    n += ((p.b[0] - p.a[0]) / L) * off;
  }
  return pointAt(dirFromOffset(e, n, out), p.alt * altScale, out);
}

function makePlaneModel(): THREE.Group {
  const g = new THREE.Group();
  const white = new THREE.MeshLambertMaterial({ color: 0xf1f4f8 });
  const blue = new THREE.MeshLambertMaterial({ color: 0x2f6fd6 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.9, 12), white);
  body.rotation.z = Math.PI / 2;
  g.add(body);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), white);
  nose.position.x = 0.45;
  nose.scale.set(1.6, 1, 1);
  g.add(nose);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.015, 0.95), white);
  wing.position.set(0.04, -0.01, 0);
  g.add(wing);
  const stab = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.012, 0.34), white);
  stab.position.set(-0.4, 0.01, 0);
  g.add(stab);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.2, 0.014), blue);
  fin.position.set(-0.4, 0.11, 0);
  g.add(fin);
  for (const z of [-0.2, 0.2]) {
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.1, 10), blue);
    eng.rotation.z = Math.PI / 2;
    eng.position.set(0.1, -0.045, z);
    g.add(eng);
  }
  g.matrixAutoUpdate = false;
  scene.add(g);
  return g;
}

type Flight = {
  name: string;
  path: Path;
  s: number;
  ribbon: Ribbon;
  plane: THREE.Group;
  label: HTMLElement;
  pos: THREE.Vector3; // render position (stretched in globe mode)
  realPos: THREE.Vector3;
  visible: boolean;
};
const SPEED_KM_S = 0.25; // ~900 km/h cruise
const MAX_AGE_S = 1500;
const SAMPLES = 220;

const labelsEl = $("labels");
function makeLabel(text: string, cls: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `label ${cls}`;
  el.textContent = text;
  labelsEl.appendChild(el);
  return el;
}

const flightDefs: { name: string; path: Path; s0: number }[] = [
  // The star of the show: flies in from beyond the horizon, straight over a spot 150 mi east of home.
  { name: "Our plane", path: { a: [430, 53], b: [-60, -86], alt: 11 }, s0: 285 },
  { name: "Plane 2", path: { a: [-360, 150], b: [320, 245], alt: 10.4 }, s0: 260 },
  { name: "Plane 3", path: { a: [170, -310], b: [-270, -60], alt: 11.6 }, s0: 120 },
  { name: "Plane 4", path: { a: [-170, -40], b: [90, 150], alt: 10.8 }, s0: 60 },
];
const flights: Flight[] = flightDefs.map((d, i) => {
  const label = makeLabel(i === 0 ? "✈ Our plane" : `✈ ${d.name}`, i === 0 ? "plane main" : "plane");
  label.addEventListener("click", () => {
    state.selected = i;
    updateLabelClasses();
  });
  return {
    name: d.name,
    path: d.path,
    s: d.s0,
    ribbon: new Ribbon(SAMPLES),
    plane: makePlaneModel(),
    label,
    pos: new THREE.Vector3(),
    realPos: new THREE.Vector3(),
    visible: true,
  };
});
function updateLabelClasses() {
  flights.forEach((f, i) => f.label.classList.toggle("selected", i === state.selected));
}
updateLabelClasses();

const staticDefs = [
  { path: { a: [90, 150], b: [-110, 205], alt: 11.2 } as Path, width: 2.4, alpha: 0.42, seed: 1.3 },
  { path: { a: [-230, -20], b: [-80, -170], alt: 10.1 } as Path, width: 1.8, alpha: 0.36, seed: 4.1 },
  { path: { a: [120, -95], b: [215, 60], alt: 11.8 } as Path, width: 3.0, alpha: 0.3, seed: 2.7 },
  { path: { a: [-40, 260], b: [-300, 60], alt: 10.6 } as Path, width: 2.0, alpha: 0.32, seed: 5.5 },
];
const statics = staticDefs.map((d) => ({ ...d, ribbon: new Ribbon(140) }));

const pts: THREE.Vector3[] = Array.from({ length: SAMPLES }, () => new THREE.Vector3());
const widths = new Array<number>(SAMPLES).fill(0);
const alphas = new Array<number>(SAMPLES).fill(0);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function updateContrails(camPos: THREE.Vector3, pxKm: number, altScale: number) {
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  for (const f of flights) {
    const L = pathLen(f.path);
    const head = Math.min(f.s, L);
    const tail = Math.max(0, f.s - SPEED_KM_S * MAX_AGE_S);
    if (tail >= L) {
      f.s = 0; // a new plane starts over
      continue;
    }
    let count = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const u = 1 - i / (SAMPLES - 1);
      const s = head - (head - tail) * u * u;
      const age = (f.s - s) / SPEED_KM_S;
      pathPoint(f.path, s, altScale, pts[count]);
      widths[count] = 0.03 + 1.5 * (1 - Math.exp(-age / 650));
      const puff = 0.82 + 0.18 * Math.sin(s * 0.9 + f.path.alt * 7) * Math.sin(s * 0.23);
      alphas[count] = 0.95 * Math.exp(-age / 800) * smooth(0, 3, age) * smooth(0, 12, s) * puff * smooth(MAX_AGE_S, MAX_AGE_S * 0.75, age);
      count++;
    }
    f.ribbon.update(pts, widths, alphas, count, camPos, pxKm);
    f.visible = f.s <= L;
    pathPoint(f.path, head, altScale, f.pos);
    pathPoint(f.path, head, 1, f.realPos);
    // orient + size the plane model
    pathPoint(f.path, Math.max(0, head - 1), altScale, tmpA);
    pathPoint(f.path, Math.min(L, head + 1), altScale, tmpB);
    const fwd = tmpB.sub(tmpA).normalize();
    const up = f.pos.clone().sub(EARTH_CENTER).normalize();
    fwd.addScaledVector(up, -fwd.dot(up)).normalize();
    const z = new THREE.Vector3().crossVectors(fwd, up);
    const dist = f.pos.distanceTo(camPos);
    const minPx = state.mode === "ground" ? 9 : 16;
    const scale = Math.max(0.065, minPx * dist * pxKm);
    f.plane.matrix.makeBasis(fwd, up, z).scale(new THREE.Vector3(scale, scale, scale)).setPosition(f.pos);
    f.plane.matrixWorldNeedsUpdate = true;
    f.plane.visible = f.visible;
  }
  for (const st of statics) {
    const L = pathLen(st.path);
    const n = st.ribbon.n;
    for (let i = 0; i < n; i++) {
      const s = (i / (n - 1)) * L;
      pathPoint(st.path, s, altScale, pts[i], 2.5, st.seed);
      widths[i] = st.width * (0.8 + 0.4 * Math.sin(s * 0.05 + st.seed));
      const ends = smooth(0, 0.18, i / (n - 1)) * smooth(1, 0.82, i / (n - 1));
      const gaps = 0.65 + 0.35 * Math.sin(s * 0.11 + st.seed * 3) * Math.sin(s * 0.031 + st.seed);
      alphas[i] = st.alpha * ends * Math.max(0, gaps);
    }
    st.ribbon.update(pts, widths, alphas, n, camPos, pxKm);
  }
}

// ───────────────────────────── the town around you ─────────────────────────────
const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const buildings = new THREE.InstancedMesh(boxGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), 600);
const treeGeo = new THREE.ConeGeometry(0.5, 1, 7).translate(0, 0.5, 0);
const trees = new THREE.InstancedMesh(treeGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), 500);
buildings.frustumCulled = false;
trees.frustumCulled = false;
scene.add(buildings, trees);

function rebuildTown() {
  const f = state.obsFrame;
  const city = Math.hypot(state.obsE, state.obsN) < 8;
  const r = rng(city ? 7 : 1000 + Math.round(state.obsE / 5) * 31 + Math.round(state.obsN / 5) * 7);
  const m = new THREE.Matrix4();
  const basis = new THREE.Matrix4().makeBasis(f.east, f.up, f.north.clone().negate());
  const p = new THREE.Vector3();
  const color = new THREE.Color();
  let nb = 0;
  let nt = 0;
  const window = (az: number) => az > 80 && az < 172; // keep the low sky toward our plane clear
  const addBox = (azDeg: number, distKm: number, w: number, d: number, h: number, hex: number) => {
    if (nb >= buildings.count) return;
    const az = (azDeg * Math.PI) / 180;
    pointNear(f, Math.sin(az) * distKm, Math.cos(az) * distKm, -0.002, p);
    m.copy(basis).multiply(new THREE.Matrix4().makeRotationY(r() * Math.PI)).scale(new THREE.Vector3(w, h, d)).setPosition(p);
    buildings.setMatrixAt(nb, m);
    buildings.setColorAt(nb, color.set(hex).offsetHSL(0, 0, (r() - 0.5) * 0.08));
    nb++;
  };
  const addTree = (azDeg: number, distKm: number, h: number) => {
    if (nt >= trees.count) return;
    const az = (azDeg * Math.PI) / 180;
    pointNear(f, Math.sin(az) * distKm, Math.cos(az) * distKm, -0.001, p);
    m.copy(basis).scale(new THREE.Vector3(h * 0.55, h, h * 0.55)).setPosition(p);
    trees.setMatrixAt(nt, m);
    trees.setColorAt(nt, color.set(0x3d6b3a).offsetHSL(0, 0, (r() - 0.5) * 0.1));
    nt++;
  };
  if (city) {
    const clusters = [
      { az: 60, dist: 1.9, spread: 0.7, n: 90, hMin: 0.04, hMax: 0.3 },
      { az: 152, dist: 2.6, spread: 0.6, n: 45, hMin: 0.025, hMax: 0.16 },
      { az: 245, dist: 1.7, spread: 0.5, n: 45, hMin: 0.025, hMax: 0.14 },
      { az: 325, dist: 2.4, spread: 0.7, n: 40, hMin: 0.02, hMax: 0.09 },
    ];
    for (const c of clusters)
      for (let i = 0; i < c.n; i++) {
        const ang = r() * Math.PI * 2;
        const rr = Math.sqrt(r()) * c.spread;
        const de = Math.sin((c.az * Math.PI) / 180) * c.dist + Math.cos(ang) * rr;
        const dn = Math.cos((c.az * Math.PI) / 180) * c.dist + Math.sin(ang) * rr;
        const az = (Math.atan2(de, dn) * 180) / Math.PI;
        const dist = Math.hypot(de, dn);
        const central = 1 - rr / c.spread;
        const h = c.hMin + (c.hMax - c.hMin) * Math.pow(r(), 2.2) * (0.4 + 0.6 * central);
        const w = 0.025 + r() * 0.035;
        const tones = [0x3e4a5e, 0x4b5870, 0x35404f, 0x5d6a80, 0x2f3846];
        addBox(az, dist, w, w * (0.7 + r() * 0.6), h, tones[Math.floor(r() * tones.length)]);
      }
    for (let i = 0; i < 260; i++) {
      const az = r() * 360;
      const dist = 0.22 + r() * 1.3;
      if (window(((az % 360) + 360) % 360) && dist < 0.9) continue;
      addBox(az, dist, 0.012 + r() * 0.01, 0.01 + r() * 0.01, 0.005 + r() * 0.004, r() < 0.5 ? 0xa48b74 : 0x8f9aa6);
    }
    for (let i = 0; i < 260; i++) {
      const az = r() * 360;
      const dist = 0.05 + r() * 0.5;
      if (window(az) && dist < 0.6) continue;
      addTree(az, dist, 0.006 + r() * 0.008);
    }
  } else {
    for (let i = 0; i < 40; i++) {
      const az = r() * 360;
      const dist = 0.35 + r() * 2.2;
      const silo = r() < 0.25;
      addBox(az, dist, silo ? 0.007 : 0.02 + r() * 0.02, silo ? 0.007 : 0.012 + r() * 0.01, silo ? 0.018 + r() * 0.012 : 0.006 + r() * 0.006, silo ? 0xb9bcc0 : r() < 0.5 ? 0x9c3b2e : 0xd9d2c3);
    }
    for (let i = 0; i < 420; i++) {
      // tree lines along fields
      const az = r() * 360;
      const dist = 0.4 + r() * 3.2;
      addTree(az, dist, 0.007 + r() * 0.01);
    }
  }
  buildings.count = nb;
  trees.count = nt;
  buildings.instanceMatrix.needsUpdate = true;
  trees.instanceMatrix.needsUpdate = true;
  if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
  if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
}
// InstancedMesh.count must start at max so capacity exists; rebuildTown lowers it.
const BUILDING_CAP = 600;
const TREE_CAP = 500;
function resetTownCapacity() {
  buildings.count = BUILDING_CAP;
  trees.count = TREE_CAP;
}

// ───────────────────────────── globe helpers: you, horizon, sight line, cities ─────────────────────────────
const youLabel = makeLabel("📍 You", "you");
const cityDefs = [
  { name: "Indianapolis", lat: 39.7684, lon: -86.1581 },
  { name: "Dayton", lat: 39.7589, lon: -84.1916 },
  { name: "Columbus", lat: 39.9612, lon: -82.9988 },
  { name: "Cincinnati", lat: 39.1031, lon: -84.512 },
  { name: "Chicago", lat: 41.8781, lon: -87.6298 },
  { name: "Louisville", lat: 38.2527, lon: -85.7585 },
  { name: "Fort Wayne", lat: 41.0793, lon: -85.1394 },
];
const cities = cityDefs.map((c) => {
  const dir = dirFromLatLon(c.lat, c.lon);
  return { ...c, dir, pos: pointAt(dir, 0), label: makeLabel(c.name, "city") };
});

const horizonDisc = new THREE.Mesh(
  new THREE.RingGeometry(0.0, 320, 96, 1),
  new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false, fog: false }),
);
const horizonEdge = new THREE.LineLoop(
  new THREE.BufferGeometry().setFromPoints(
    Array.from({ length: 128 }, (_, i) => new THREE.Vector3(Math.cos((i / 128) * Math.PI * 2) * 320, Math.sin((i / 128) * Math.PI * 2) * 320, 0)),
  ),
  new THREE.LineBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.7, fog: false }),
);
horizonDisc.add(horizonEdge);
scene.add(horizonDisc);
const horizonLabel = makeLabel("your horizon (flat ‘eye level’)", "hint-label");

const sightGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const sightLine = new THREE.Line(sightGeo, new THREE.LineDashedMaterial({ color: 0xffd34d, dashSize: 6, gapSize: 4, fog: false }));
sightLine.frustumCulled = false;
scene.add(sightLine);
const dropGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const dropLine = new THREE.Line(dropGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, fog: false }));
dropLine.frustumCulled = false;
scene.add(dropLine);
const youPin = new THREE.Mesh(
  new THREE.ConeGeometry(0.5, 1.4, 16).rotateX(Math.PI).translate(0, 0.7, 0),
  new THREE.MeshBasicMaterial({ color: 0xff4d6d, fog: false }),
);
youPin.matrixAutoUpdate = false;
scene.add(youPin);

// ───────────────────────────── observer ─────────────────────────────
let capCenter = new THREE.Vector3(0, 1, 0);
function setObserver(e: number, n: number) {
  state.obsE = e;
  state.obsN = n;
  dirFromOffset(e, n, state.obsDir);
  state.obsFrame = frameAt(state.obsDir);
  if (surfaceDistance(capCenter, state.obsDir) > 0.3 || capCenter === null) {
    rebuildCap();
    capCenter = state.obsDir.clone();
  }
  resetTownCapacity();
  rebuildTown();
  const d = Math.hypot(e, n);
  const near = nearestCity(state.obsDir);
  const where =
    d < 1 ? "Home — Indianapolis" : `${fmtMi(d)} mi from home${near ? ` · near ${near}` : ""}`;
  $("where-value").textContent = where;
  const slider = $<HTMLInputElement>("east-slider");
  if (document.activeElement !== slider) slider.value = String(Math.round(Math.max(0, e) / 1.609344));
}
function nearestCity(dir: THREE.Vector3): string | null {
  let best: string | null = null;
  let bd = 45;
  for (const c of cities) {
    const d = surfaceDistance(dir, c.dir);
    if (d < bd) {
      bd = d;
      best = c.name;
    }
  }
  return best;
}

let travel: { fromE: number; fromN: number; toE: number; toN: number; t0: number; dur: number } | null = null;
function travelTo(e: number, n: number) {
  const dist = Math.hypot(e - state.obsE, n - state.obsN);
  travel = { fromE: state.obsE, fromN: state.obsN, toE: e, toN: n, t0: performance.now(), dur: Math.min(2600, 700 + dist * 6) };
}

// ───────────────────────────── unified "how high am I?" slider ─────────────────────────────
/* The slider is one monotonic parametrisation of CAMERA ALTITUDE h (km above the surface):
 *     h(t) = exp(lerp(ln(EYE_KM), ln(MAX_ALT), t))        t ∈ [0,1]
 * so t=0 is exactly the ground eye, equal slider steps are equal *factors* of height, and h can
 * never go backwards or dip below the surface — the camera placement solves for h exactly.      */
const MAX_ALT = 36000; // km at t = 1 (geostationary-ish: the whole Earth in one glance)
const ALT_SPAN = Math.log(MAX_ALT / EYE_KM);
const GROUND_T = 0.0015; // t below this still counts as "standing on the ground" (h ≈ 1.7 m)
const BLEND_HI = 3; // km: below this the camera eases out of the eye point and tilts down
const LOOK_SINK_FROM = 700; // km: below this the camera looks at "you"...
const LOOK_SINK_TO = 9000; // km: ...and from this height on it looks at the centre of the Earth
const POL_MIN = 0.08; // drag range of the orbit polar angle: keeps the camera on the observer's side
const POL_MAX = 1.52;

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
/** slider value t ∈ [0,1] → camera altitude in km */
const altAtT = (t: number) => Math.exp(Math.log(EYE_KM) + clamp01(t) * ALT_SPAN);
/** camera altitude in km → slider t (inverse of altAtT) */
const hToT = (h: number) => clamp01(Math.log(Math.max(h, EYE_KM) / EYE_KM) / ALT_SPAN);
/** 1 = right at the eye, 0 = properly airborne; spread evenly over log-altitude */
const groundBlend = (h: number) => 1 - smooth(Math.log(EYE_KM), Math.log(BLEND_HI), Math.log(Math.max(h, EYE_KM)));

const altSlider = $<HTMLInputElement>("alt-slider");
const marks = [
  { label: "Ground", t: hToT(EYE_KM) },
  { label: "Plane height", t: hToT(11) },
  { label: "Edge of space", t: hToT(100) },
  { label: "Space station", t: hToT(420) },
  { label: "Whole Earth", t: hToT(20000) },
];
for (const mk of marks) {
  const b = document.createElement("button");
  b.textContent = mk.label;
  b.style.bottom = `${mk.t * 100}%`;
  b.addEventListener("click", () => flyToT(mk.t));
  $("alt-marks").appendChild(b);
}

let altTarget = 0; // where the user wants to be (slider space)
let altCurrent = 0; // where the camera actually is, eased toward altTarget every frame
let aimOnLanding = false; // zoom/fly all the way down → look back at the plane once we're standing
let sliderHeld = false;
altSlider.addEventListener("pointerdown", () => (sliderHeld = true));
window.addEventListener("pointerup", () => (sliderHeld = false));
window.addEventListener("pointercancel", () => (sliderHeld = false));

function currentT() {
  return altCurrent;
}
/** ask for a new altitude; frame() does the easing, so nothing ever jumps */
function setAltTarget(t: number) {
  altTarget = clamp01(t);
  if (altTarget <= GROUND_T) aimOnLanding = true;
}
function flyToT(t: number) {
  setAltTarget(t);
}
/** apply an altitude to the world: mode, camera height, and the eye→orbit continuity */
function applyT(t: number) {
  const wasGround = state.mode === "ground";
  altCurrent = clamp01(t);
  state.alt = altAtT(altCurrent);
  setMode(altCurrent <= GROUND_T ? "ground" : "globe");
  if (aimOnLanding && wasGround && state.mode === "ground") {
    aimAtPlane();
    aimOnLanding = false;
  }
}
altSlider.addEventListener("input", () => setAltTarget(Number(altSlider.value) / 1000));

function aimAtPlane(instant = true) {
  const f = flights[state.selected];
  const eye = pointAt(state.obsDir, EYE_KM);
  const v = f.realPos.clone().sub(eye).normalize();
  const fr = state.obsFrame;
  const el = (Math.asin(v.dot(fr.up)) * 180) / Math.PI;
  const az = (Math.atan2(v.dot(fr.east), v.dot(fr.north)) * 180) / Math.PI;
  if (instant) {
    state.yaw = az;
    state.pitch = Math.max(-2, Math.min(85, el + 4));
  }
  return { az, el };
}

function enterGlobeFromGround() {
  state.mode = "globe";
  // pick the orbit up from wherever the eye was looking, so the climb out is one continuous move:
  // same azimuth, and the same look elevation until the drag takes over
  const yr = (state.yaw * Math.PI) / 180;
  state.orbit.az = Math.atan2(-Math.cos(yr), -Math.sin(yr));
  state.orbit.pol = Math.max(POL_MIN, Math.min(POL_MAX, Math.PI / 2 + (state.pitch * Math.PI) / 180));
  syncModeUI();
}
function setMode(m: Mode) {
  // mode follows the altitude (see applyT); no flash, no camera snap — the slider blend carries it
  if (state.mode === m) return;
  if (m === "globe") enterGlobeFromGround();
  else {
    state.mode = "ground";
    syncModeUI();
  }
}
function syncModeUI() {
  const g = state.mode === "ground";
  $("mode-ground").setAttribute("aria-selected", String(g));
  $("mode-globe").setAttribute("aria-selected", String(!g));
  document.body.classList.toggle("is-globe", !g);
  $("hint").textContent = g ? "Drag to look around · pinch or scroll to zoom" : "Drag to spin the world · pinch or scroll to zoom · tap the ground to stand there";
}

// ───────────────────────────── input ─────────────────────────────
const pointers = new Map<number, { x: number; y: number }>();
let downAt: { x: number; y: number; t: number } | null = null;
let pinchDist = 0;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    downAt = null;
  }
  hideHint();
});
canvas.addEventListener("pointermove", (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const cur = { x: e.clientX, y: e.clientY };
  pointers.set(e.pointerId, cur);
  if (pointers.size === 1) {
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (state.mode === "ground") {
      const degPerPx = state.fov / canvas.clientHeight;
      state.yaw -= dx * degPerPx;
      state.pitch = Math.max(-15, Math.min(89, state.pitch + dy * degPerPx));
      if (Math.abs(dx) + Math.abs(dy) > 1) setFollow(false);
    } else {
      // slow, careful drags near the ground; full speed when we can see the whole Earth
      const k = 0.0045 * Math.max(0.2, Math.min(1, 0.35 + Math.log10(Math.max(1e-3, state.alt)) / 4));
      state.orbit.az -= dx * k;
      state.orbit.pol = Math.max(POL_MIN, Math.min(POL_MAX, state.orbit.pol - dy * k));
    }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) zoomBy(pinchDist / d);
    pinchDist = d;
  }
});
const endPointer = (e: PointerEvent) => {
  if (downAt && pointers.size === 1 && state.mode === "globe") {
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    if (moved < 6 && performance.now() - downAt.t < 450) tapGlobe(e.clientX, e.clientY);
  }
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchDist = 0;
  if (pointers.size === 0) downAt = null;
};
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomBy(Math.exp(e.deltaY * 0.0012));
    hideHint();
  },
  { passive: false },
);
function zoomBy(factor: number) {
  // factor > 1 is "zoom out". On the ground that means the lens; in the air it means altitude,
  // and because h is exponential in t a constant factor is a constant step in t.
  if (state.mode === "ground") state.fov = Math.max(8, Math.min(80, state.fov * factor));
  else setAltTarget(altTarget + Math.log(factor) / ALT_SPAN);
}
const raycaster = new THREE.Raycaster();
function tapGlobe(x: number, y: number) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const sphere = new THREE.Sphere(EARTH_CENTER, R);
  const hit = raycaster.ray.intersectSphere(sphere, new THREE.Vector3());
  if (!hit) return;
  const dir = hit.sub(EARTH_CENTER).normalize();
  const off = offsetFromDir(dir);
  if (Math.hypot(off.east, off.north) > 1500) return;
  travelTo(off.east, off.north);
}

// ───────────────────────────── UI wiring ─────────────────────────────
$("mode-ground").addEventListener("click", () => {
  flyToT(0);
});
$("mode-globe").addEventListener("click", () => {
  flyToT(hToT(520)); // ~520 km: a low-orbit view of where you are standing
});
$("east-slider").addEventListener("input", (e) => {
  travel = null;
  setObserver(Number((e.target as HTMLInputElement).value) * 1.609344, 0);
});
$("go-home").addEventListener("click", () => travelTo(0, 0));
$("go-under").addEventListener("click", () => {
  // Bring "our plane" back so it is on its way in and passes right over that spot in a few seconds.
  if (flights[0].s > 175 || flights[0].s < 60) flights[0].s = 150;
  state.selected = 0;
  updateLabelClasses();
  travelTo(241.4, 0);
  if (state.mode === "ground") setFollow(true);
});
$("find-plane").addEventListener("click", () => {
  if (state.mode === "ground") aimAtPlane();
  else {
    const a = aimAtPlane(false);
    state.orbit.az = Math.atan2(-Math.cos((a.az * Math.PI) / 180), -Math.sin((a.az * Math.PI) / 180));
    state.orbit.pol = 1.25;
  }
});
$("see-here").addEventListener("click", () => {
  flyToT(0); // applyT aims at the plane for us once we are back on the ground
});
function setFollow(v: boolean) {
  state.follow = v;
  $<HTMLInputElement>("opt-follow").checked = v;
}
$("opt-follow").addEventListener("change", (e) => setFollow((e.target as HTMLInputElement).checked));
$("opt-stretch").addEventListener("change", (e) => (state.stretch = (e.target as HTMLInputElement).checked));
$("opt-labels").addEventListener("change", (e) => (state.labels = (e.target as HTMLInputElement).checked));
document.querySelectorAll<HTMLButtonElement>(".speed button").forEach((b) =>
  b.addEventListener("click", () => {
    state.speed = Number(b.dataset.speed);
    document.querySelectorAll(".speed button").forEach((x) => x.classList.toggle("on", x === b));
  }),
);
$("panel-toggle").addEventListener("click", () => {
  $("panel").classList.toggle("collapsed");
});
let hintTimer = window.setTimeout(hideHint, 7000);
function hideHint() {
  window.clearTimeout(hintTimer);
  $("hint").classList.add("hidden");
}

// ───────────────────────────── camera placement ─────────────────────────────
const m4 = new THREE.Matrix4();
const camTarget = new THREE.Vector3();
const camDir = new THREE.Vector3();
const camRight = new THREE.Vector3();
const camUp = new THREE.Vector3();
const camOrbitPos = new THREE.Vector3();
const camEyePos = new THREE.Vector3();
const gFwd = new THREE.Vector3();
const gRight = new THREE.Vector3();
const gUp = new THREE.Vector3();
const gBack = new THREE.Vector3();
const qOrbit = new THREE.Quaternion();
const qGround = new THREE.Quaternion();

/**
 * Put the camera at EXACTLY `state.alt` km above the surface.
 *
 * The look target T sinks from the observer's feet toward the centre of the Earth as we climb, and
 * the camera then slides along the orbit direction until it lies on the sphere of radius R+h — the
 * quadratic below always has exactly one positive root (T is always inside that sphere), so the
 * altitude is exact for every t, in every orbit direction, with no clamping and no retries.
 *
 * Below BLEND_HI the position eases out from the observer's raised eye point and the orientation
 * slerps from the ground "looking up at the sky" pose, so climbing out of Ground is one continuous
 * move: straight up, gradually tilting down until the world is held steady in the middle.
 */
function placeCamera() {
  const f = state.obsFrame;
  const o = state.orbit;
  const h = state.alt;
  const g = groundBlend(h); // 1 = at the eye, 0 = fully in the orbit rig
  state.eyeBlend = g;

  // look target: your surface point, sinking toward the centre as we climb (LOOK_SINK_FROM → _TO)
  camTarget.copy(state.obsDir).multiplyScalar(R).add(EARTH_CENTER);
  camTarget.lerp(EARTH_CENTER, smooth(Math.log(LOOK_SINK_FROM), Math.log(LOOK_SINK_TO), Math.log(Math.max(h, EYE_KM))));

  // camera→target unit direction from the orbit angles (read-only: placement never edits az/pol)
  camDir
    .copy(f.east)
    .multiplyScalar(Math.sin(o.pol) * Math.cos(o.az))
    .addScaledVector(f.north, Math.sin(o.pol) * Math.sin(o.az))
    .addScaledVector(f.up, Math.cos(o.pol));

  // solve |T + d·s − C|² = (R+h)² for s > 0   →   s² + 2s(d·oc) + (|oc|² − (R+h)²) = 0
  const oc = camOrbitPos.copy(camTarget).sub(EARTH_CENTER);
  const b = camDir.dot(oc);
  const c = oc.lengthSq() - (R + h) * (R + h);
  const s = -b + Math.sqrt(Math.max(0, b * b - c));
  camOrbitPos.copy(camTarget).addScaledVector(camDir, s);
  o.dist = s; // legacy/debug: camera → look target

  camRight.copy(f.east).multiplyScalar(-Math.sin(o.az)).addScaledVector(f.north, Math.cos(o.az));
  camUp.crossVectors(camDir, camRight);
  qOrbit.setFromRotationMatrix(m4.makeBasis(camRight, camUp, camDir));

  // the ground pose the user steers with the mouse / "follow the plane"
  const fwd = skyDir(f, state.yaw, state.pitch, gFwd);
  gRight.crossVectors(fwd, f.up).normalize();
  gUp.crossVectors(gRight, fwd);
  qGround.setFromRotationMatrix(m4.makeBasis(gRight, gUp, gBack.copy(fwd).negate()));

  // ... and blend the two together on log-altitude
  camEyePos.copy(state.obsDir).multiplyScalar(R + h).add(EARTH_CENTER); // the eye, raised to h
  camera.position.copy(camOrbitPos).lerp(camEyePos, g);
  // the lerp dips a little inside the sphere (both ends lie on it): push the position back out, so
  // the camera altitude is exactly h for every t, blended or not
  const rNow = camera.position.distanceTo(EARTH_CENTER);
  camera.position.sub(EARTH_CENTER).multiplyScalar((R + h) / rNow).add(EARTH_CENTER);
  camera.quaternion.copy(qOrbit).slerp(qGround, g);
  camera.fov = 50 + (state.fov - 50) * g;
}

// ───────────────────────────── per-frame ─────────────────────────────
const tmpV = new THREE.Vector3();
function project(p: THREE.Vector3, el: HTMLElement, show: boolean, dy = 0): boolean {
  if (!show) {
    el.style.display = "none";
    return false;
  }
  tmpV.copy(p).sub(camera.position);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  if (tmpV.dot(fwd) <= 0 || occluded(p)) {
    el.style.display = "none";
    return false;
  }
  tmpV.copy(p).project(camera);
  const x = (tmpV.x * 0.5 + 0.5) * canvas.clientWidth;
  const y = (-tmpV.y * 0.5 + 0.5) * canvas.clientHeight;
  if (x < -50 || x > canvas.clientWidth + 50 || y < -50 || y > canvas.clientHeight + 50) {
    el.style.display = "none";
    return false;
  }
  el.style.display = "";
  el.style.transform = `translate(${x.toFixed(1)}px, ${(y + dy).toFixed(1)}px)`;
  return true;
}
function occluded(p: THREE.Vector3): boolean {
  const o = camera.position;
  const d = tmpV.copy(p).sub(o);
  const len = d.length();
  d.divideScalar(len);
  const oc = new THREE.Vector3().subVectors(o, EARTH_CENTER);
  const b = d.dot(oc);
  const c = oc.lengthSq() - (R - 0.5) * (R - 0.5);
  const disc = b * b - c;
  if (disc < 0) return false;
  const t1 = -b - Math.sqrt(disc);
  return t1 > 0 && t1 < len - 0.01;
}

function updateReadout() {
  const f = flights[state.selected];
  const eye = pointAt(state.obsDir, EYE_KM);
  const L = pathLen(f.path);
  const angleEl = $("readout-angle");
  const factsEl = $("readout-facts");
  const sentEl = $("readout-sentence");
  if (!f.visible || f.s > L) {
    angleEl.textContent = `${f.name} flew away`;
    factsEl.textContent = "Its contrail is slowly spreading out and fading.";
    sentEl.textContent = "A new plane will come along in a moment!";
    $("gauge-needle").setAttribute("transform", "rotate(0 50 52)");
    return;
  }
  const v = f.realPos.clone().sub(eye);
  const el = (Math.asin(v.clone().normalize().dot(state.obsFrame.up)) * 180) / Math.PI;
  const planeDir = f.realPos.clone().sub(EARTH_CENTER).normalize();
  const ground = surfaceDistance(state.obsDir, planeDir);
  const altKm = f.path.alt;
  angleEl.textContent =
    el < 0 ? `${f.name} is hidden below your horizon` : `${f.name} looks ${el < 10 ? el.toFixed(1) : Math.round(el)}° above your horizon`;
  factsEl.innerHTML = `<b>${fmtMi(altKm)} mi</b> (${fmtKm(altKm)} km) up · <b>${fmtMi(ground)} mi</b> (${fmtKm(ground)} km) away`;
  let s: string;
  if (el < 0) s = "The Earth curves away, so the ground is in the way. But the plane is still way up high!";
  else if (el < 12)
    s = `It looks low, almost like a rocket taking off. But it's really ${fmtMi(altKm)} miles up. It only looks low because it's so far away!`;
  else if (el < 45) s = "It's partway up the sky. Get closer and it climbs higher!";
  else if (el < 75) s = "Look up! It's high in the sky now.";
  else s = "It's almost right over your head!";
  sentEl.textContent = s;
  $("gauge-needle").setAttribute("transform", `rotate(${-Math.max(-8, Math.min(90, el)).toFixed(1)} 50 52)`);
}

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // advance flights
  for (const f of flights) f.s += SPEED_KM_S * dt * state.speed;

  // observer travel animation
  if (travel) {
    const k = smooth(0, 1, (now - travel.t0) / travel.dur);
    setObserver(travel.fromE + (travel.toE - travel.fromE) * k, travel.fromN + (travel.toN - travel.fromN) * k);
    if (k >= 1) travel = null;
  }
  // altitude: whatever the user asked for (slider, marks, wheel, pinch, buttons) is the TARGET; the
  // camera itself eases toward it with frame-rate independent damping, so it always moves smoothly
  {
    const want = altTarget - altCurrent;
    // snap the last hair off at either end so the rail has exact, repeatable endpoints
    const atEnd = altTarget === altCurrent || (altTarget <= GROUND_T && altCurrent <= GROUND_T) || (altTarget >= 1 - GROUND_T && altCurrent >= 1 - GROUND_T);
    applyT(atEnd ? altTarget : altCurrent + want * (1 - Math.exp(-dt * 8)));
  }
  if (state.mode === "ground" && state.follow) {
    const a = aimAtPlane(false);
    let dyaw = ((a.az - state.yaw + 540) % 360) - 180;
    state.yaw += dyaw * Math.min(1, dt * 3);
    state.pitch += (Math.max(-2, Math.min(85, a.el + 3)) - state.pitch) * Math.min(1, dt * 3);
  }
  // keep the thumb in step with the camera, but never fight a finger that is on it
  if (!sliderHeld && document.activeElement !== altSlider) altSlider.value = String(Math.round(altCurrent * 1000));

  // camera
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
  }
  camera.aspect = w / h;
  placeCamera();
  const camAlt = camera.position.distanceTo(EARTH_CENTER) - R; // == state.alt (to a few cm in the blend)
  camera.near = Math.max(0.0005, camAlt * 0.05);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  // sky
  sky.position.copy(camera.position);
  stars.position.copy(camera.position);
  skyMat.uniforms.uUp.value.copy(camera.position).sub(EARTH_CENTER).normalize();
  const skyAlpha = state.mode === "ground" ? 1 : 1 - smooth(12, 140, camAlt);
  skyMat.uniforms.uAlpha.value = skyAlpha;
  sky.visible = skyAlpha > 0.01;
  stars.visible = skyAlpha < 0.5;
  cap.visible = camAlt < 4000;
  // the ground stays "grass" while we are still in the eye blend, then becomes the mapped Earth
  cap.material = state.alt < BLEND_HI ? grassMat : earthMat;
  buildings.visible = trees.visible = camAlt < 60;

  // haze thins out smoothly with height instead of switching off at the mode boundary
  const fogOut = smooth(Math.log(EYE_KM * 2), Math.log(120), Math.log(Math.max(EYE_KM, state.alt)));
  groundFog.near = 0.06 + 3 * fogOut;
  groundFog.far = 6.5 * Math.pow(2e6 / 6.5, fogOut);

  const pxKm = (2 * Math.tan((camera.fov * Math.PI) / 360)) / h;
  const altScale = 1 + 4 * (state.stretch ? 1 : 0) * (1 - groundBlend(state.alt));
  updateContrails(camera.position, pxKm, altScale);

  // globe helpers
  const globeMode = state.mode === "globe";
  const sel = flights[state.selected];
  const eye = pointAt(state.obsDir, EYE_KM);
  const fr = state.obsFrame;
  // fade the didactic overlays in over the first kilometres, so nothing pops the moment you lift off
  const helperFade = smooth(Math.log(0.35), Math.log(6), Math.log(Math.max(0.01, state.alt)));
  horizonDisc.visible = globeMode && helperFade > 0.02;
  (horizonDisc.material as THREE.MeshBasicMaterial).opacity = 0.1 * helperFade;
  (horizonEdge.material as THREE.LineBasicMaterial).opacity = 0.7 * helperFade;
  sightLine.visible = dropLine.visible = globeMode && sel.visible && helperFade > 0.35;
  youPin.visible = globeMode && helperFade > 0.02;
  if (globeMode) {
    const pinScale = Math.max(0.002, 22 * camera.position.distanceTo(eye) * pxKm);
    youPin.matrix.makeBasis(fr.east, fr.up, fr.north.clone().negate()).scale(new THREE.Vector3(pinScale, pinScale, pinScale)).setPosition(eye);
    youPin.matrixWorldNeedsUpdate = true;
    horizonDisc.position.copy(eye);
    horizonDisc.quaternion.setFromRotationMatrix(m4.makeBasis(fr.east, fr.north, fr.up));
    const sp = sightGeo.getAttribute("position") as THREE.BufferAttribute;
    sp.setXYZ(0, eye.x, eye.y, eye.z);
    sp.setXYZ(1, sel.pos.x, sel.pos.y, sel.pos.z);
    sp.needsUpdate = true;
    sightLine.computeLineDistances();
    const dashScale = camera.position.distanceTo(eye) / 80;
    const dm = sightLine.material as THREE.LineDashedMaterial;
    dm.dashSize = 6 * dashScale;
    dm.gapSize = 4 * dashScale;
    const ground = sel.pos.clone().sub(EARTH_CENTER).normalize().multiplyScalar(R).add(EARTH_CENTER);
    const dp = dropGeo.getAttribute("position") as THREE.BufferAttribute;
    dp.setXYZ(0, sel.pos.x, sel.pos.y, sel.pos.z);
    dp.setXYZ(1, ground.x, ground.y, ground.z);
    dp.needsUpdate = true;
  }

  // labels
  const L = state.labels;
  flights.forEach((f) => {
    const shown = project(f.pos, f.label, L && f.visible, -26);
    if (shown && state.mode === "ground") {
      const d = surfaceDistance(state.obsDir, f.realPos.clone().sub(EARTH_CENTER).normalize());
      f.label.textContent = `✈ ${f.name} · ${fmtMi(d)} mi away`;
    } else if (shown) f.label.textContent = `✈ ${f.name}`;
  });
  project(eye, youLabel, L && globeMode && helperFade > 0.5, -26);
  const horizonEdgePoint = eye.clone().addScaledVector(skyDir(fr, state.yaw + 90, 0), 320);
  project(horizonEdgePoint, horizonLabel, L && globeMode && helperFade > 0.5 && camAlt < 3000);
  for (const c of cities) project(c.pos, c.label, L && globeMode && camAlt > 250, 0);

  $("alt-value").textContent =
    state.mode === "ground" ? "On the ground" : camAlt < 1 ? `${Math.round(camAlt * 3281)} ft up` : `${fmtMi(camAlt)} mi up`;

  updateReadout();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ───────────────────────────── go ─────────────────────────────
rebuildCap();
setObserver(0, 0);
syncModeUI();
requestAnimationFrame(frame);
(window as unknown as { contrailSky: unknown }).contrailSky = {
  scene,
  camera,
  earthMat,
  state,
  setMode,
  flyToT,
  travelTo,
  aimAtPlane,
  HOME,
  // altitude parametrisation + easing, handy for poking at the camera without touching the UI
  altAtT,
  hToT,
  currentT,
  targetT: () => altTarget,
  setAltTarget,
  EYE_KM,
  MAX_ALT,
};
