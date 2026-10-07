// Shot validation. Mirrors the rules in shared/api.ts (the server checks the same rules separately):
// >= 2 keys, keys strictly increasing in t, first t = 0, last t = durationSeconds, durationSeconds 1–60,
// fov 5–120, every number finite, Vec3s are arrays of 3.

import type { CameraShot } from '../../shared/types'

export const MIN_DURATION_SECONDS = 1
export const MAX_DURATION_SECONDS = 60
export const MIN_FOV = 5
export const MAX_FOV = 120

/** Returns human-readable problems; an empty array means the shot is valid. */
export function validateShot(shot: CameraShot): string[] {
  const problems: string[] = []
  if (!shot || typeof shot !== 'object') return ['Shot is missing']

  const d = shot.durationSeconds
  if (!isNum(d)) problems.push('Duration must be a finite number of seconds')
  else if (d < MIN_DURATION_SECONDS || d > MAX_DURATION_SECONDS) {
    problems.push(`Duration must be between ${MIN_DURATION_SECONDS} and ${MAX_DURATION_SECONDS} seconds (got ${d})`)
  }

  if (!shot.hero || typeof shot.hero !== 'object') problems.push('Hero framing is missing')
  else {
    if (!isVec3(shot.hero.position)) problems.push('Hero position must be 3 finite numbers')
    if (!isVec3(shot.hero.target)) problems.push('Hero target must be 3 finite numbers')
    checkFov(shot.hero.fov, 'Hero', problems)
  }

  if (!Array.isArray(shot.keys)) {
    problems.push('Keys must be a list')
    return problems
  }
  const keys = shot.keys
  if (keys.length < 2) problems.push(`A shot needs at least 2 keys (has ${keys.length})`)

  keys.forEach((k, i) => {
    const label = `Key ${i + 1}`
    if (!k || typeof k !== 'object') {
      problems.push(`${label} is missing`)
      return
    }
    if (!isNum(k.t)) problems.push(`${label} time must be a finite number`)
    if (!isVec3(k.position)) problems.push(`${label} position must be 3 finite numbers`)
    if (!isVec3(k.target)) problems.push(`${label} target must be 3 finite numbers`)
    checkFov(k.fov, label, problems)
    if (k.focusDistance !== undefined && (!isNum(k.focusDistance) || k.focusDistance <= 0)) {
      problems.push(`${label} focus distance must be a finite number above 0`)
    }
  })

  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]?.t
    const b = keys[i]?.t
    // Strictly increasing, matching the server's parseShot rule.
    if (isNum(a) && isNum(b) && b <= a) {
      problems.push(
        b === a
          ? `Keys ${i} and ${i + 1} are both at ${a}s; each key needs its own time`
          : `Keys must be sorted by time (key ${i + 1} at ${b}s comes before key ${i} at ${a}s)`,
      )
    }
  }
  if (keys.length > 0) {
    const first = keys[0]?.t
    if (isNum(first) && first !== 0) problems.push(`First key must be at 0s (is at ${first}s)`)
    const last = keys[keys.length - 1]?.t
    if (isNum(last) && isNum(d) && last !== d) {
      problems.push(`Last key must be at the shot duration, ${d}s (is at ${last}s)`)
    }
  }
  return problems
}

function checkFov(fov: unknown, label: string, problems: string[]) {
  if (!isNum(fov)) problems.push(`${label} field of view must be a finite number`)
  else if (fov < MIN_FOV || fov > MAX_FOV) problems.push(`${label} field of view must be between ${MIN_FOV} and ${MAX_FOV} degrees (got ${fov})`)
}
function isNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}
function isVec3(v: unknown): boolean {
  return Array.isArray(v) && v.length === 3 && v.every(isNum)
}
