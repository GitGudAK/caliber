// Strict validation for Placement / ProjectScene request bodies. Unknown keys are
// rejected so a typo never silently falls back to a stored value.
import type { AudioTrack, CameraKey, CameraMove, CameraShot, Easing, Placement, ProjectScene, SceneLook, ShotDof, Vec3 } from '../../shared/types.ts'
import { badRequest } from './errors.ts'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

function object(value: unknown, at: string, keys: string[], optional: string[] = []): Obj {
  if (!isObj(value)) throw badRequest(`"${at}" must be an object`)
  const allowed = [...keys, ...optional]
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw badRequest(`Unknown field "${at}.${key}" (expected ${allowed.join(', ')})`)
  }
  for (const key of keys) {
    if (value[key] === undefined) throw badRequest(`Missing field "${at}.${key}"`)
  }
  return value
}

function num(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest(`"${at}" must be a finite number (got ${JSON.stringify(value)})`)
  return value
}

function vec3(value: unknown, at: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw badRequest(`"${at}" must be an array of 3 numbers (got ${JSON.stringify(value)})`)
  return [num(value[0], `${at}[0]`), num(value[1], `${at}[1]`), num(value[2], `${at}[2]`)]
}

export function parsePlacement(value: unknown, at = 'placement'): Placement {
  const p = object(value, at, ['worldScale', 'worldOffset', 'worldRotationY', 'flipY', 'watch', 'camera'], ['worldRotationX', 'worldRotationZ'])
  const worldScale = num(p.worldScale, `${at}.worldScale`)
  if (worldScale <= 0) throw badRequest(`"${at}.worldScale" must be > 0 (got ${worldScale})`)
  if (typeof p.flipY !== 'boolean') throw badRequest(`"${at}.flipY" must be a boolean`)

  const w = object(p.watch, `${at}.watch`, ['position', 'rotation', 'size'])
  const size = num(w.size, `${at}.watch.size`)
  if (size <= 0) throw badRequest(`"${at}.watch.size" must be > 0 (got ${size})`)

  const c = object(p.camera, `${at}.camera`, ['position', 'target', 'fov'])
  const fov = num(c.fov, `${at}.camera.fov`)
  if (fov < 5 || fov > 120) throw badRequest(`"${at}.camera.fov" must be between 5 and 120 degrees (got ${fov})`)

  const tilt = (key: 'worldRotationX' | 'worldRotationZ'): number | undefined => {
    if (p[key] === undefined) return undefined
    const r = num(p[key], `${at}.${key}`)
    // Levelling a reconstructed surface needs a few degrees; more than 45° is a mistake, not a level.
    if (Math.abs(r) > Math.PI / 4) throw badRequest(`"${at}.${key}" must be between -π/4 and π/4 radians (got ${r})`)
    return r
  }
  const worldRotationX = tilt('worldRotationX')
  const worldRotationZ = tilt('worldRotationZ')
  return {
    worldScale,
    worldOffset: vec3(p.worldOffset, `${at}.worldOffset`),
    worldRotationY: num(p.worldRotationY, `${at}.worldRotationY`),
    ...(worldRotationX !== undefined ? { worldRotationX } : {}),
    ...(worldRotationZ !== undefined ? { worldRotationZ } : {}),
    flipY: p.flipY,
    watch: { position: vec3(w.position, `${at}.watch.position`), rotation: vec3(w.rotation, `${at}.watch.rotation`), size },
    camera: { position: vec3(c.position, `${at}.camera.position`), target: vec3(c.target, `${at}.camera.target`), fov },
  }
}

const CAMERA_MOVES: readonly CameraMove[] = ['push-in', 'pull-out', 'orbit-arc', 'slide', 'crane', 'focus-pull', 'custom']
const EASINGS: readonly Easing[] = ['linear', 'ease-in-out', 'ease-out']
const T_TOLERANCE = 1e-6

function fovDeg(value: unknown, at: string): number {
  const fov = num(value, at)
  if (fov < 5 || fov > 120) throw badRequest(`"${at}" must be between 5 and 120 degrees (got ${fov})`)
  return fov
}

/** Shared by the hero framing and each key: position, target, fov, optional focusDistance (> 0). */
function framing(o: Obj, at: string): Omit<CameraKey, 't'> {
  const out: Omit<CameraKey, 't'> = {
    position: vec3(o.position, `${at}.position`),
    target: vec3(o.target, `${at}.target`),
    fov: fovDeg(o.fov, `${at}.fov`),
  }
  if (o.focusDistance !== undefined) {
    const d = num(o.focusDistance, `${at}.focusDistance`)
    if (d <= 0) throw badRequest(`"${at}.focusDistance" must be > 0 (got ${d})`)
    out.focusDistance = d
  }
  return out
}

export function parseShot(value: unknown, at = 'shot'): CameraShot {
  const s = object(value, at, ['hero', 'move', 'amount', 'direction', 'durationSeconds', 'easing', 'keys'], ['dof'])

  const hero = framing(object(s.hero, `${at}.hero`, ['position', 'target', 'fov'], ['focusDistance']), `${at}.hero`)

  if (typeof s.move !== 'string' || !CAMERA_MOVES.includes(s.move as CameraMove)) {
    throw badRequest(`"${at}.move" must be one of ${CAMERA_MOVES.join(', ')} (got ${JSON.stringify(s.move)})`)
  }
  if (typeof s.easing !== 'string' || !EASINGS.includes(s.easing as Easing)) {
    throw badRequest(`"${at}.easing" must be one of ${EASINGS.join(', ')} (got ${JSON.stringify(s.easing)})`)
  }
  if (s.direction !== 1 && s.direction !== -1) {
    throw badRequest(`"${at}.direction" must be 1 or -1 (got ${JSON.stringify(s.direction)})`)
  }
  const amount = num(s.amount, `${at}.amount`)
  const durationSeconds = num(s.durationSeconds, `${at}.durationSeconds`)
  if (durationSeconds < 1 || durationSeconds > 60) {
    throw badRequest(`"${at}.durationSeconds" must be between 1 and 60 seconds (got ${durationSeconds})`)
  }

  if (!Array.isArray(s.keys)) throw badRequest(`"${at}.keys" must be an array of camera keys`)
  if (s.keys.length < 2) throw badRequest(`"${at}.keys" must have at least 2 keys (got ${s.keys.length})`)
  const keys: CameraKey[] = s.keys.map((raw, i) => {
    const kAt = `${at}.keys[${i}]`
    const k = object(raw, kAt, ['t', 'position', 'target', 'fov'], ['focusDistance'])
    return { t: num(k.t, `${kAt}.t`), ...framing(k, kAt) }
  })
  for (let i = 1; i < keys.length; i++) {
    if (!(keys[i].t > keys[i - 1].t)) {
      throw badRequest(`"${at}.keys[${i}].t" must be greater than "${at}.keys[${i - 1}].t" (got ${keys[i].t} after ${keys[i - 1].t})`)
    }
  }
  const first = keys[0].t
  if (Math.abs(first) > T_TOLERANCE) throw badRequest(`"${at}.keys[0].t" must be 0 (got ${first})`)
  const lastIdx = keys.length - 1
  const last = keys[lastIdx].t
  if (Math.abs(last - durationSeconds) > T_TOLERANCE) {
    throw badRequest(`"${at}.keys[${lastIdx}].t" must equal "${at}.durationSeconds" (${durationSeconds}) (got ${last})`)
  }

  const shot: CameraShot = { hero, move: s.move as CameraMove, amount, direction: s.direction, durationSeconds, easing: s.easing as Easing, keys }
  if (s.dof !== undefined) shot.dof = parseDof(s.dof, `${at}.dof`)
  return shot
}

function parseDof(value: unknown, at: string): ShotDof {
  const d = object(value, at, ['enabled', 'apertureDegrees'])
  if (typeof d.enabled !== 'boolean') throw badRequest(`"${at}.enabled" must be a boolean`)
  return { enabled: d.enabled, apertureDegrees: ranged(d.apertureDegrees, `${at}.apertureDegrees`, 0.1, 5.7, ' degrees') }
}

export function parseLook(value: unknown, at = 'look'): SceneLook {
  const l = object(value, at, ['shadows', 'shadowOpacity', 'contact', 'grain'])
  if (typeof l.shadows !== 'boolean') throw badRequest(`"${at}.shadows" must be a boolean`)
  if (typeof l.contact !== 'boolean') throw badRequest(`"${at}.contact" must be a boolean`)
  return {
    shadows: l.shadows,
    shadowOpacity: ranged(l.shadowOpacity, `${at}.shadowOpacity`, 0, 1),
    contact: l.contact,
    grain: ranged(l.grain, `${at}.grain`, 0, 0.1),
  }
}

function ranged(value: unknown, at: string, min: number, max: number, unit = ''): number {
  const n = num(value, at)
  if (n < min || n > max) throw badRequest(`"${at}" must be between ${min} and ${max}${unit} (got ${n})`)
  return n
}

/** Shape-only parse; whether assetId is a library audio asset is checked by the route. */
export function parseAudio(value: unknown, at = 'audio'): AudioTrack {
  const a = object(value, at, ['assetId', 'volume', 'offsetSeconds', 'fadeInSeconds', 'fadeOutSeconds', 'loop'])
  if (typeof a.assetId !== 'string' || !a.assetId) throw badRequest(`"${at}.assetId" must be a non-empty string`)
  if (typeof a.loop !== 'boolean') throw badRequest(`"${at}.loop" must be a boolean`)
  const offsetSeconds = num(a.offsetSeconds, `${at}.offsetSeconds`)
  if (offsetSeconds < 0) throw badRequest(`"${at}.offsetSeconds" must be >= 0 (got ${offsetSeconds})`)
  return {
    assetId: a.assetId,
    volume: ranged(a.volume, `${at}.volume`, 0, 1),
    offsetSeconds,
    fadeInSeconds: ranged(a.fadeInSeconds, `${at}.fadeInSeconds`, 0, 5, ' seconds'),
    fadeOutSeconds: ranged(a.fadeOutSeconds, `${at}.fadeOutSeconds`, 0, 5, ' seconds'),
    loop: a.loop,
  }
}

/**
 * Shape-only parse; whether presetId exists is checked by the route.
 * `shot`, `audio` and `look` are optional: undefined means "keep the stored value" (the route fills it in), null clears it.
 */
export function parseScene(value: unknown): ProjectScene {
  const s = object(value, 'scene', ['presetId', 'placement'], ['shot', 'audio', 'look'])
  if (s.presetId !== null && (typeof s.presetId !== 'string' || !s.presetId)) {
    throw badRequest('"scene.presetId" must be a non-empty string or null')
  }
  const scene: ProjectScene = {
    presetId: s.presetId as string | null,
    placement: s.placement === null ? null : parsePlacement(s.placement, 'scene.placement'),
  }
  if (s.shot !== undefined) scene.shot = s.shot === null ? null : parseShot(s.shot, 'scene.shot')
  if (s.audio !== undefined) scene.audio = s.audio === null ? null : parseAudio(s.audio, 'scene.audio')
  if (s.look !== undefined) scene.look = s.look === null ? null : parseLook(s.look, 'scene.look')
  return scene
}
