// Camera shots: preset move generation, per-frame sampling, validation and key editing.
// Pure TypeScript; no React, DOM or three.js scene objects.

export {
  buildShot,
  heroFromPlacement,
  dollyTowardTarget,
  rotateAboutY,
  MOVE_DEFAULTS,
  DEFAULT_DURATION_SECONDS,
  DEFAULT_EASING,
  MIN_CAMERA_DISTANCE,
  CRANE_BELOW_TARGET_LIMIT,
  SLIDE_TARGET_FOLLOW,
  FOCUS_PULL_FAR_FACTOR,
  FULL_TURN_DEGREES,
  ORBIT_KEY_STEP_DEGREES,
  FOCUS_PULL_HOLD_FRACTION,
  FOCUS_PULL_MIN_BACKGROUND_FACTOR,
} from './moves'
export type { BuildShotOptions, HeroFrame } from './moves'
export { sampleShot, createSample, ease } from './sample'
export type { CameraSample } from './sample'
export { validateShot, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, MIN_FOV, MAX_FOV } from './validate'
export { retimeShot, setKey, insertKey, removeKey } from './edit'
export type { KeyPose } from './edit'
