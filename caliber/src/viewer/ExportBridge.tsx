import { useEffect, useRef, type RefObject } from 'react'
import { useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import type { SparkRenderer } from '@sparkjsdev/spark'
import type { CameraShot } from '../../shared/types'
import type { FrameRendererApi } from './FrameRenderer'
import type { RenderHandle } from './renderHandle'
import type { ShotClock } from './shotClock'
import type { ShotRigApi } from './ShotRig'
import { forceResort, settleSort } from './sparkSort'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Builds the RenderHandle (offline export) from inside the Canvas and hands it to the owner. */
export function ExportBridge({
  clock,
  rig,
  frame,
  spark,
  shot,
  exporting,
  onHandle,
}: {
  clock: ShotClock
  rig: RefObject<ShotRigApi | null>
  frame: RefObject<FrameRendererApi | null>
  spark: RefObject<SparkRenderer | null>
  shot: RefObject<CameraShot | null>
  exporting: RefObject<boolean>
  onHandle?: (h: RenderHandle | null) => void
}) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const setFrameloop = useThree((s) => s.setFrameloop)
  const get = useThree((s) => s.get)
  const advance = useThree((s) => s.advance)
  const onHandleRef = useRef(onHandle)
  onHandleRef.current = onHandle

  useEffect(() => {
    let savedDpr: number | null = null
    let savedSortInterval: number | null = null
    const handle: RenderHandle = {
      canvas: gl.domElement,
      async beginExport(width, height) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
          throw new Error(`Export size must be positive integers (got ${width}x${height})`)
        }
        exporting.current = true
        if (spark.current) {
          savedSortInterval = spark.current.minSortIntervalMs
          spark.current.minSortIntervalMs = 0
        }
        setFrameloop('never')
        savedDpr = gl.getPixelRatio()
        gl.setPixelRatio(1)
        gl.setSize(width, height, false)
        camera.aspect = width / height
        camera.zoom = 1 // the export frame is the whole buffer at the shot's vertical fov
        camera.updateProjectionMatrix()
        await sleep(0)
      },
      async renderAt(t) {
        if (!exporting.current) throw new Error('renderAt() called outside beginExport()/endExport()')
        if (!shot.current) throw new Error('No camera shot to render')
        const f = frame.current
        if (!f) throw new Error('Renderer is not ready')
        clock.seek(t)
        // With frameloop 'never' no useFrame runs on its own, so step every per-frame side pass
        // (contact-shadow map, static shadow-map refresh, shot camera) before each render.
        // FrameRenderer's own useFrame is a no-op while exporting; we render explicitly below.
        const step = () => {
          advance(performance.now(), true)
          rig.current?.applyAt(t)
          f.renderNow(t)
        }
        // Re-sort for exactly this camera even if it moved less than Spark's 1 mm threshold.
        forceResort(spark.current)
        step()
        await settleSort(spark.current)
        step()
        await settleSort(spark.current)
        // Final render is synchronous with resolution: the drawing buffer is fresh at capture.
        step()
      },
      endExport() {
        exporting.current = false
        if (spark.current && savedSortInterval !== null) spark.current.minSortIntervalMs = savedSortInterval
        savedSortInterval = null
        clock.stop()
        const { size, viewport } = get()
        gl.setPixelRatio(savedDpr ?? viewport.dpr)
        gl.setSize(size.width, size.height, false)
        camera.aspect = size.width / size.height
        camera.updateProjectionMatrix()
        setFrameloop('always')
      },
    }
    onHandleRef.current?.(handle)
    return () => onHandleRef.current?.(null)
  }, [gl, camera, setFrameloop, get, advance, clock, rig, frame, spark, shot, exporting])

  return null
}
