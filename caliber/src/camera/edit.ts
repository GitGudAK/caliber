// Key editing helpers. All return a new shot (inputs are never mutated) and keep the invariants
// from validateShot: >= 2 keys, sorted by t, first t = 0, last t = durationSeconds.
// Hand edits turn the shot into move 'custom'; retiming keeps the move (keys scale uniformly).
// Invalid edits throw an Error with a readable message instead of silently adjusting.

import type { CameraKey, CameraShot } from '../../shared/types'
import { sampleShot } from './sample'
import { MAX_DURATION_SECONDS, MIN_DURATION_SECONDS } from './validate'

export type KeyPose = Omit<CameraKey, 't'>

function cloneKey(k: CameraKey): CameraKey {
  const c: CameraKey = { t: k.t, position: [...k.position], target: [...k.target], fov: k.fov }
  if (k.focusDistance !== undefined) c.focusDistance = k.focusDistance
  return c
}

function poseKey(t: number, p: KeyPose): CameraKey {
  return cloneKey({ ...p, t })
}

/** Scale every key time to fit `newDuration` seconds (1–60). The last key lands exactly on the new duration. */
export function retimeShot(shot: CameraShot, newDuration: number): CameraShot {
  if (!Number.isFinite(newDuration) || newDuration < MIN_DURATION_SECONDS || newDuration > MAX_DURATION_SECONDS) {
    throw new Error(`Duration must be between ${MIN_DURATION_SECONDS} and ${MAX_DURATION_SECONDS} seconds (got ${newDuration})`)
  }
  const scale = newDuration / shot.durationSeconds
  const last = shot.keys.length - 1
  const keys = shot.keys.map((k, i) => {
    const c = cloneKey(k)
    c.t = i === 0 ? 0 : i === last ? newDuration : k.t * scale
    return c
  })
  return { ...shot, durationSeconds: newDuration, keys }
}

/**
 * Replace the key at `index`. `key.t` is honored for inner keys (must stay strictly between its
 * neighbours); the first and last keys are pinned to 0 and the duration, so their `t` must match.
 */
export function setKey(shot: CameraShot, index: number, key: CameraKey): CameraShot {
  const n = shot.keys.length
  if (!Number.isInteger(index) || index < 0 || index >= n) throw new Error(`No key at index ${index} (shot has ${n} keys)`)
  if (index === 0 && key.t !== 0) throw new Error('The first key must stay at 0s')
  if (index === n - 1 && key.t !== shot.durationSeconds) throw new Error(`The last key must stay at ${shot.durationSeconds}s`)
  if (index > 0 && index < n - 1) {
    const lo = shot.keys[index - 1].t
    const hi = shot.keys[index + 1].t
    if (!(key.t > lo && key.t < hi)) throw new Error(`Key ${index + 1} must stay between ${lo}s and ${hi}s (got ${key.t}s)`)
  }
  const keys = shot.keys.map(cloneKey)
  keys[index] = cloneKey(key)
  return { ...shot, move: 'custom', keys }
}

/**
 * Insert a key at time `t` (strictly inside the shot, not on an existing key time).
 * `key` defaults to the pose the shot currently shows at that time, i.e. sampleShot(shot, t).
 */
export function insertKey(shot: CameraShot, t: number, key?: KeyPose): CameraShot {
  if (!Number.isFinite(t) || t <= 0 || t >= shot.durationSeconds) {
    throw new Error(`New keys must be strictly between 0s and ${shot.durationSeconds}s (got ${t}s)`)
  }
  if (shot.keys.some((k) => k.t === t)) throw new Error(`There is already a key at ${t}s`)
  let pose: KeyPose
  if (key) pose = key
  else {
    const s = sampleShot(shot, t)
    pose = { position: s.position, target: s.target, fov: s.fov }
  }
  const keys = shot.keys.map(cloneKey)
  let at = keys.findIndex((k) => k.t > t)
  if (at < 0) at = keys.length
  keys.splice(at, 0, poseKey(t, pose))
  return { ...shot, move: 'custom', keys }
}

/** Remove an inner key. The first and last keys cannot be removed, and a shot keeps at least 2 keys. */
export function removeKey(shot: CameraShot, index: number): CameraShot {
  const n = shot.keys.length
  if (!Number.isInteger(index) || index < 0 || index >= n) throw new Error(`No key at index ${index} (shot has ${n} keys)`)
  if (n <= 2) throw new Error('A shot needs at least 2 keys')
  if (index === 0 || index === n - 1) throw new Error('The first and last keys cannot be removed')
  const keys = shot.keys.filter((_, i) => i !== index).map(cloneKey)
  return { ...shot, move: 'custom', keys }
}
