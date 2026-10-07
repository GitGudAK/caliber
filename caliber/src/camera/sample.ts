// Evaluate a CameraShot at a time. Runs every preview frame and for every export frame, so it is
// deterministic (same input -> same output, no randomness or clocks) and allocation-light:
// pass an `out` object to reuse it; the only allocation otherwise is the returned sample.

import type { CameraKey, CameraShot, Easing, Vec3 } from '../../shared/types'

export interface CameraSample {
  position: Vec3
  target: Vec3
  fov: number
  focusDistance: number
}

export function createSample(): CameraSample {
  return { position: [0, 0, 0], target: [0, 0, 0], fov: 0, focusDistance: 0 }
}

/** Map normalized time u in [0, 1] through an easing curve. Exact at 0 and 1, monotonic in between. */
export function ease(easing: Easing, u: number): number {
  if (u <= 0) return 0
  if (u >= 1) return 1
  switch (easing) {
    case 'linear':
      return u
    case 'ease-out': {
      const v = 1 - u
      return 1 - v * v * v
    }
    case 'ease-in-out':
    default: {
      if (u < 0.5) return 4 * u * u * u
      const v = -2 * u + 2
      return 1 - (v * v * v) / 2
    }
  }
}

/** Centripetal Catmull-Rom (alpha = 0.5). */
const ALPHA = 0.5
/** Below this, a key distance is treated as zero (meters). */
const EPS = 1e-12
/** Orbit detection tolerance: relative to the key radius / absolute meters for height. */
const ORBIT_TOL = 1e-9

/**
 * Sample the shot at `timeSeconds` (clamped to [0, durationSeconds]).
 *
 * 1. The easing is applied to global normalized time, giving an eased shot time tau.
 * 2. tau picks a key segment by key times.
 * 3. Position and target:
 *    - 2 keys: straight lerp.
 *    - 3+ keys: centripetal Catmull-Rom through the key positions and targets (phantom end points
 *      are reflections, so the curve starts and ends on the first and last key).
 *    - 3+ keys that all sit at the same horizontal radius and height relative to their target
 *      (an orbit): position is interpolated in cylindrical coordinates about the sampled target,
 *      with the azimuth on a time-knot Catmull-Rom, so the arc is exactly round. Cartesian
 *      Catmull-Rom would cut slightly inside the circle between keys.
 * 4. fov and focusDistance are piecewise-linear by key. A key without focusDistance uses its own
 *    |position - target|; if neither key of the segment has one, focus tracks the sampled target.
 *
 * At key times the key values are returned exactly.
 */
export function sampleShot(shot: CameraShot, timeSeconds: number, out: CameraSample = createSample()): CameraSample {
  const keys = shot.keys
  const n = keys.length
  if (n === 0) throw new Error('sampleShot: shot has no keys')
  if (n === 1) return writeKey(out, keys[0])

  const T = shot.durationSeconds
  let time = Number.isFinite(timeSeconds) ? timeSeconds : 0
  if (time < 0) time = 0
  if (time > T) time = T
  const e = T > 0 ? ease(shot.easing, time / T) : 1

  const t0 = keys[0].t
  const tn = keys[n - 1].t
  if (e <= 0) return writeKey(out, keys[0])
  if (e >= 1) return writeKey(out, keys[n - 1])
  const tau = t0 + e * (tn - t0)

  let i = 0
  while (i < n - 2 && keys[i + 1].t <= tau) i++
  const a = keys[i]
  const b = keys[i + 1]
  const span = b.t - a.t
  const s = span > 0 ? (tau - a.t) / span : 1
  if (s <= 0) return writeKey(out, a)
  if (s >= 1) return writeKey(out, b)

  const pos = out.position
  const tgt = out.target
  if (n === 2) {
    for (let c = 0; c < 3; c++) {
      pos[c] = a.position[c] + (b.position[c] - a.position[c]) * s
      tgt[c] = a.target[c] + (b.target[c] - a.target[c]) * s
    }
  } else {
    centripetal(keys, i, s, 'target', tgt)
    if (isOrbit(keys)) orbitPosition(keys, i, tau, tgt, pos)
    else centripetal(keys, i, s, 'position', pos)
  }

  out.fov = a.fov + (b.fov - a.fov) * s
  if (a.focusDistance === undefined && b.focusDistance === undefined) {
    out.focusDistance = Math.hypot(pos[0] - tgt[0], pos[1] - tgt[1], pos[2] - tgt[2])
  } else {
    const fa = a.focusDistance ?? keyDistance(a)
    const fb = b.focusDistance ?? keyDistance(b)
    out.focusDistance = fa + (fb - fa) * s
  }
  return out
}

function writeKey(out: CameraSample, k: CameraKey): CameraSample {
  for (let c = 0; c < 3; c++) {
    out.position[c] = k.position[c]
    out.target[c] = k.target[c]
  }
  out.fov = k.fov
  out.focusDistance = k.focusDistance ?? keyDistance(k)
  return out
}

function keyDistance(k: CameraKey): number {
  return Math.hypot(k.position[0] - k.target[0], k.position[1] - k.target[1], k.position[2] - k.target[2])
}

// Component c of point j, with reflected phantom points at j = -1 and j = n.
function pt(keys: CameraKey[], field: 'position' | 'target', j: number, c: number): number {
  const n = keys.length
  if (j < 0) return 2 * keys[0][field][c] - keys[1][field][c]
  if (j >= n) return 2 * keys[n - 1][field][c] - keys[n - 2][field][c]
  return keys[j][field][c]
}

function knotDelta(keys: CameraKey[], field: 'position' | 'target', j: number): number {
  const dx = pt(keys, field, j + 1, 0) - pt(keys, field, j, 0)
  const dy = pt(keys, field, j + 1, 1) - pt(keys, field, j, 1)
  const dz = pt(keys, field, j + 1, 2) - pt(keys, field, j, 2)
  return Math.pow(dx * dx + dy * dy + dz * dz, ALPHA / 2)
}

/** Centripetal Catmull-Rom on segment i (between keys i and i+1), local parameter s in (0, 1). */
function centripetal(keys: CameraKey[], i: number, s: number, field: 'position' | 'target', out: Vec3) {
  const d12 = knotDelta(keys, field, i)
  if (d12 < EPS) {
    // Coincident end points: nothing to curve through.
    for (let c = 0; c < 3; c++) out[c] = keys[i][field][c]
    return
  }
  const d01 = Math.max(knotDelta(keys, field, i - 1), d12 * 1e-6)
  const d23 = Math.max(knotDelta(keys, field, i + 1), d12 * 1e-6)
  const k0 = 0
  const k1 = d01
  const k2 = k1 + d12
  const k3 = k2 + d23
  const u = k1 + s * d12
  for (let c = 0; c < 3; c++) {
    const p0 = pt(keys, field, i - 1, c)
    const p1 = pt(keys, field, i, c)
    const p2 = pt(keys, field, i + 1, c)
    const p3 = pt(keys, field, i + 2, c)
    // Barry-Goldman pyramid.
    const a1 = ((k1 - u) * p0 + (u - k0) * p1) / (k1 - k0)
    const a2 = ((k2 - u) * p1 + (u - k1) * p2) / (k2 - k1)
    const a3 = ((k3 - u) * p2 + (u - k2) * p3) / (k3 - k2)
    const b1 = ((k2 - u) * a1 + (u - k0) * a2) / (k2 - k0)
    const b2 = ((k3 - u) * a2 + (u - k1) * a3) / (k3 - k1)
    out[c] = ((k2 - u) * b1 + (u - k1) * b2) / (k2 - k1)
  }
}

function isOrbit(keys: CameraKey[]): boolean {
  const k0 = keys[0]
  const r0 = Math.hypot(k0.position[0] - k0.target[0], k0.position[2] - k0.target[2])
  if (r0 < 1e-6) return false
  const h0 = k0.position[1] - k0.target[1]
  for (let j = 1; j < keys.length; j++) {
    const k = keys[j]
    const r = Math.hypot(k.position[0] - k.target[0], k.position[2] - k.target[2])
    if (Math.abs(r - r0) > ORBIT_TOL * r0) return false
    if (Math.abs(k.position[1] - k.target[1] - h0) > ORBIT_TOL) return false
  }
  return true
}

// Azimuth of key j about its target (0 along +Z, increasing counter-clockwise from above),
// unwrapped against key 0 so consecutive keys never jump by more than pi.
function azimuth(keys: CameraKey[], j: number): number {
  let prev = 0
  let theta = 0
  for (let m = 0; m <= j; m++) {
    const k = keys[m]
    const raw = Math.atan2(k.position[0] - k.target[0], k.position[2] - k.target[2])
    if (m === 0) theta = raw
    else {
      let d = raw - prev
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI
      theta += d
    }
    prev = raw
  }
  return theta
}

// Tangent of the azimuth at key j w.r.t. time (non-uniform Catmull-Rom; reproduces linear motion exactly).
function azimuthSlope(keys: CameraKey[], j: number): number {
  const n = keys.length
  if (j === 0) return slope(keys, 0, 1)
  if (j === n - 1) return slope(keys, n - 2, n - 1)
  const dtL = keys[j].t - keys[j - 1].t
  const dtR = keys[j + 1].t - keys[j].t
  const total = dtL + dtR
  if (total <= 0) return 0
  return (slope(keys, j, j + 1) * dtL + slope(keys, j - 1, j) * dtR) / total
}

function slope(keys: CameraKey[], a: number, b: number): number {
  const dt = keys[b].t - keys[a].t
  return dt > 0 ? (azimuth(keys, b) - azimuth(keys, a)) / dt : 0
}

function orbitPosition(keys: CameraKey[], i: number, tau: number, target: Vec3, out: Vec3) {
  const a = keys[i]
  const b = keys[i + 1]
  const h = b.t - a.t
  const s = (tau - a.t) / h
  const th0 = azimuth(keys, i)
  const th1 = azimuth(keys, i + 1)
  const m0 = azimuthSlope(keys, i) * h
  const m1 = azimuthSlope(keys, i + 1) * h
  const s2 = s * s
  const s3 = s2 * s
  const theta = (2 * s3 - 3 * s2 + 1) * th0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * th1 + (s3 - s2) * m1
  const r = Math.hypot(a.position[0] - a.target[0], a.position[2] - a.target[2])
  const height = a.position[1] - a.target[1]
  out[0] = target[0] + r * Math.sin(theta)
  out[1] = target[1] + height
  out[2] = target[2] + r * Math.cos(theta)
}
