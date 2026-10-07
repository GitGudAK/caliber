// Depth of field: one circle-of-confusion curve shared by the splats (patched Spark vertex
// shader) and the watch (CPU, treated as a single depth and blurred as one layer).
//
// Curve (port of image-blaster's SplatRenderer patch, made scale-free for macro scenes):
//   depth  = view-space distance along the camera axis (scene meters, after WorldFrame scale)
//   beyond = max(0, |depth - focalDistance| - sharpRange)
//   blur   = beyond / depth                         (thin-lens relative defocus)
//   cocPx  = blur * focalPx * tan(apertureAngle / 2)
// Spark adds cocPx^2 to each splat's 2D covariance, i.e. a Gaussian blur with sigma = cocPx
// pixels; the watch layer gets a separable Gaussian with the same sigma.
//
// Why not image-blaster's exp(beyond * falloffRate) - 1: that curve is in absolute world
// units (sharpRange 2, rate 0.3/unit for a room-scale world). Our worlds are scaled ~0.06,
// so every distance is ~16x smaller and those constants blur nothing. The relative form
// gives the same look at any world scale, which is what a real lens does.

import type { SparkRenderer } from '@sparkjsdev/spark'
import type { ShotDof } from '../../shared/types'

export interface DofSettings {
  enabled: boolean
  /** Lens aperture angle in radians (Spark's apertureAngle). Bigger = shallower focus. */
  apertureAngle: number
  /** Distance either side of the focal plane that stays perfectly sharp (scene meters). */
  sharpRange: number
}

/** Renderer settings from the saved shot DOF (degrees -> radians; no sharp band). */
export function dofFromShot(d: ShotDof): DofSettings {
  return { enabled: d.enabled, apertureAngle: (d.apertureDegrees * Math.PI) / 180, sharpRange: 0 }
}
/** Below this blur (pixels) the watch is drawn in the normal single pass: exact, no softening. */
export const WATCH_SHARP_SIGMA_PX = 0.3
/** Upper bound for the watch blur (Spark clamps splats at maxPixelRadius, far above this). */
export const MAX_WATCH_SIGMA_PX = 64

const ORIGINAL_FOCUS_BLUR = 'float focusBlur = abs((-viewCenter.z - focalDistance) / viewCenter.z);'
const CUSTOM_FOCUS_BLUR = `float dofDepth = -viewCenter.z;
            float dofBeyond = max(0.0, abs(dofDepth - focalDistance) - sharpRange);
            float focusBlur = dofBeyond / dofDepth;`
const APERTURE_DECL = 'uniform float apertureAngle;'
const APERTURE_DECL_PLUS = `uniform float apertureAngle;
uniform float sharpRange;`

/** Patch Spark's splat vertex shader once with the shared CoC curve. Throws if Spark's shader changed. */
export function patchSparkDof(spark: SparkRenderer) {
  const mat = spark.material
  const u = mat.uniforms as Record<string, { value: unknown }>
  if (!u.sharpRange) u.sharpRange = { value: 0 }
  if (mat.vertexShader.includes('uniform float sharpRange;')) return
  if (!mat.vertexShader.includes(ORIGINAL_FOCUS_BLUR) || !mat.vertexShader.includes(APERTURE_DECL)) {
    throw new Error('Spark shader changed: depth-of-field patch could not be applied')
  }
  mat.vertexShader = mat.vertexShader.replace(APERTURE_DECL, APERTURE_DECL_PLUS).replace(ORIGINAL_FOCUS_BLUR, CUSTOM_FOCUS_BLUR)
  mat.needsUpdate = true
}

/** Set Spark's DOF uniforms for this frame; focalDistance <= 0 or disabled turns splat DOF off. */
export function applySparkDof(spark: SparkRenderer, dof: DofSettings, focalDistance: number) {
  const on = dof.enabled && focalDistance > 0 && dof.apertureAngle > 0
  spark.focalDistance = on ? focalDistance : 0
  spark.apertureAngle = on ? dof.apertureAngle : 0
  const u = spark.material.uniforms as Record<string, { value: number }>
  if (u.sharpRange) u.sharpRange.value = dof.sharpRange
}

/** The shared curve. `focalPx` = 0.5 * drawingBufferWidth * projectionMatrix[0][0]. */
export function cocPixels(depth: number, focalDistance: number, dof: DofSettings, focalPx: number): number {
  if (!dof.enabled || !(focalDistance > 0) || !(depth > 0) || !(dof.apertureAngle > 0)) return 0
  const beyond = Math.max(0, Math.abs(depth - focalDistance) - dof.sharpRange)
  return (beyond / depth) * focalPx * Math.tan(0.5 * dof.apertureAngle)
}
