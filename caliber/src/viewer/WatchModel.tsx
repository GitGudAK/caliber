import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { preflightAsset } from './preflight'

export interface WatchModelProps {
  url: string
  /** Largest bounding-box dimension after scaling, in meters. Default 0.045 (real watch scale). */
  targetSize?: number
  position?: [number, number, number]
  rotation?: [number, number, number]
  onLoad?: (info: { url: string; sourceSize: THREE.Vector3; scale: number }) => void
  onError?: (error: Error) => void
}

interface Fitted {
  scene: THREE.Object3D
  /** Offset (in source units) that moves the bounding-box center to the origin. */
  offset: THREE.Vector3
  /** Largest source bounding-box dimension; scale = targetSize / maxDim (applied at render so resizing never reloads). */
  maxDim: number
}

/**
 * Loads a .glb and normalizes it: the actual world-space bounding box (including
 * node matrices — Sketchfab exports nest rotated/translated nodes far from the
 * origin) is centered at the origin and uniformly scaled to `targetSize`.
 */
export function WatchModel({
  url,
  targetSize = 0.045,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  onLoad,
  onError,
}: WatchModelProps) {
  const [fitted, setFitted] = useState<Fitted | null>(null)
  const onLoadRef = useRef(onLoad)
  const onErrorRef = useRef(onError)
  onLoadRef.current = onLoad
  onErrorRef.current = onError
  const targetSizeRef = useRef(targetSize)
  targetSizeRef.current = targetSize

  useEffect(() => {
    let cancelled = false
    setFitted(null)
    const fail = (err: unknown) => {
      if (cancelled) return
      const msg = err instanceof Error ? err.message : String(err)
      onErrorRef.current?.(new Error(`Watch model failed to load (${url}): ${msg}`))
    }
    const load = async () => {
      await preflightAsset(url, 'model')
      if (cancelled) return
      const gltf = await new GLTFLoader().loadAsync(url)
      if (cancelled) return
      const scene = gltf.scene
      scene.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(scene, true)
      if (box.isEmpty()) throw new Error('model has no geometry')
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      if (!(maxDim > 0) || !Number.isFinite(maxDim)) throw new Error('model has invalid bounds')
      const offset = box.getCenter(new THREE.Vector3()).negate()
      scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true
          o.receiveShadow = true
        }
      })
      setFitted({ scene, offset, maxDim })
      onLoadRef.current?.({ url, sourceSize: size, scale: targetSizeRef.current / maxDim })
    }
    load().catch(fail)
    return () => {
      cancelled = true
    }
  }, [url])

  // Dispose GPU resources when the loaded scene is replaced/unmounted.
  useEffect(() => {
    if (!fitted) return
    return () => {
      fitted.scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry?.dispose()
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose()
          m.dispose()
        }
      })
    }
  }, [fitted])

  if (!fitted) return null
  return (
    <group position={position} rotation={rotation}>
      <group scale={targetSize / fitted.maxDim}>
        <group position={fitted.offset}>
          <primitive object={fitted.scene} />
        </group>
      </group>
    </group>
  )
}
