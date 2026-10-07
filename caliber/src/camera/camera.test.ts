import { describe, expect, it } from 'vitest'
import type { CameraShot, Placement, Vec3 } from '../../shared/types'
import {
  FOCUS_PULL_FAR_FACTOR,
  buildShot,
  ease,
  heroFromPlacement,
  insertKey,
  removeKey,
  retimeShot,
  sampleShot,
  setKey,
  validateShot,
} from './index'

// Camera 5 cm up and 15 cm back, looking at the watch at the origin, along -Z.
const hero = { position: [0, 0.05, 0.15] as Vec3, target: [0, 0, 0] as Vec3, fov: 30 }
const HERO_DIST = Math.hypot(0.05, 0.15)

function expectVec(a: Vec3, b: Vec3, digits = 9) {
  for (let c = 0; c < 3; c++) expect(a[c]).toBeCloseTo(b[c], digits)
}
const sin20 = Math.sin((20 * Math.PI) / 180)
const cos20 = Math.cos((20 * Math.PI) / 180)

describe('buildShot', () => {
  it('push-in: hero -> 35% closer along the view line', () => {
    const s = buildShot(hero, 'push-in')
    expect(s.durationSeconds).toBe(8)
    expect(s.easing).toBe('ease-in-out')
    expect(s.amount).toBe(0.35)
    expect(s.keys).toHaveLength(2)
    expectVec(s.keys[0].position, [0, 0.05, 0.15])
    expectVec(s.keys[1].position, [0, 0.0325, 0.0975])
    expectVec(s.keys[1].target, [0, 0, 0])
    expect(s.keys[1].t).toBe(8)
  })

  it('push-in clamps to 3 cm from the target', () => {
    const s = buildShot(hero, 'push-in', { amount: 0.95 })
    const end = s.keys[1].position
    expect(Math.hypot(...end)).toBeCloseTo(0.03, 12)
    // still on the hero view line
    expect(end[1] / end[2]).toBeCloseTo(0.05 / 0.15, 12)
    // already inside the limit: no move, never backs away
    const near = buildShot({ ...hero, position: [0, 0, 0.02] }, 'push-in')
    expectVec(near.keys[1].position, [0, 0, 0.02])
  })

  it('pull-out: starts closer, ends on hero', () => {
    const s = buildShot(hero, 'pull-out')
    expectVec(s.keys[0].position, [0, 0.0325, 0.0975])
    expectVec(s.keys[1].position, hero.position)
  })

  it('orbit-arc: 3 keys, hero in the middle, +-20 degrees', () => {
    const s = buildShot(hero, 'orbit-arc')
    expect(s.amount).toBe(40)
    expect(s.keys.map((k) => k.t)).toEqual([0, 4, 8])
    expectVec(s.keys[0].position, [-0.15 * sin20, 0.05, 0.15 * cos20])
    expectVec(s.keys[1].position, hero.position)
    expectVec(s.keys[2].position, [0.15 * sin20, 0.05, 0.15 * cos20])
    const flipped = buildShot(hero, 'orbit-arc', { direction: -1 })
    expectVec(flipped.keys[0].position, [0.15 * sin20, 0.05, 0.15 * cos20])
  })

  it('slide: trucks 6 cm sideways, target follows 60%', () => {
    const s = buildShot(hero, 'slide')
    expectVec(s.keys[0].position, [-0.03, 0.05, 0.15])
    expectVec(s.keys[1].position, [0.03, 0.05, 0.15])
    expectVec(s.keys[0].target, [-0.018, 0, 0])
    expectVec(s.keys[1].target, [0.018, 0, 0])
    const left = buildShot(hero, 'slide', { direction: -1 })
    expectVec(left.keys[0].position, [0.03, 0.05, 0.15])
    expect(() => buildShot({ ...hero, position: [0, 0.2, 0] }, 'slide')).toThrow(/straight up or down/)
  })

  it('crane: ends on hero, starts above (1) or below with a floor (-1)', () => {
    const down = buildShot(hero, 'crane')
    expectVec(down.keys[0].position, [0, 0.1, 0.15])
    expectVec(down.keys[1].position, hero.position)
    const up = buildShot(hero, 'crane', { direction: -1 })
    expectVec(up.keys[0].position, [0, 0, 0.15])
    const upFar = buildShot(hero, 'crane', { direction: -1, amount: 0.2 })
    expectVec(upFar.keys[0].position, [0, -0.005, 0.15])
    for (const k of [...down.keys, ...up.keys]) expectVec(k.target, [0, 0, 0])
  })

  it('focus-pull: static rack focus with holds, fallback far focus', () => {
    const s = buildShot(hero, 'focus-pull')
    expect(s.keys.map((k) => k.t)).toEqual([0, 2, 6, 8])
    for (const k of s.keys) expectVec(k.position, hero.position)
    expect(s.keys[0].focusDistance).toBeCloseTo(HERO_DIST * FOCUS_PULL_FAR_FACTOR, 12)
    expect(s.keys[1].focusDistance).toBeCloseTo(HERO_DIST * FOCUS_PULL_FAR_FACTOR, 12)
    expect(s.keys[2].focusDistance).toBeCloseTo(HERO_DIST, 12)
    expect(s.keys[3].focusDistance).toBeCloseTo(HERO_DIST, 12)
  })

  it('focus-pull: opens on the measured background, holds, and reverses with direction -1', () => {
    const bg = HERO_DIST * 6
    const s = buildShot(hero, 'focus-pull', { backgroundFocusDistance: bg, easing: 'linear' })
    expect(sampleShot(s, 0).focusDistance).toBeCloseTo(bg, 12)
    expect(sampleShot(s, 1.5).focusDistance).toBeCloseTo(bg, 12)
    expect(sampleShot(s, 7).focusDistance).toBeCloseTo(HERO_DIST, 12)
    const rev = buildShot(hero, 'focus-pull', { backgroundFocusDistance: bg, direction: -1 })
    expect(rev.keys[0].focusDistance).toBeCloseTo(HERO_DIST, 12)
    expect(rev.keys[3].focusDistance).toBeCloseTo(bg, 12)
    // A "background" closer than the watch is ignored.
    const near = buildShot(hero, 'focus-pull', { backgroundFocusDistance: HERO_DIST * 1.1 })
    expect(near.keys[0].focusDistance).toBeCloseTo(HERO_DIST * FOCUS_PULL_FAR_FACTOR, 12)
  })

  it('orbit-arc 360: full turn from and back to the hero, constant radius, linear by default', () => {
    const s = buildShot(hero, 'orbit-arc', { amount: 360 })
    expect(s.easing).toBe('linear')
    expect(s.keys.length).toBe(9)
    expectVec(s.keys[0].position, hero.position)
    expectVec(s.keys[8].position, hero.position)
    const r0 = Math.hypot(hero.position[0], hero.position[2])
    let prev = Math.atan2(hero.position[0], hero.position[2])
    let swept = 0
    for (let i = 1; i <= 360; i++) {
      const p = sampleShot(s, (s.durationSeconds * i) / 360).position
      expect(Math.hypot(p[0], p[2])).toBeCloseTo(r0, 6)
      expect(p[1]).toBeCloseTo(hero.position[1], 6)
      const a = Math.atan2(p[0], p[2])
      let d = a - prev
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI
      expect(d).toBeGreaterThan(0) // never reverses
      swept += d
      prev = a
    }
    expect(swept).toBeCloseTo(2 * Math.PI, 6)
    expect(() => buildShot(hero, 'orbit-arc', { amount: 361 })).toThrow(/360/)
  })

  it('rejects custom and invalid options', () => {
    expect(() => buildShot(hero, 'custom')).toThrow(/custom/)
    expect(() => buildShot(hero, 'push-in', { amount: 1 })).toThrow()
    expect(() => buildShot(hero, 'push-in', { durationSeconds: 0.5 })).toThrow(/Duration/)
  })

  it('every generated shot validates', () => {
    for (const m of ['push-in', 'pull-out', 'orbit-arc', 'slide', 'crane', 'focus-pull'] as const) {
      expect(validateShot(buildShot(hero, m))).toEqual([])
    }
  })
})

describe('sampleShot', () => {
  it('orbit stays on the circle at every sampled time and hits hero at the midpoint', () => {
    for (const easing of ['linear', 'ease-in-out', 'ease-out'] as const) {
      const s = buildShot(hero, 'orbit-arc', { amount: 90, easing })
      for (let i = 0; i <= 200; i++) {
        const p = sampleShot(s, (i / 200) * s.durationSeconds)
        expect(Math.abs(Math.hypot(p.position[0], p.position[2]) - 0.15)).toBeLessThan(1e-6)
        expect(Math.abs(p.position[1] - 0.05)).toBeLessThan(1e-6)
        expectVec(p.target, [0, 0, 0])
      }
    }
    const s = buildShot(hero, 'orbit-arc')
    expect(sampleShot(s, 4).position).toEqual(hero.position)
  })

  it('orbit sweeps the azimuth monotonically', () => {
    const s = buildShot(hero, 'orbit-arc')
    let prev = -Infinity
    for (let i = 0; i <= 100; i++) {
      const p = sampleShot(s, (i / 100) * 8)
      const az = Math.atan2(p.position[0], p.position[2])
      expect(az).toBeGreaterThanOrEqual(prev)
      prev = az
    }
  })

  it('hits the first and last key exactly at 0 and duration', () => {
    for (const m of ['push-in', 'orbit-arc', 'slide', 'crane', 'focus-pull'] as const) {
      const s = buildShot(hero, m)
      const a = sampleShot(s, 0)
      const b = sampleShot(s, s.durationSeconds)
      expect(a.position).toEqual(s.keys[0].position)
      expect(a.target).toEqual(s.keys[0].target)
      expect(b.position).toEqual(s.keys[s.keys.length - 1].position)
      expect(b.target).toEqual(s.keys[s.keys.length - 1].target)
      expect(b.fov).toBe(30)
    }
  })

  it('clamps out-of-range times', () => {
    const s = buildShot(hero, 'push-in')
    expect(sampleShot(s, -5)).toEqual(sampleShot(s, 0))
    expect(sampleShot(s, 99)).toEqual(sampleShot(s, 8))
    expect(sampleShot(s, NaN)).toEqual(sampleShot(s, 0))
  })

  it('ease-in-out progress is monotonic with soft ends', () => {
    let prev = -1
    for (let i = 0; i <= 1000; i++) {
      const v = ease('ease-in-out', i / 1000)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
    expect(ease('ease-in-out', 0)).toBe(0)
    expect(ease('ease-in-out', 0.5)).toBeCloseTo(0.5, 12)
    expect(ease('ease-in-out', 1)).toBe(1)
    expect(ease('ease-in-out', 0.05)).toBeLessThan(0.05)
    // push-in distance shrinks monotonically
    const s = buildShot(hero, 'push-in')
    let d = Infinity
    for (let i = 0; i <= 100; i++) {
      const p = sampleShot(s, (i / 100) * 8)
      const nd = Math.hypot(...p.position)
      expect(nd).toBeLessThanOrEqual(d + 1e-15)
      d = nd
    }
  })

  it('focus-pull and focus defaults', () => {
    const fp = buildShot(hero, 'focus-pull', { easing: 'linear' })
    expect(sampleShot(fp, 4).focusDistance).toBeCloseTo(HERO_DIST * (FOCUS_PULL_FAR_FACTOR + 1) / 2, 12)
    const push = buildShot(hero, 'push-in')
    const mid = sampleShot(push, 4)
    expect(mid.focusDistance).toBeCloseTo(Math.hypot(...mid.position), 12)
  })

  it('3+ non-orbit keys pass through every key (Catmull-Rom)', () => {
    let s = buildShot(hero, 'push-in', { easing: 'linear' })
    s = insertKey(s, 4, { position: [0.04, 0.06, 0.1], target: [0, 0.01, 0], fov: 40 })
    const p = sampleShot(s, 4)
    expectVec(p.position, [0.04, 0.06, 0.1])
    expect(p.fov).toBe(40)
    const q = sampleShot(s, 2)
    expect(q.fov).toBeCloseTo(35, 12)
    for (const v of [...q.position, ...q.target]) expect(Number.isFinite(v)).toBe(true)
  })

  it('reuses the out object', () => {
    const s = buildShot(hero, 'slide')
    const out = sampleShot(s, 1)
    const again = sampleShot(s, 2, out)
    expect(again).toBe(out)
    expect(again).toEqual(sampleShot(s, 2))
  })
})

describe('validateShot', () => {
  const good = () => buildShot(hero, 'push-in')
  const expectProblem = (s: CameraShot, re: RegExp) => {
    const p = validateShot(s)
    expect(p.some((m) => re.test(m)), p.join(' | ')).toBe(true)
  }
  it('accepts a generated shot', () => expect(validateShot(good())).toEqual([]))
  it('needs >= 2 keys', () => expectProblem({ ...good(), keys: [good().keys[0]] }, /at least 2 keys/))
  it('needs sorted keys', () => {
    const s = buildShot(hero, 'orbit-arc')
    s.keys[1].t = 9
    expectProblem(s, /sorted/)
  })
  it('first key at 0', () => {
    const s = good()
    s.keys[0].t = 0.5
    expectProblem(s, /First key/)
  })
  it('last key at duration', () => {
    const s = good()
    s.keys[1].t = 7
    expectProblem(s, /Last key/)
  })
  it('duration 1-60', () => {
    expectProblem({ ...good(), durationSeconds: 0.5 }, /Duration/)
    expectProblem({ ...good(), durationSeconds: 61 }, /Duration/)
  })
  it('fov 5-120', () => {
    const s = good()
    s.keys[1].fov = 130
    expectProblem(s, /field of view/)
    const h = good()
    h.hero.fov = 2
    expectProblem(h, /Hero field of view/)
  })
  it('finite numbers and Vec3 shape', () => {
    const s = good()
    s.keys[0].position = [0, NaN, 0]
    expectProblem(s, /Key 1 position/)
    const t = good()
    ;(t.keys[1] as { target: unknown }).target = [0, 0]
    expectProblem(t, /Key 2 target/)
  })
})

describe('key editing', () => {
  it('retimeShot scales times and pins the last key', () => {
    const s = retimeShot(buildShot(hero, 'orbit-arc'), 12)
    expect(s.keys.map((k) => k.t)).toEqual([0, 6, 12])
    expect(s.move).toBe('orbit-arc')
    expect(validateShot(s)).toEqual([])
    expect(() => retimeShot(s, 0)).toThrow(/Duration/)
  })

  it('insertKey keeps order, defaults to the sampled pose, and marks custom', () => {
    const base = buildShot(hero, 'push-in')
    const s = insertKey(base, 3)
    expect(s.move).toBe('custom')
    expect(s.keys.map((k) => k.t)).toEqual([0, 3, 8])
    expect(s.keys[1].position).toEqual(sampleShot(base, 3).position)
    expect(validateShot(s)).toEqual([])
    expect(base.keys).toHaveLength(2) // not mutated
    expect(() => insertKey(base, 0)).toThrow()
    expect(() => insertKey(base, 8)).toThrow()
    expect(() => insertKey(s, 3)).toThrow(/already/)
  })

  it('setKey refuses breaking order or moving the ends', () => {
    const s = insertKey(buildShot(hero, 'push-in'), 4)
    const ok = setKey(s, 1, { ...s.keys[1], t: 5, fov: 25 })
    expect(ok.keys[1].t).toBe(5)
    expect(ok.move).toBe('custom')
    expect(validateShot(ok)).toEqual([])
    expect(() => setKey(s, 1, { ...s.keys[1], t: 9 })).toThrow()
    expect(() => setKey(s, 0, { ...s.keys[0], t: 1 })).toThrow(/first key/i)
    expect(() => setKey(s, 2, { ...s.keys[2], t: 7 })).toThrow(/last key/i)
    expect(() => setKey(s, 5, s.keys[0])).toThrow()
  })

  it('removeKey keeps ends and >= 2 keys', () => {
    const s = buildShot(hero, 'orbit-arc')
    const r = removeKey(s, 1)
    expect(r.keys.map((k) => k.t)).toEqual([0, 8])
    expect(r.move).toBe('custom')
    expect(() => removeKey(s, 0)).toThrow()
    expect(() => removeKey(s, 2)).toThrow()
    expect(() => removeKey(r, 1)).toThrow(/at least 2/)
  })

  it('heroFromPlacement copies the camera', () => {
    const placement: Placement = {
      worldScale: 1,
      worldOffset: [0, 0, 0],
      worldRotationY: 0,
      flipY: true,
      watch: { position: [0, 0, 0], rotation: [0, 0, 0], size: 0.036 },
      camera: { position: [0.1, 0.05, 0.1], target: [0, 0.01, 0], fov: 35 },
    }
    const h = heroFromPlacement(placement)
    expect(h).toEqual(placement.camera)
    expect(h.position).not.toBe(placement.camera.position)
  })
})
