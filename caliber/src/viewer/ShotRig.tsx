import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { CameraShot, Placement } from '../../shared/types'
import { createSample, sampleShot } from '../camera'
import type { ShotClock } from './shotClock'

export type CameraView = Placement['camera']

export interface ShotRigApi {
  /** The user's free (orbit) view. While previewing, the view saved when preview started. */
  freeView: () => CameraView | null
  /** What the camera shows right now (the sampled pose while previewing). */
  currentView: () => CameraView | null
  /** Put the free camera at a pose (orbit target included). Only meaningful when not previewing. */
  setFreeView: (v: CameraView) => void
  /** Apply the shot at time t to the camera immediately (deterministic; no clock involved). */
  applyAt: (t: number) => void
  /** Focus distance of the last applied shot sample (meters from the camera), or null when not previewing. */
  shotFocus: () => number | null
}

const round = (v: number) => Math.round(v * 1e6) / 1e6

/**
 * Drives the camera from a CameraShot while the clock is previewing:
 * - on preview start: saves the free view and disables OrbitControls;
 * - each frame: advances the clock if playing and applies sampleShot(t);
 * - seek()/setTime while paused applies synchronously (deterministic export path);
 * - on stop: re-enables OrbitControls and restores the saved free view (unless told not to).
 */
export function ShotRig({ shot, clock, apiRef }: { shot: CameraShot | null; clock: ShotClock; apiRef: Ref<ShotRigApi> }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null
  const saved = useRef<CameraView | null>(null)
  const lastTarget = useRef<[number, number, number] | null>(null)
  const lastFocus = useRef<number | null>(null)
  const sample = useMemo(createSample, [])
  const shotRef = useRef(shot)
  shotRef.current = shot

  const { api, readFree, writeFree } = useMemo(() => {
    const readFree = (): CameraView | null =>
      controls
        ? {
            position: [round(camera.position.x), round(camera.position.y), round(camera.position.z)],
            target: [round(controls.target.x), round(controls.target.y), round(controls.target.z)],
            fov: round(camera.fov),
          }
        : null
    const writeFree = (v: CameraView) => {
      camera.position.set(...v.position)
      camera.fov = v.fov
      camera.updateProjectionMatrix()
      if (controls) {
        controls.target.set(...v.target)
        controls.update()
      } else camera.lookAt(...v.target)
    }
    const applyAt = (t: number) => {
      const s = shotRef.current
      if (!s || s.keys.length === 0) return
      sampleShot(s, t, sample)
      camera.position.set(...sample.position)
      camera.fov = sample.fov
      camera.updateProjectionMatrix()
      camera.lookAt(...sample.target)
      camera.updateMatrixWorld()
      lastTarget.current = [...sample.target]
      lastFocus.current = sample.focusDistance
    }
    const api: ShotRigApi = {
      freeView: () => (clock.get().previewing ? saved.current : readFree()),
      currentView: () => {
        if (!clock.get().previewing) return readFree()
        if (!lastTarget.current) return null
        return {
          position: [round(camera.position.x), round(camera.position.y), round(camera.position.z)],
          target: lastTarget.current.map(round) as CameraView['target'],
          fov: round(camera.fov),
        }
      },
      setFreeView: (v) => {
        if (!clock.get().previewing) writeFree(v)
      },
      applyAt,
      shotFocus: () => (clock.get().previewing ? lastFocus.current : null),
    }
    return { api, readFree, writeFree }
  }, [camera, controls, clock, sample])

  useImperativeHandle(apiRef, () => api, [api])

  // Enter / leave preview, and apply seeks synchronously.
  useEffect(() => {
    const sync = () => {
      const st = clock.get()
      if (st.previewing && !saved.current) {
        saved.current = readFree()
        if (controls) controls.enabled = false
      } else if (!st.previewing && saved.current) {
        if (controls) controls.enabled = true
        if (clock.restoreOnStop()) writeFree(saved.current)
        saved.current = null
        lastTarget.current = null
        lastFocus.current = null
      }
      if (st.previewing && !st.playing) api.applyAt(st.time)
    }
    sync()
    return clock.subscribe(sync)
  }, [api, readFree, writeFree, clock, controls])

  // A shot edit while paused in preview re-renders the pose; a removed shot ends preview.
  useEffect(() => {
    const st = clock.get()
    if (!shot) {
      if (st.previewing) clock.stop()
      return
    }
    if (st.previewing && !st.playing) api.applyAt(st.time)
  }, [shot, api, clock])

  useFrame((_, delta) => {
    const st = clock.get()
    const s = shotRef.current
    if (!st.previewing || !s) return
    // Cap dt so a stalled frame (tab switch, splat upload) doesn't skip most of the move.
    if (st.playing) clock.advance(Math.min(delta, 0.1), s.durationSeconds)
    api.applyAt(clock.get().time)
  })

  return null
}
