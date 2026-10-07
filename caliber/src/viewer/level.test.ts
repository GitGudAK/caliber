import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { fitPlane, levelRotation, worldRotationMatrix } from './level'

const deg = THREE.MathUtils.degToRad

function planePoints(normal: THREE.Vector3, through: THREE.Vector3) {
  const pts: THREE.Vector3[] = []
  for (let i = -3; i <= 3; i++)
    for (let j = -3; j <= 3; j++) {
      const x = through.x + i * 0.005
      const z = through.z + j * 0.005
      // n . (p - through) = 0  ->  y
      const y = through.y - (normal.x * (x - through.x) + normal.z * (z - through.z)) / normal.y
      pts.push(new THREE.Vector3(x, y, z))
    }
  return pts
}

describe('fitPlane', () => {
  it('recovers a tilted plane exactly', () => {
    const n = new THREE.Vector3(0.07, 1, -0.065).normalize()
    const fit = fitPlane(planePoints(n, new THREE.Vector3(0.01, -0.03, -0.05)))!
    expect(fit.normal.angleTo(n)).toBeLessThan(1e-9)
    expect(fit.rms).toBeLessThan(1e-12)
    expect(fit.tiltDeg).toBeCloseTo(THREE.MathUtils.radToDeg(n.angleTo(new THREE.Vector3(0, 1, 0))), 9)
  })
  it('returns null for too few points', () => {
    expect(fitPlane([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)])).toBeNull()
  })
})

describe('levelRotation', () => {
  it('makes the measured surface horizontal while keeping worldRotationY', () => {
    for (const wy of [0, 0.7, -2.1]) {
      const current = { worldRotationX: deg(1), worldRotationY: wy, worldRotationZ: deg(-2) }
      const worldNormal = new THREE.Vector3(0.06, 1, 0.08).normalize()
      const r = levelRotation(worldNormal, current)
      // The same physical surface, re-rotated with the new angles.
      const local = worldNormal.clone().applyMatrix4(worldRotationMatrix(current).invert())
      const levelled = local.applyMatrix4(worldRotationMatrix({ ...r, worldRotationY: wy }))
      expect(levelled.angleTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-9)
    }
  })
  it('is zero for an already level surface', () => {
    const r = levelRotation(new THREE.Vector3(0, 1, 0), { worldRotationY: 1.2 })
    expect(Math.abs(r.worldRotationX)).toBeLessThan(1e-12)
    expect(Math.abs(r.worldRotationZ)).toBeLessThan(1e-12)
  })
})
