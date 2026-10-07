import { useEffect, useLayoutEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { LightEstimate } from './estimateLight'
import type { Vec3 } from './panoMath'

export type ShadowType = 'pcf' | 'pcfsoft' | 'vsm'

export interface SceneLightRigProps {
  /** From estimateLightFromPano. null -> renders nothing (no fake default light). */
  estimate: LightEstimate | null
  /** World position the key light aims at and the shadow frustum is centered on (the watch). */
  placementWatchPosition: Vec3
  /** Key light casts shadows. Default true. */
  shadow?: boolean
  /** Edge length (m) of the cube the shadow camera covers around the watch. Default 0.15. */
  shadowBox?: number
  /** Default 2048. */
  mapSize?: number
  /**
   * Default 'vsm': smooth wide penumbra (light through sheer curtains is soft; verified on the desk
   * preset). 'pcf' honors shadowRadius but bands at large radii; PCFSoft has fixed softness.
   */
  shadowType?: ShadowType
  /** Blur radius in shadow-map texels. Default 24 for VSM (6 is a good PCF value). */
  shadowRadius?: number
  /** Default -0.00005 (depth units of the 0.3 m-deep ortho shadow camera). */
  shadowBias?: number
  /** Default 0.0002 m (0.2 mm) — keeps 4 cm geometry free of acne without peter-panning. */
  normalBias?: number
  /** Multiplies the estimate's key intensity. Default 1. */
  keyScale?: number
  /** Hemisphere fill from the ambient estimate. Default true. */
  fill?: boolean
  /** Multiplies the estimate's ambient intensity. Default 0.35 (the pano IBL already provides most fill). */
  fillScale?: number
  /**
   * Turns on renderer.shadowMap (and sets its type) while mounted, recompiling materials.
   * Default true. Set false if the Canvas already has `shadows`.
   */
  manageRenderer?: boolean
  /**
   * The watch root. When given, the shadow map is re-rendered only when the watch moves, loads,
   * or the light changes (renderer.shadowMap.autoUpdate = false while mounted) — saves ~6 ms/frame
   * here, and keeps the shadow while FrameRenderer hides the watch for its DOF blur pass.
   */
  watch?: THREE.Object3D | null
}

const SHADOW_TYPES: Record<ShadowType, THREE.ShadowMapType> = {
  pcf: THREE.PCFShadowMap,
  pcfsoft: THREE.PCFSoftShadowMap,
  vsm: THREE.VSMShadowMap,
}

function recompileAll(scene: THREE.Scene) {
  scene.traverse((o) => {
    const m = (o as THREE.Mesh).material
    if (!m) return
    for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true
  })
}

/**
 * Key directional light from the pano estimate (shadow frustum fitted tightly around the watch so
 * the 2048 map gives ~0.07 mm texels) + optional hemisphere fill from the ambient estimate.
 * Only CG objects are lit; the splat is unaffected.
 */
export function SceneLightRig({
  estimate,
  placementWatchPosition,
  shadow = true,
  shadowBox = 0.15,
  mapSize = 2048,
  shadowType = 'vsm',
  shadowRadius = 24,
  shadowBias = -0.00005,
  normalBias = 0.0002,
  keyScale = 1,
  fill = true,
  fillScale = 0.35,
  manageRenderer = true,
  watch = null,
}: SceneLightRigProps) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const key = useMemo(() => {
    const l = new THREE.DirectionalLight()
    l.name = 'look-key'
    return l
  }, [])
  const hemi = useMemo(() => new THREE.HemisphereLight(), [])

  useEffect(() => {
    if (!manageRenderer || !shadow) return
    const prev = { enabled: gl.shadowMap.enabled, type: gl.shadowMap.type }
    gl.shadowMap.enabled = true
    gl.shadowMap.type = SHADOW_TYPES[shadowType]
    gl.shadowMap.needsUpdate = true
    recompileAll(scene)
    return () => {
      gl.shadowMap.enabled = prev.enabled
      gl.shadowMap.type = prev.type
      recompileAll(scene)
    }
  }, [gl, scene, shadow, shadowType, manageRenderer])

  useLayoutEffect(() => {
    if (!estimate) return
    const [tx, ty, tz] = placementWatchPosition
    const d = new THREE.Vector3(...estimate.direction).normalize()
    const dist = shadowBox * 2
    key.position.set(tx, ty, tz).addScaledVector(d, dist)
    key.target.position.set(tx, ty, tz)
    key.target.updateMatrixWorld()
    key.color.setRGB(...estimate.color, THREE.LinearSRGBColorSpace)
    key.intensity = estimate.intensity * keyScale
    key.castShadow = shadow
    const cam = key.shadow.camera
    const h = shadowBox / 2
    cam.left = -h
    cam.right = h
    cam.top = h
    cam.bottom = -h
    cam.near = Math.max(0.001, dist - shadowBox)
    // Low sun -> long shadows: receivers far down the light ray are deeper in light space.
    const elev = Math.max(0.05, Math.asin(Math.min(1, Math.abs(d.y))))
    cam.far = dist + shadowBox / 2 + Math.min(2, (shadowBox / 2) / Math.tan(elev) + shadowBox)
    cam.updateProjectionMatrix()
    if (key.shadow.mapSize.x !== mapSize) {
      key.shadow.mapSize.set(mapSize, mapSize)
      key.shadow.map?.dispose()
      key.shadow.map = null
    }
    key.shadow.bias = shadowBias
    key.shadow.normalBias = normalBias
    key.shadow.radius = shadowRadius
    key.shadow.blurSamples = 16
    key.shadow.needsUpdate = true

    hemi.color.setRGB(...estimate.ambientColor, THREE.LinearSRGBColorSpace)
    hemi.groundColor.setRGB(...estimate.groundColor, THREE.LinearSRGBColorSpace)
    hemi.intensity = estimate.ambientIntensity * fillScale
  }, [estimate, placementWatchPosition, shadow, shadowBox, mapSize, shadowBias, normalBias, shadowRadius, keyScale, fillScale, key, hemi])

  useEffect(() => () => key.shadow.map?.dispose(), [key])

  // Static shadows: re-render the shadow map only when something that casts it changes.
  const sig = useMemo(() => ({ last: '' }), [])
  useEffect(() => {
    if (!watch || !shadow) return
    const prev = gl.shadowMap.autoUpdate
    gl.shadowMap.autoUpdate = false
    gl.shadowMap.needsUpdate = true
    sig.last = ''
    return () => {
      gl.shadowMap.autoUpdate = prev
    }
  }, [gl, watch, shadow, sig])
  useFrame(() => {
    if (!watch || !shadow) return
    watch.updateWorldMatrix(true, true)
    let meshes = 0
    watch.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++
    })
    const e = watch.matrixWorld.elements
    const next = `${meshes}|${e.map((v) => v.toFixed(6)).join(',')}|${key.position.toArray().join(',')}|${key.shadow.mapSize.x}|${gl.shadowMap.type}`
    if (next !== sig.last) {
      sig.last = next
      gl.shadowMap.needsUpdate = true
    }
  })

  if (!estimate) return null
  return (
    <>
      <primitive object={key} />
      <primitive object={key.target} />
      {fill && <primitive object={hemi} />}
    </>
  )
}
