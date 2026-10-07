import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { extend, useThree } from '@react-three/fiber'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import type * as THREE from 'three'
import { preflightAsset } from './preflight'
import { WorldFrame, type WorldTransform } from './WorldFrame'
import { patchSparkDof } from './dof'

// Approach mirrors image-blaster's SplatRenderer (Spark SparkRenderer + SplatMesh),
// minus its DOF shader patch and debug store.
const SparkRendererEl = extend(SparkRenderer)
const ignoreRaycast: THREE.Object3D['raycast'] = () => {}

export interface SplatWorldProps {
  url: string
  /** World frame (flipY, scale, rotationY, offset). The collider must use the same one. */
  transform: WorldTransform
  onLoad?: (info: { url: string; numSplats: number }) => void
  onError?: (error: Error) => void
  /** Receives the SparkRenderer (DOF-patched) so the frame renderer can drive focus; null on unmount. */
  onSpark?: (spark: SparkRenderer | null) => void
}

function toError(err: unknown, url: string): Error {
  const msg = err instanceof Error ? err.message : String(err)
  return new Error(`Splat failed to load (${url}): ${msg}`)
}

export function SplatWorld({
  url,
  transform,
  onLoad,
  onError,
  onSpark,
}: SplatWorldProps) {
  const gl = useThree((s) => s.gl)
  const sparkArgs = useMemo(() => ({ renderer: gl, enableLod: true }), [gl])
  const [mesh, setMesh] = useState<SplatMesh | null>(null)

  // Keep latest callbacks without re-creating the mesh when they change.
  const onLoadRef = useRef(onLoad)
  const onErrorRef = useRef(onError)
  onLoadRef.current = onLoad
  onErrorRef.current = onError
  const onSparkRef = useRef(onSpark)
  onSparkRef.current = onSpark
  const sparkRef = useCallback((spark: SparkRenderer | null) => {
    if (spark) {
      try {
        patchSparkDof(spark)
      } catch (err) {
        onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
    onSparkRef.current?.(spark)
  }, [])

  // Mesh is created in an effect (not useMemo) so StrictMode's mount/unmount/mount
  // never leaves us rendering a disposed mesh.
  useEffect(() => {
    let cancelled = false
    let splat: SplatMesh | null = null

    const start = async () => {
      await preflightAsset(url, 'splat')
      if (cancelled) return
      splat = new SplatMesh({ url })
      splat.raycast = ignoreRaycast
      setMesh(splat)
      // `initialized` rejects on fetch / decode failure — this is where Spark reports load errors.
      const m = await splat.initialized
      if (!cancelled) onLoadRef.current?.({ url, numSplats: m.numSplats })
    }

    start().catch((err: unknown) => {
      if (!cancelled) onErrorRef.current?.(toError(err, url))
    })

    return () => {
      cancelled = true
      setMesh(null)
      splat?.dispose()
    }
  }, [url])

  return (
    <SparkRendererEl ref={sparkRef} args={[sparkArgs]} raycast={ignoreRaycast}>
      <WorldFrame transform={transform}>{mesh && <primitive object={mesh} />}</WorldFrame>
    </SparkRendererEl>
  )
}
