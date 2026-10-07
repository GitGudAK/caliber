// Surface levelling: fit a plane to collider samples and find the world tilt that makes it flat.
// Pure math (three.js math types only, no scene objects) so it is unit-testable.

import * as THREE from 'three'
import type { Placement } from '../../shared/types'

export interface PlaneFit {
  /** y = a*x + b*z + c */
  a: number
  b: number
  c: number
  /** Unit normal with y > 0. */
  normal: THREE.Vector3
  /** Tilt of the plane from horizontal, degrees. */
  tiltDeg: number
  /** RMS of vertical residuals (meters). */
  rms: number
  count: number
}

/** Least-squares plane y = a x + b z + c through the points (needs >= 3, not collinear in XZ). */
export function fitPlane(points: THREE.Vector3[]): PlaneFit | null {
  const n = points.length
  if (n < 3) return null
  // Fit in coordinates centred on the mean (better conditioned normal equations).
  const mean = new THREE.Vector3()
  for (const p of points) mean.add(p)
  mean.divideScalar(n)
  let sx = 0, sz = 0, sy = 0, sxx = 0, szz = 0, sxz = 0, sxy = 0, szy = 0
  for (const q of points) {
    const p = q.clone().sub(mean)
    sx += p.x; sz += p.z; sy += p.y
    sxx += p.x * p.x; szz += p.z * p.z; sxz += p.x * p.z
    sxy += p.x * p.y; szy += p.z * p.y
  }
  // Normal equations [sxx sxz sx; sxz szz sz; sx sz n] [a b c]^T = [sxy szy sy]^T
  const m = new THREE.Matrix3().set(sxx, sxz, sx, sxz, szz, sz, sx, sz, n)
  if (Math.abs(m.determinant()) < 1e-18) return null
  const inv = m.clone().invert()
  const r = new THREE.Vector3(sxy, szy, sy).applyMatrix3(inv)
  const [a, b] = [r.x, r.y]
  // Back to the original coordinates: y - my = a(x - mx) + b(z - mz) + r.z
  const c = r.z + mean.y - a * mean.x - b * mean.z
  let ss = 0
  for (const p of points) ss += (p.y - (a * p.x + b * p.z + c)) ** 2
  const normal = new THREE.Vector3(-a, 1, -b).normalize()
  return { a, b, c, normal, tiltDeg: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, normal.y))), rms: Math.sqrt(ss / n), count: n }
}

/** World rotation (X, Z, Y order: R = Ry * Rz * Rx) as a matrix. */
export function worldRotationMatrix(p: Pick<Placement, 'worldRotationX' | 'worldRotationY' | 'worldRotationZ'>): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(p.worldRotationX ?? 0, p.worldRotationY, p.worldRotationZ ?? 0, 'YZX'))
}

/**
 * Given a surface normal measured in the world (scene) frame under the current world rotation,
 * return worldRotationX/Z (worldRotationY kept) that make that surface horizontal.
 */
export function levelRotation(
  worldNormal: THREE.Vector3,
  current: Pick<Placement, 'worldRotationX' | 'worldRotationY' | 'worldRotationZ'>,
): { worldRotationX: number; worldRotationZ: number } {
  // Normal in the frame before the world rotation.
  const local = worldNormal.clone().applyMatrix4(worldRotationMatrix(current).invert()).normalize()
  // Want Ry * Rz * Rx * local = up  <=>  Rz * Rx * local = up (Ry keeps up).
  const x = Math.atan2(-local.z, local.y) // Rx zeroes the z component
  const r = Math.hypot(local.y, local.z)
  const z = Math.atan2(local.x, r) // Rz zeroes the x component
  return { worldRotationX: x, worldRotationZ: z }
}

/**
 * scene.environmentRotation that lines the pano up with a (possibly tilted) world.
 * Pano frame -> world: R = Rworld * Ry(base), base = panoRotationY of the untilted, unrotated world.
 * three samples the env with the matrix of the NEGATED Euler (same order), so we need
 * M(-E) = R^-1, i.e. E = -(Euler of R^-1). For a pure Y rotation this is exactly (0, base + wy, 0).
 */
export function environmentEuler(
  p: Pick<Placement, 'worldRotationX' | 'worldRotationY' | 'worldRotationZ'>,
  baseRotationY: number,
): THREE.Euler {
  const r = worldRotationMatrix(p).multiply(new THREE.Matrix4().makeRotationY(baseRotationY))
  const e = new THREE.Euler().setFromRotationMatrix(r.invert(), 'XYZ')
  return new THREE.Euler(-e.x, -e.y, -e.z, 'XYZ')
}
