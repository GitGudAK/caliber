import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Vec3 } from './panoMath'

export type ToneMappingName = 'neutral' | 'aces' | 'agx' | 'none'

export interface HarmonizeProps {
  /** Watch root whose materials get envMapIntensity / tint. */
  watch: THREE.Object3D | null
  /**
   * Renderer tone mapping. Spark's splat shader has no tone-mapping step (it writes the
   * captured sRGB colors as-is), so only the CG watch is tone mapped. 'neutral' (Khronos PBR
   * Neutral) is ~identity below 0.8, so pano reflections on the watch keep the exact colors
   * the splat shows; ACES (R3F's default) darkens/desaturates them. Default 'neutral'.
   */
  toneMapping?: ToneMappingName
  /** renderer.toneMappingExposure. Default 1. */
  exposure?: number
  /** Per-material envMapIntensity on the watch. Default 1 (IBL radiance == splat radiance). */
  envMapIntensity?: number
  /** Linear RGB white balance (LightEstimate.whiteBalance) to tint the watch's base colors toward. */
  whiteBalance?: Vec3
  /** 0..1 strength of the white-balance tint on base colors. Default 0 (off). */
  tintStrength?: number
}

const TONE: Record<ToneMappingName, THREE.ToneMapping> = {
  neutral: THREE.NeutralToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  none: THREE.NoToneMapping,
}

interface Orig {
  color?: THREE.Color
  envMapIntensity?: number
}

type Mat = THREE.Material & { color?: THREE.Color; envMapIntensity?: number }

/**
 * Tone/color-matches the CG watch to the splat. Renderer-level: tone mapping + exposure
 * (restored on unmount). Material-level (watch only, originals kept in userData and restored):
 * envMapIntensity and an optional subtle base-color tint toward the pano white balance.
 */
export function Harmonize({
  watch,
  toneMapping = 'neutral',
  exposure = 1,
  envMapIntensity = 1,
  whiteBalance,
  tintStrength = 0,
}: HarmonizeProps) {
  const gl = useThree((s) => s.gl)

  useEffect(() => {
    const prev = { tm: gl.toneMapping, ex: gl.toneMappingExposure }
    gl.toneMapping = TONE[toneMapping]
    gl.toneMappingExposure = exposure
    return () => {
      gl.toneMapping = prev.tm
      gl.toneMappingExposure = prev.ex
    }
  }, [gl, toneMapping, exposure])

  // Applied per frame (cheap: a watch has a handful of materials) because the glTF loads
  // asynchronously under the given root.
  const tint = new THREE.Color()
  useFrame(() => {
    if (!watch) return
    if (whiteBalance) {
      const k = Math.max(0, Math.min(1, tintStrength))
      tint.setRGB(1 + (whiteBalance[0] - 1) * k, 1 + (whiteBalance[1] - 1) * k, 1 + (whiteBalance[2] - 1) * k)
    } else tint.setRGB(1, 1, 1)
    watch.traverse((o) => {
      const m = (o as THREE.Mesh).material
      if (!m) return
      for (const mat of (Array.isArray(m) ? m : [m]) as Mat[]) {
        const orig = (mat.userData.__lookOrig ??= {
          color: mat.color?.clone(),
          envMapIntensity: mat.envMapIntensity,
        } as Orig) as Orig
        if (orig.envMapIntensity !== undefined) mat.envMapIntensity = orig.envMapIntensity * envMapIntensity
        if (orig.color && mat.color) mat.color.copy(orig.color).multiply(tint)
      }
    })
  })

  useEffect(
    () => () => {
      watch?.traverse((o) => {
        const m = (o as THREE.Mesh).material
        if (!m) return
        for (const mat of (Array.isArray(m) ? m : [m]) as Mat[]) {
          const orig = mat.userData.__lookOrig as Orig | undefined
          if (!orig) continue
          if (orig.envMapIntensity !== undefined) mat.envMapIntensity = orig.envMapIntensity
          if (orig.color && mat.color) mat.color.copy(orig.color)
          delete mat.userData.__lookOrig
        }
      })
    },
    [watch],
  )

  return null
}
