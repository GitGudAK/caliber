import type * as THREE from 'three'

/**
 * Render layer the look passes use to draw the watch alone (contact shadow, edge mask)
 * without touching the splat (Spark's material ignores overrideMaterial, so it must be
 * excluded by layer instead). Meshes stay on layer 0 too, so normal rendering is unchanged.
 */
export const WATCH_LAYER = 7

/** Enables WATCH_LAYER on every descendant. Cheap; call per frame (the glTF loads asynchronously). */
export function markWatchLayer(root: THREE.Object3D | null | undefined) {
  root?.traverse((o) => o.layers.enable(WATCH_LAYER))
}

/** True when any mesh under root is visible (used to skip passes while the watch is hidden/loading). */
export function hasVisibleMesh(root: THREE.Object3D | null | undefined): boolean {
  if (!root || !root.visible) return false
  let found = false
  root.traverseVisible((o) => {
    if ((o as THREE.Mesh).isMesh) found = true
  })
  return found
}
