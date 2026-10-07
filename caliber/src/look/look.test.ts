import { describe, expect, it } from 'vitest'
import { Euler, Matrix4, Vector3 } from 'three'
import {
  directionToEquirectUv,
  directionToPixel,
  equirectUvToDirection,
  panoRotationY,
  panoToWorld,
  pixelToDirection,
  type Vec3,
} from './panoMath'
import { estimateLightFromPixels } from './estimateLight'

const close = (a: Vec3, b: Vec3, eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)))

/** three.js GLSL equirectUv, transcribed. */
const threeEquirectUv = (d: Vec3): [number, number] => [
  Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5,
  Math.asin(Math.max(-1, Math.min(1, d[1]))) / Math.PI + 0.5,
]

describe('equirect <-> direction', () => {
  it('matches three.js landmarks', () => {
    close(equirectUvToDirection(0.5, 0.5), [1, 0, 0])
    close(equirectUvToDirection(0.75, 0.5), [0, 0, 1])
    close(equirectUvToDirection(0.25, 0.5), [0, 0, -1])
    close(equirectUvToDirection(0.5, 1), [0, 1, 0])
    close(equirectUvToDirection(0.5, 0), [0, -1, 0])
  })

  it('round-trips and agrees with three equirectUv', () => {
    for (let i = 0; i < 200; i++) {
      const u = 0.01 + 0.98 * ((i * 0.618) % 1)
      const v = 0.02 + 0.96 * ((i * 0.377) % 1)
      const d = equirectUvToDirection(u, v)
      expect(Math.hypot(...d)).toBeCloseTo(1, 9)
      const [u2, v2] = directionToEquirectUv(d)
      expect(u2).toBeCloseTo(u, 9)
      expect(v2).toBeCloseTo(v, 9)
      const [u3, v3] = threeEquirectUv(d)
      expect(u3).toBeCloseTo(u, 9)
      expect(v3).toBeCloseTo(v, 9)
    }
  })

  it('maps image pixels with the top row = up', () => {
    const W = 400
    const H = 200
    expect(pixelToDirection(W / 2, 0, W, H)[1]).toBeGreaterThan(0.99)
    expect(pixelToDirection(W / 2, H - 1, W, H)[1]).toBeLessThan(-0.99)
    const [x, y] = directionToPixel(pixelToDirection(123, 45, W, H), W, H)
    expect(x).toBeCloseTo(123.5, 6)
    expect(y).toBeCloseTo(45.5, 6)
  })
})

describe('environment rotation', () => {
  /** Direction three samples in the env for a world direction (WebGLMaterials negates the euler). */
  const sampleDir = (world: Vec3, theta: number): Vec3 => {
    const m = new Matrix4().makeRotationFromEuler(new Euler(0, -theta, 0))
    return new Vector3(...world).applyMatrix4(m).toArray() as Vec3
  }

  it('panoToWorld is the inverse of three’s env lookup', () => {
    for (const theta of [0, 0.7, Math.PI / 2, -2.1]) {
      const p = equirectUvToDirection(0.31, 0.62)
      close(sampleDir(panoToWorld(p, theta), theta), p)
    }
  })

  it('flipY worlds put the pano center (original forward view) at world -Z, left at -X', () => {
    const theta = panoRotationY({ flipY: true })
    close(panoToWorld(equirectUvToDirection(0.5, 0.5), theta), [0, 0, -1])
    // A quarter turn left of center in the pano (u = 0.25) is the viewer's left: world -X.
    close(panoToWorld(equirectUvToDirection(0.25, 0.5), theta), [-1, 0, 0])
    close(panoToWorld(equirectUvToDirection(0.5, 0.5), panoRotationY({ flipY: true, worldRotationY: Math.PI / 2 })), [-1, 0, 0])
  })
})

describe('estimateLightFromPixels', () => {
  const makePano = (W: number, H: number, blob: { x: number; y: number; r: number }, base = 60) => {
    const data = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const inBlob = Math.hypot(x - blob.x, y - blob.y) <= blob.r
        data[i] = inBlob ? 255 : base + 20
        data[i + 1] = inBlob ? 240 : base
        data[i + 2] = inBlob ? 200 : base - 20
        data[i + 3] = 255
      }
    return { width: W, height: H, data }
  }

  it('finds a bright blob and reports its direction', () => {
    const W = 256
    const H = 128
    const blob = { x: 80, y: 40, r: 5 }
    const est = estimateLightFromPixels(makePano(W, H, blob))
    const expected = pixelToDirection(blob.x, blob.y, W, H)
    const dot = est.panoDirection.reduce((s, v, i) => s + v * expected[i], 0)
    expect(dot).toBeGreaterThan(0.995)
    expect(est.pixel[0]).toBeCloseTo(blob.x + 0, 0)
    expect(est.elevationDeg).toBeGreaterThan(20)
    // Warm blob -> color red >= green >= blue; base is warm too.
    expect(est.color[0]).toBeGreaterThanOrEqual(est.color[1])
    expect(est.color[1]).toBeGreaterThan(est.color[2])
    expect(est.whiteBalance[0]).toBeGreaterThan(est.whiteBalance[2])
    expect(est.contrast).toBeGreaterThan(3)
  })

  it('applies rotationY to the world direction', () => {
    const est = estimateLightFromPixels(makePano(256, 128, { x: 128, y: 50, r: 4 }), { rotationY: panoRotationY({ flipY: true }) })
    // Blob at the pano center column -> in front of the original view: world -Z.
    expect(est.direction[2]).toBeLessThan(-0.8)
    expect(Math.abs(est.direction[0])).toBeLessThan(0.05)
    expect(est.direction[1]).toBeGreaterThan(0.1)
  })

  it('ignores bright pixels below the horizon by default', () => {
    const est = estimateLightFromPixels(makePano(256, 128, { x: 60, y: 110, r: 6 }))
    expect(est.panoDirection[1]).toBeGreaterThan(-0.1)
  })
})
