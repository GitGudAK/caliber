import type { SceneLook, ShotDof } from '../../shared/types'

/** Look used when the scene has none saved. */
export const DEFAULT_LOOK: SceneLook = { shadows: true, shadowOpacity: 1, contact: true, grain: 0.025 }

/** Depth of field used when the shot has none saved (or there is no shot yet). */
export const DEFAULT_SHOT_DOF: ShotDof = { enabled: true, apertureDegrees: 1.1 }
export const MIN_APERTURE_DEGREES = 0.1
export const MAX_APERTURE_DEGREES = 5.7
export const MAX_GRAIN = 0.1
