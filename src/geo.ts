import * as THREE from "three";

/** Everything is in kilometres, in a local frame anchored at HOME:
 *  +X = east, +Y = up, +Z = south (so -Z = north). Earth's centre sits at (0, -R, 0).
 *  Keeping the origin at the city keeps float32 precise near the ground. */
export const R = 6371;
export const HOME = { lat: 39.7684, lon: -86.1581, name: "Indianapolis" };
export const EARTH_CENTER = new THREE.Vector3(0, -R, 0);

const D2R = Math.PI / 180;
const phi = HOME.lat * D2R;
const lam = HOME.lon * D2R;
// ECEF basis vectors at HOME
const eUp = new THREE.Vector3(Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi));
const eEast = new THREE.Vector3(-Math.sin(lam), Math.cos(lam), 0);
const eNorth = new THREE.Vector3(-Math.sin(phi) * Math.cos(lam), -Math.sin(phi) * Math.sin(lam), Math.cos(phi));

const tmp = new THREE.Vector3();

/** Unit direction from Earth's centre (local frame) for a latitude/longitude. */
export function dirFromLatLon(latDeg: number, lonDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const la = latDeg * D2R;
  const lo = lonDeg * D2R;
  tmp.set(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
  return out.set(tmp.dot(eEast), tmp.dot(eUp), -tmp.dot(eNorth));
}

export function latLonFromDir(d: THREE.Vector3): { lat: number; lon: number } {
  const x = eEast.x * d.x + eUp.x * d.y - eNorth.x * d.z;
  const y = eEast.y * d.x + eUp.y * d.y - eNorth.y * d.z;
  const z = eEast.z * d.x + eUp.z * d.y - eNorth.z * d.z;
  return { lat: Math.asin(Math.max(-1, Math.min(1, z))) / D2R, lon: Math.atan2(y, x) / D2R };
}

/** Direction for a spot `east`/`north` km from HOME (azimuthal-equidistant offsets). */
export function dirFromOffset(east: number, north: number, out = new THREE.Vector3()): THREE.Vector3 {
  const s = Math.hypot(east, north);
  if (s < 1e-9) return out.set(0, 1, 0);
  const th = s / R;
  const sn = Math.sin(th);
  return out.set((east / s) * sn, Math.cos(th), -(north / s) * sn);
}

export function offsetFromDir(d: THREE.Vector3): { east: number; north: number } {
  const th = Math.acos(Math.max(-1, Math.min(1, d.y)));
  const s = th * R;
  const h = Math.hypot(d.x, d.z);
  if (h < 1e-12) return { east: 0, north: 0 };
  return { east: (d.x / h) * s, north: (-d.z / h) * s };
}

export function pointAt(dir: THREE.Vector3, altKm: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(dir).multiplyScalar(R + altKm).add(EARTH_CENTER);
}

export type Frame = { up: THREE.Vector3; east: THREE.Vector3; north: THREE.Vector3 };

const pole = dirFromLatLon(90, 0);
export function frameAt(dir: THREE.Vector3): Frame {
  const up = dir.clone().normalize();
  const east = new THREE.Vector3().crossVectors(pole, up).normalize();
  const north = new THREE.Vector3().crossVectors(up, east);
  return { up, east, north };
}

/** A point a few km away from `origin` on the ground, in that spot's own frame. */
export function pointNear(f: Frame, dx: number, dy: number, alt: number, out = new THREE.Vector3()): THREE.Vector3 {
  tmp.copy(f.up).multiplyScalar(R).addScaledVector(f.east, dx).addScaledVector(f.north, dy).normalize();
  return pointAt(tmp, alt, out);
}

/** Great-circle surface distance between two unit directions. */
export function surfaceDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * R;
}

export const KM_PER_MI = 1.609344;
export function fmtMi(km: number): string {
  const mi = km / KM_PER_MI;
  return mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString();
}
export function fmtKm(km: number): string {
  return km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString();
}

/** Deterministic little RNG so the skyline doesn't reshuffle. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
