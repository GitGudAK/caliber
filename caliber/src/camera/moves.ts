// Preset camera moves, generated relative to the hero framing.
// Units: meters, three.js Y-up. Pure math: no three.js objects, no DOM.

import type { CameraKey, CameraMove, CameraShot, Easing, Placement, Vec3 } from '../../shared/types'
import { validateShot } from './validate'

export type HeroFrame = CameraShot['hero']

export interface BuildShotOptions {
  /** Move strength; meaning depends on the move (see MOVE_DEFAULTS). */
  amount?: number
  /** 1 or -1; flips orbit sense, slide side, crane start above/below. */
  direction?: 1 | -1
  durationSeconds?: number
  easing?: Easing
  /**
   * focus-pull only: distance from the hero camera to the background surface (e.g. a collider
   * raycast through the target). The rack opens focused exactly there so the background is crisp.
   * Ignored unless clearly beyond the watch; falls back to FOCUS_PULL_FAR_FACTOR x the target distance.
   */
  backgroundFocusDistance?: number
}

/** 8 s reads as a slow, premium product move; long enough to breathe, short enough for an ad cut. */
export const DEFAULT_DURATION_SECONDS = 8
/** Ease-in-out: no visible start/stop jolt, like a real dolly/slider with soft ramps. */
export const DEFAULT_EASING: Easing = 'ease-in-out'

/** Closest a generated push-in/pull-out may bring the camera to the target (meters). */
export const MIN_CAMERA_DISTANCE = 0.03
/** A crane-up (direction -1) never starts lower than this far below the target height. */
export const CRANE_BELOW_TARGET_LIMIT = 0.005
/** Slide: the target moves this fraction of the camera offset, so the watch drifts gently in frame (parallax). */
export const SLIDE_TARGET_FOLLOW = 0.6
/** A full orbit; also the maximum orbit-arc amount. */
export const FULL_TURN_DEGREES = 360
/** Generated orbit keys are at most this far apart (must stay well under 180 for unambiguous unwrapping). */
export const ORBIT_KEY_STEP_DEGREES = 45

/** Fallback when no background distance is known: focus at this multiple of the camera-to-target distance. */
// 2x keeps the start focus inside a tabletop world (4x landed behind the back wall at macro scale).
export const FOCUS_PULL_FAR_FACTOR = 2
/** A background distance must be at least this multiple of the target distance to be used. */
export const FOCUS_PULL_MIN_BACKGROUND_FACTOR = 1.3
/** Rack focus timing: hold the first focus for this fraction, rack, then hold the second focus for the same fraction. */
export const FOCUS_PULL_HOLD_FRACTION = 0.25

/**
 * Default amount per move:
 * - push-in / pull-out: 0.35 — fraction of the hero distance removed. A third of the way in
 *   is a noticeable but restrained dolly; more feels like a zoom gimmick.
 * - orbit-arc: 40 degrees total sweep, centered on the hero (-20 to +20). Shows dial and
 *   case side without swinging round to the back.
 * - slide: 0.06 m total truck (about 1.7 watch widths), centered on the hero.
 * - crane: 0.05 m vertical travel, ending at the hero.
 * - focus-pull: amount unused (stored as 0). A rack focus with holds: background sharp / watch soft for the
 *   first quarter, rack over the middle half, watch sharp / background soft for the last quarter.
 *   direction 1 = background -> watch (the reveal); -1 = watch -> background.
 */
export const MOVE_DEFAULTS: Record<Exclude<CameraMove, 'custom'>, number> = {
  'push-in': 0.35,
  'pull-out': 0.35,
  'orbit-arc': 40,
  slide: 0.06,
  crane: 0.05,
  'focus-pull': 0,
}

export function heroFromPlacement(placement: Placement): HeroFrame {
  const c = placement.camera
  return { position: [...c.position] as Vec3, target: [...c.target] as Vec3, fov: c.fov }
}

/** Generate a shot's keys from the hero framing. Throws on 'custom' or invalid input. */
export function buildShot(hero: HeroFrame, move: CameraMove, opts: BuildShotOptions = {}): CameraShot {
  if (move === 'custom') throw new Error("buildShot: 'custom' shots are hand-edited, not generated")
  if (!(move in MOVE_DEFAULTS)) throw new Error(`buildShot: unknown move "${String(move)}"`)
  if (!isFiniteVec(hero.position) || !isFiniteVec(hero.target) || !Number.isFinite(hero.fov)) {
    throw new Error('buildShot: hero position, target and fov must be finite numbers')
  }
  const amount = opts.amount ?? MOVE_DEFAULTS[move]
  const direction = opts.direction ?? 1
  const durationSeconds = opts.durationSeconds ?? DEFAULT_DURATION_SECONDS
  // A full orbit loops on social: constant speed so the seam doesn't slow down.
  const easing = opts.easing ?? (move === 'orbit-arc' && amount >= FULL_TURN_DEGREES ? 'linear' : DEFAULT_EASING)
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`buildShot: amount must be a finite number >= 0 (got ${amount})`)
  if (direction !== 1 && direction !== -1) throw new Error(`buildShot: direction must be 1 or -1 (got ${String(direction)})`)

  const hp = hero.position
  const ht = hero.target
  const fov = hero.fov
  const T = durationSeconds
  const key = (t: number, position: Vec3, target: Vec3, focusDistance?: number): CameraKey =>
    focusDistance === undefined
      ? { t, position, target, fov }
      : { t, position, target, fov, focusDistance }

  let keys: CameraKey[]
  switch (move) {
    case 'push-in':
    case 'pull-out': {
      if (amount >= 1) throw new Error(`buildShot: ${move} amount is a fraction of the hero distance and must be < 1 (got ${amount})`)
      const close = dollyTowardTarget(hp, ht, amount)
      keys = move === 'push-in'
        ? [key(0, copy(hp), copy(ht)), key(T, close, copy(ht))]
        : [key(0, close, copy(ht)), key(T, copy(hp), copy(ht))]
      break
    }
    case 'orbit-arc': {
      // Rotate about world Y through the target. Positive angle = counter-clockwise seen from above.
      if (amount > FULL_TURN_DEGREES) throw new Error(`buildShot: orbit-arc amount must be at most ${FULL_TURN_DEGREES} degrees (got ${amount})`)
      // Keys at most ORBIT_KEY_STEP_DEGREES apart: sampleShot unwraps angles between consecutive keys
      // within pi, so a half-turn gap would be ambiguous.
      const segments = Math.max(2, Math.ceil(amount / ORBIT_KEY_STEP_DEGREES))
      const total = (amount * Math.PI) / 180 * direction
      // A full turn starts and ends on the hero (seamless loop); a partial arc is centered on it.
      const start = amount >= FULL_TURN_DEGREES ? 0 : -total / 2
      keys = []
      for (let i = 0; i <= segments; i++) {
        const angle = start + (total * i) / segments
        keys.push(key((T * i) / segments, Math.abs(angle) < 1e-12 ? copy(hp) : rotateAboutY(hp, ht, angle), copy(ht)))
      }
      break
    }
    case 'slide': {
      const fx = ht[0] - hp[0]
      const fz = ht[2] - hp[2]
      const len = Math.hypot(fx, fz)
      if (len < 1e-9) throw new Error('buildShot: slide needs a view direction that is not straight up or down')
      // Camera-right in the horizontal plane: forward x up.
      const rx = -fz / len
      const rz = fx / len
      const h = (amount / 2) * direction
      const camOff = (s: number): Vec3 => [rx * h * s, 0, rz * h * s]
      const k = SLIDE_TARGET_FOLLOW
      keys = [
        key(0, add(hp, camOff(-1)), add(ht, camOff(-k))),
        key(T, add(hp, camOff(1)), add(ht, camOff(k))),
      ]
      break
    }
    case 'crane': {
      // Both directions resolve on the hero. direction 1 = crane down from above;
      // -1 = crane up from below, never starting lower than target.y - CRANE_BELOW_TARGET_LIMIT
      // (and never above the hero if the hero itself already sits below that floor).
      let startY: number
      if (direction === 1) startY = hp[1] + amount
      else startY = Math.max(hp[1] - amount, Math.min(hp[1], ht[1] - CRANE_BELOW_TARGET_LIMIT))
      keys = [key(0, [hp[0], startY, hp[2]], copy(ht)), key(T, copy(hp), copy(ht))]
      break
    }
    case 'focus-pull': {
      const d = dist(hp, ht)
      if (d < 1e-9) throw new Error('buildShot: focus-pull needs the camera away from the target')
      const bg = opts.backgroundFocusDistance
      const far = bg !== undefined && Number.isFinite(bg) && bg >= d * FOCUS_PULL_MIN_BACKGROUND_FACTOR ? bg : d * FOCUS_PULL_FAR_FACTOR
      const [from, to] = direction === 1 ? [far, d] : [d, far]
      const h = T * FOCUS_PULL_HOLD_FRACTION
      keys = [
        key(0, copy(hp), copy(ht), from),
        key(h, copy(hp), copy(ht), from),
        key(T - h, copy(hp), copy(ht), to),
        key(T, copy(hp), copy(ht), to),
      ]
      break
    }
  }

  const shot: CameraShot = {
    hero: { ...hero, position: copy(hp), target: copy(ht) },
    move,
    amount,
    direction,
    durationSeconds,
    easing,
    keys,
  }
  const problems = validateShot(shot)
  if (problems.length) throw new Error(`buildShot: ${problems.join('; ')}`)
  return shot
}

/**
 * Move the camera along the hero view line toward the target, removing `fraction` of the
 * distance, clamped so it ends no closer than MIN_CAMERA_DISTANCE. If the hero is already
 * inside that limit the camera stays put (a zero-length move) rather than backing away.
 */
export function dollyTowardTarget(pos: Vec3, target: Vec3, fraction: number): Vec3 {
  const d = dist(pos, target)
  if (d <= MIN_CAMERA_DISTANCE) return copy(pos)
  const nd = Math.max(d * (1 - fraction), MIN_CAMERA_DISTANCE)
  const s = nd / d
  return [
    target[0] + (pos[0] - target[0]) * s,
    target[1] + (pos[1] - target[1]) * s,
    target[2] + (pos[2] - target[2]) * s,
  ]
}

/** Rotate `pos` about the vertical axis through `center` by `angle` radians (right-handed, Y-up). */
export function rotateAboutY(pos: Vec3, center: Vec3, angle: number): Vec3 {
  const dx = pos[0] - center[0]
  const dz = pos[2] - center[2]
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [center[0] + dx * c + dz * s, pos[1], center[2] - dx * s + dz * c]
}

function copy(v: Vec3): Vec3 {
  return [v[0], v[1], v[2]]
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
function isFiniteVec(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
}
