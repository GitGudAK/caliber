import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { preflightAsset } from './preflight'

export interface ColliderMeshProps {
  url: string
  /** Called with the loaded (invisible) collider root, or null when it unloads. */
  onReady?: (root: THREE.Object3D | null) => void
  onError?: (error: Error) => void
}

/**
 * World Labs collider mesh. Never rendered (visible=false); only used for raycasts
 * (three's Raycaster ignores `visible`). Must be placed inside the same WorldFrame as
 * the splat so the two stay aligned.
 */
export function ColliderMesh({ url, onReady, onError }: ColliderMeshProps) {
  const [root, setRoot] = useState<THREE.Object3D | null>(null)
  const onReadyRef = useRef(onReady)
  const onErrorRef = useRef(onError)
  onReadyRef.current = onReady
  onErrorRef.current = onError

  useEffect(() => {
    let cancelled = false
    let loaded: THREE.Object3D | null = null
    const load = async () => {
      await preflightAsset(url, 'collider')
      if (cancelled) return
      const gltf = await new GLTFLoader().loadAsync(url)
      if (cancelled) return
      loaded = gltf.scene
      let meshes = 0
      loaded.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        meshes++
        // Collider winding is not guaranteed; hit both sides.
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) m.side = THREE.DoubleSide
      })
      if (meshes === 0) throw new Error('collider has no meshes')
      loaded.visible = false
      setRoot(loaded)
      onReadyRef.current?.(loaded)
    }
    load().catch((err: unknown) => {
      if (cancelled) return
      const msg = err instanceof Error ? err.message : String(err)
      onErrorRef.current?.(new Error(`Collider failed to load (${url}): ${msg}`))
    })
    return () => {
      cancelled = true
      setRoot(null)
      onReadyRef.current?.(null)
      loaded?.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry?.dispose()
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) m.dispose()
      })
    }
  }, [url])

  return root ? <primitive object={root} /> : null
}
