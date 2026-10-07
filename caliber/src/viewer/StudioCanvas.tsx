import { Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type Ref } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, TransformControls } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { CameraShot, Placement, SceneLook, Vec3 } from '../../shared/types'
import { ColliderMesh } from './ColliderMesh'
import { EquirectEnvironment } from './EquirectEnvironment'
import { PlacementToolbar, type GizmoMode } from './PlacementToolbar'
import { ShotPanel } from './ShotPanel'
import { ExportBridge } from './ExportBridge'
import { FrameRenderer, type FrameRendererApi } from './FrameRenderer'
import { dofFromShot } from './dof'
import { environmentEuler, fitPlane, levelRotation, worldRotationMatrix, type PlaneFit } from './level'
import type { RenderHandle } from './renderHandle'
import { DEFAULT_LOOK, DEFAULT_SHOT_DOF } from './look'
import {
  FinishPass,
  Harmonize,
  SceneLightRig,
  ShadowCatcher,
  estimateLightFromUrl,
  panoRotationY,
  shadowTintFromEstimate,
  type FinishPassApi,
  type LightEstimate,
} from '../look'
import type { SparkRenderer } from '@sparkjsdev/spark'
import { ShotRig, type ShotRigApi } from './ShotRig'
import { createShotClock } from './shotClock'
import { SplatWorld } from './SplatWorld'
import { WatchModel, type WatchModelProps } from './WatchModel'
import { WorldFrame } from './WorldFrame'
import { ViewerErrorBoundary, ViewerErrorOverlay, type ViewerErrorItem } from './ViewerErrorBoundary'

export interface SplatSemantics {
  flipY?: boolean
  groundPlaneOffset?: number
  metricScaleFactor?: number
}

export type ViewerErrorSource = 'splat' | 'watch' | 'renderer' | 'environment' | 'collider' | 'light'

export interface StudioCanvasProps {
  splatUrl?: string
  watchUrl?: string
  /** Equirectangular image (e.g. the World Labs pano) used only for reflections/IBL, never as background. */
  environmentUrl?: string
  environmentIntensity?: number
  /** World Labs collider mesh (.glb). Invisible; used only for "Drop to surface" raycasts. */
  colliderUrl?: string

  /**
   * World + watch + camera placement. When given it drives the world transform, the
   * watch transform and the camera (and the legacy props below are ignored).
   */
  placement?: Placement
  /** Called on gizmo drag end, toolbar actions, slider settle, and orbit end (debounced 300ms). */
  onPlacementChange?: (p: Placement) => void
  /** Shows the placement gizmo + toolbar. */
  editable?: boolean
  /** Reset button in the toolbar; disabled when not provided. */
  onResetPlacement?: () => void

  /** Camera move for the video. Previewing it drives the camera and disables orbit. */
  shot?: CameraShot | null
  /** When provided, the ShotPanel is shown along the bottom of the canvas. Slider edits are debounced 300ms. */
  onShotChange?: (shot: CameraShot | null) => void
  /** Imperative playback control (e.g. the exporter stepping frames). */
  ref?: Ref<StudioCanvasHandle>
  /** Saved look (shadows, contact, grain). Absent/null = DEFAULT_LOOK. Slider edits are debounced 300ms. */
  look?: SceneLook | null
  onLookChange?: (look: SceneLook) => void
  /** Offline-render hook for MP4 export; called with null on unmount. */
  onRenderHandle?: (handle: RenderHandle | null) => void
  /**
   * Export frame aspect (width / height). When set, a crop guide dims everything outside the
   * export frame; the guide shows exactly what the export camera sees (same vertical fov).
   */
  frameAspect?: number | null

  // ---- Legacy props (used only when `placement` is not given; the sandbox's query-param path) ----
  /** World Labs semantics_metadata for the splat (flip_y, ground_plane_offset, metric_scale_factor). */
  splatSemantics?: SplatSemantics
  /** Largest watch dimension in meters. */
  watchSize?: number
  watchPosition?: Vec3
  watchRotation?: Vec3
  /** Initial camera position (meters). Defaults to ~18cm in front of the watch. */
  cameraPosition?: Vec3

  className?: string
  onSplatLoad?: (info: { url: string; numSplats: number }) => void
  onWatchLoad?: NonNullable<WatchModelProps['onLoad']>
  onError?: (source: ViewerErrorSource, error: Error) => void
}

export interface StudioCanvasHandle {
  /**
   * Preview the shot at exactly `t` seconds (paused). The camera pose is applied synchronously,
   * so the next rendered frame shows it; deterministic for a given shot and t.
   */
  setShotTime: (t: number) => void
  getShotTime: () => number
  /** What the camera shows now (sampled pose while previewing, else the orbit view). */
  getCameraPose: () => { position: Vec3; target: Vec3; fov: number } | null
  /** True while the preview clock is running (playing, not paused/stopped). */
  isShotPlaying: () => boolean
  /**
   * Called on play, pause, stop and seek (not on every playing frame) with the playhead time
   * and whether it is playing. Returns an unsubscribe function.
   */
  subscribeShotClock: (cb: (t: number, playing: boolean) => void) => () => void
  /** Focus distance and watch blur used for the last rendered frame. */
  getFrameStats: () => { focus: number; watchSigma: number } | null
  playShot: () => void
  pauseShot: () => void
  /** Leave preview and return to the user's last free (orbit) view. */
  stopShot: () => void
}

// Camera framing for a ~4.5cm object inside a room-scale world:
// near 1mm keeps the watch from clipping at close orbit; far 1km covers any World Labs scene.
const DEFAULT_CAMERA_POSITION: Vec3 = [0, 0.03, 0.18]
const DEFAULT_FOV = 35
const CAMERA = { near: 0.001, far: 1000 }
const DEBOUNCE_MS = 300

type CameraView = Placement['camera']

const round = (v: number) => Math.round(v * 1e6) / 1e6
const vec3 = (v: THREE.Vector3 | THREE.Euler): Vec3 => [round(v.x), round(v.y), round(v.z)]

/** Legacy props -> Placement. Legacy order (T * Rx * S) equals Placement order for uniform scale. */
function placementFromLegacy(p: StudioCanvasProps): Placement {
  const watchPosition = p.watchPosition ?? [0, 0, 0]
  return {
    worldScale: p.splatSemantics?.metricScaleFactor ?? 1,
    worldOffset: [0, p.splatSemantics?.groundPlaneOffset ?? 0, 0],
    worldRotationY: 0,
    flipY: p.splatSemantics?.flipY ?? true,
    watch: { position: watchPosition, rotation: p.watchRotation ?? [0, 0, 0], size: p.watchSize ?? 0.045 },
    camera: { position: p.cameraPosition ?? DEFAULT_CAMERA_POSITION, target: watchPosition, fov: DEFAULT_FOV },
  }
}

/**
 * Applies the placement camera when it changes from outside, and reports user orbit
 * changes (debounced, damping tail included) without re-applying what it reported.
 */
function CameraRig({ view, onCommit }: { view: CameraView; onCommit: (v: CameraView) => void }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null
  const lastKey = useRef('')
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const key = JSON.stringify(view)

  useEffect(() => {
    if (!controls || key === lastKey.current) return
    lastKey.current = key
    const v = JSON.parse(key) as CameraView
    camera.position.set(...v.position)
    camera.fov = v.fov
    camera.updateProjectionMatrix()
    controls.target.set(...v.target)
    controls.update()
  }, [key, camera, controls])

  useEffect(() => {
    if (!controls) return
    let pending = false
    let dragging = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const report = () => {
      if (!dragging) pending = false
      const v: CameraView = { position: vec3(camera.position), target: vec3(controls.target), fov: round(camera.fov) }
      const k = JSON.stringify(v)
      // A gizmo drag also emits orbit start/end (orbit is disabled mid-drag); skip unchanged views.
      if (k === lastKey.current) return
      lastKey.current = k
      onCommitRef.current(v)
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(report, DEBOUNCE_MS)
    }
    const onStart = () => {
      pending = true
      dragging = true
    }
    const onChange = () => {
      if (pending) schedule()
    }
    const onEnd = () => {
      dragging = false
      if (pending) schedule()
    }
    controls.addEventListener('start', onStart)
    controls.addEventListener('change', onChange)
    controls.addEventListener('end', onEnd)
    return () => {
      clearTimeout(timer)
      controls.removeEventListener('start', onStart)
      controls.removeEventListener('change', onChange)
      controls.removeEventListener('end', onEnd)
    }
  }, [camera, controls])

  return null
}

type ColliderState = 'none' | 'loading' | 'ready' | 'error'

export function StudioCanvas(props: StudioCanvasProps) {
  const {
    splatUrl,
    watchUrl,
    environmentUrl,
    environmentIntensity = 1,
    colliderUrl,
    placement,
    onPlacementChange,
    editable = false,
    onResetPlacement,
    className,
    onSplatLoad,
    onWatchLoad,
    onError,
    shot,
    onShotChange,
    ref,
    onRenderHandle,
    frameAspect = null,
    look: lookProp,
    onLookChange,
  } = props

  // ---------------------------------------------------------------- errors
  const [errors, setErrors] = useState<Record<string, string>>({})
  const report = useCallback(
    (source: ViewerErrorSource, error: Error) => {
      console.error(`[viewer:${source}]`, error)
      setErrors((prev) => ({ ...prev, [source]: error.message }))
      onError?.(source, error)
    },
    [onError],
  )
  const clear = useCallback((source: string) => {
    setErrors((prev) => {
      if (!(source in prev)) return prev
      const next = { ...prev }
      delete next[source]
      return next
    })
  }, [])
  useEffect(() => clear('splat'), [splatUrl, clear])
  useEffect(() => clear('watch'), [watchUrl, clear])
  useEffect(() => clear('environment'), [environmentUrl, clear])
  useEffect(() => clear('collider'), [colliderUrl, clear])
  useEffect(() => clear('light'), [environmentUrl, clear])
  const errorItems: ViewerErrorItem[] = Object.entries(errors).map(([source, message]) => ({ source, message }))

  // ---------------------------------------------------------------- placement state
  const effectiveKey = JSON.stringify(placement ?? placementFromLegacy(props))
  const [current, setCurrent] = useState<Placement>(() => JSON.parse(effectiveKey) as Placement)
  const currentRef = useRef(current)
  currentRef.current = current
  useEffect(() => setCurrent(JSON.parse(effectiveKey) as Placement), [effectiveKey])

  const onChangeRef = useRef(onPlacementChange)
  onChangeRef.current = onPlacementChange
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(debounceTimer.current), [])

  /** Update local state and report now. */
  const commit = useCallback((next: Placement) => {
    clearTimeout(debounceTimer.current)
    currentRef.current = next
    setCurrent(next)
    onChangeRef.current?.(next)
  }, [])
  /** Update local state now, report once the value settles (sliders). */
  const commitSettled = useCallback((next: Placement) => {
    currentRef.current = next
    setCurrent(next)
    clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => onChangeRef.current?.(currentRef.current), DEBOUNCE_MS)
  }, [])

  // ---------------------------------------------------------------- shot state
  const shotKey = JSON.stringify(shot ?? null)
  const [currentShot, setCurrentShot] = useState<CameraShot | null>(() => JSON.parse(shotKey) as CameraShot | null)
  const currentShotRef = useRef(currentShot)
  currentShotRef.current = currentShot
  useEffect(() => setCurrentShot(JSON.parse(shotKey) as CameraShot | null), [shotKey])
  const onShotChangeRef = useRef(onShotChange)
  onShotChangeRef.current = onShotChange
  const shotTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(shotTimer.current), [])
  const commitShot = useCallback((next: CameraShot | null, settle?: boolean) => {
    currentShotRef.current = next
    setCurrentShot(next)
    clearTimeout(shotTimer.current)
    if (settle) shotTimer.current = setTimeout(() => onShotChangeRef.current?.(currentShotRef.current), DEBOUNCE_MS)
    else onShotChangeRef.current?.(next)
  }, [])

  // ---------------------------------------------------------------- rendering (DOF, export)
  // DOF lives on the shot (DEFAULT_SHOT_DOF until there is one).
  const dof = useMemo(() => dofFromShot(currentShot?.dof ?? DEFAULT_SHOT_DOF), [currentShot?.dof])

  // Look: controlled by `look`, local copy for immediate feedback, reports debounced.
  const lookKey = JSON.stringify(lookProp ?? DEFAULT_LOOK)
  const [look, setLookState] = useState<SceneLook>(() => JSON.parse(lookKey) as SceneLook)
  useEffect(() => setLookState(JSON.parse(lookKey) as SceneLook), [lookKey])
  const onLookChangeRef = useRef(onLookChange)
  onLookChangeRef.current = onLookChange
  const lookTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(lookTimer.current), [])
  const setLook = useCallback((next: SceneLook) => {
    setLookState(next)
    clearTimeout(lookTimer.current)
    lookTimer.current = setTimeout(() => onLookChangeRef.current?.(next), DEBOUNCE_MS)
  }, [])
  const finishApi = useRef<FinishPassApi | null>(null)
  const finishBlurredApi = useRef<FinishPassApi | null>(null)

  // ---------------------------------------------------------------- pano lighting
  // The pano is rotated to line up with the splat; the light estimate uses the same rotation.
  // Base pano rotation for this flipY convention; the world rotation (incl. levelling tilt) is
  // applied on top as a full rotation so reflections and the light follow the tilted splat.
  const envBaseY = panoRotationY({ flipY: current.flipY })
  const wx = current.worldRotationX ?? 0
  const wy = current.worldRotationY
  const wz = current.worldRotationZ ?? 0
  const envRotation = useMemo<[number, number, number]>(() => {
    const e = environmentEuler({ worldRotationX: wx, worldRotationY: wy, worldRotationZ: wz }, envBaseY)
    return [e.x, e.y, e.z]
  }, [wx, wy, wz, envBaseY])
  // Estimated once per pano in the raw pano frame, then rotated into the (possibly tilted) world.
  const [rawEstimate, setRawEstimate] = useState<LightEstimate | null>(null)
  useEffect(() => {
    setRawEstimate(null)
    if (!environmentUrl) return
    let cancelled = false
    estimateLightFromUrl(environmentUrl, { rotationY: 0 }).then(
      (est) => {
        if (!cancelled) setRawEstimate(est)
      },
      (err: unknown) => {
        if (!cancelled) report('light', err instanceof Error ? err : new Error(String(err)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [environmentUrl, report])
  const estimate = useMemo<LightEstimate | null>(() => {
    if (!rawEstimate) return null
    const r = worldRotationMatrix({ worldRotationX: wx, worldRotationY: wy, worldRotationZ: wz }).multiply(
      new THREE.Matrix4().makeRotationY(envBaseY),
    )
    const d = new THREE.Vector3(...rawEstimate.panoDirection).applyMatrix4(r).normalize()
    return { ...rawEstimate, direction: [d.x, d.y, d.z] }
  }, [rawEstimate, wx, wy, wz, envBaseY])
  const shadowTint = useMemo(() => (estimate ? shadowTintFromEstimate(estimate) : undefined), [estimate])

  const dofRef = useRef(dof)
  dofRef.current = dof
  const sparkRef = useRef<SparkRenderer | null>(null)
  const frameApi = useRef<FrameRendererApi | null>(null)
  const exportingRef = useRef(false)

  const [clock] = useState(createShotClock)
  const previewing = useSyncExternalStore(clock.subscribe, () => clock.get().previewing)
  const rigApi = useRef<ShotRigApi | null>(null)
  const getRig = useCallback(() => rigApi.current, [])
  const isPlaying = useCallback(() => clock.get().playing, [clock])
  useImperativeHandle(
    ref,
    () => ({
      setShotTime: (t) => {
        clock.seek(t)
        // The rig applies seeks synchronously; apply again in case it is not subscribed yet.
        rigApi.current?.applyAt(t)
      },
      getShotTime: () => clock.get().time,
      getCameraPose: () => rigApi.current?.currentView() ?? null,
      getFrameStats: () => frameApi.current?.lastStats() ?? null,
      isShotPlaying: () => clock.get().playing,
      subscribeShotClock: (cb) => {
        let last = clock.get()
        return clock.subscribe(() => {
          const st = clock.get()
          const transport = st.playing !== last.playing || st.previewing !== last.previewing
          const seek = !st.playing && st.time !== last.time
          last = st
          if (transport || seek) cb(st.time, st.playing)
        })
      },
      playShot: () => {
        const s = currentShotRef.current
        if (s) clock.play(s.durationSeconds)
      },
      pauseShot: () => clock.pause(),
      stopShot: () => clock.stop(),
    }),
    [clock],
  )

  // ---------------------------------------------------------------- scene objects
  const [watchGroup, setWatchGroup] = useState<THREE.Group | null>(null)
  const [watchLoaded, setWatchLoaded] = useState(false)
  const [catcher, setCatcher] = useState<THREE.Group | null>(null)
  useEffect(() => setWatchLoaded(false), [watchUrl])
  // Resting point for the shadow catcher: the watch's lowest world-space point under its center.
  const [watchMinY, setWatchMinY] = useState<number | null>(null)
  const watchKey = JSON.stringify(current.watch)
  useEffect(() => {
    if (!watchGroup || !watchLoaded) {
      setWatchMinY(null)
      return
    }
    watchGroup.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(watchGroup, true)
    setWatchMinY(box.isEmpty() ? null : box.min.y)
  }, [watchGroup, watchLoaded, watchKey])
  const colliderRoot = useRef<THREE.Object3D | null>(null)
  const [colliderState, setColliderState] = useState<ColliderState>(colliderUrl ? 'loading' : 'none')
  useEffect(() => setColliderState(colliderUrl ? 'loading' : 'none'), [colliderUrl])

  // ---------------------------------------------------------------- editing
  const [mode, setMode] = useState<GizmoMode>('translate')
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!editable) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      if (e.key === 'w' || e.key === 'W') setMode('translate')
      else if (e.key === 'e' || e.key === 'E') setMode('rotate')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editable])

  const commitWatchFromGizmo = useCallback(() => {
    if (!watchGroup) return
    const p = currentRef.current
    const position = vec3(watchGroup.position)
    const rotation = vec3(watchGroup.rotation)
    // Skip no-op releases (a click on the gizmo, or a duplicate mouseUp event).
    if (JSON.stringify([position, rotation]) === JSON.stringify([p.watch.position, p.watch.rotation])) return
    commit({ ...p, watch: { ...p.watch, position, rotation } })
    setMessage(null)
  }, [watchGroup, commit])

  const dropUnavailable =
    colliderState === 'none'
      ? 'Drop unavailable: this world has no collider mesh.'
      : colliderState === 'loading'
        ? 'Drop unavailable until the collider finishes loading…'
        : colliderState === 'error'
          ? 'Drop unavailable: the collider failed to load, so there is no surface to raycast against.'
          : undefined

  const dropToSurface = useCallback(() => {
    const collider = colliderRoot.current
    if (!collider || colliderState !== 'ready') return
    if (!watchGroup || !watchLoaded) {
      setMessage({ tone: 'error', text: 'The watch has not loaded yet.' })
      return
    }
    watchGroup.updateWorldMatrix(true, true)
    collider.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(watchGroup, true)
    const center = box.getCenter(new THREE.Vector3())
    const height = box.max.y - box.min.y
    // Start just above the watch so a ceiling above it is never the hit.
    const origin = new THREE.Vector3(center.x, box.max.y + Math.max(height, 0.005), center.z)
    const ray = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0))
    const hit = ray.intersectObject(collider, true)[0]
    if (!hit) {
      setMessage({ tone: 'error', text: 'No surface under the watch — move it over the desk.' })
      return
    }
    const p = currentRef.current
    const y = round(watchGroup.position.y + (hit.point.y - box.min.y))
    commit({ ...p, watch: { ...p.watch, position: [p.watch.position[0], y, p.watch.position[2]] } })
    setMessage({
      tone: 'info',
      text: `Dropped: watch y ${y.toFixed(4)} (surface hit at ${vec3(hit.point)
        .map((v) => v.toFixed(4))
        .join(', ')})`,
    })
  }, [colliderState, watchGroup, watchLoaded, commit])

  // ---------------------------------------------------------------- surface levelling
  const [tilt, setTilt] = useState<{ deg: number; rmsMm: number; samples: number } | null>(null)

  /** 7x7 downward rays within +-2 cm of the watch's XZ against the collider; least-squares plane. */
  const sampleSurface = useCallback((): PlaneFit | null => {
    const collider = colliderRoot.current
    if (!collider || !watchGroup) return null
    watchGroup.updateWorldMatrix(true, true)
    collider.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(watchGroup, true)
    if (box.isEmpty()) return null
    const center = box.getCenter(new THREE.Vector3())
    const top = box.max.y + Math.max(box.max.y - box.min.y, 0.005)
    const ray = new THREE.Raycaster()
    const down = new THREE.Vector3(0, -1, 0)
    const pts: THREE.Vector3[] = []
    for (let i = -3; i <= 3; i++)
      for (let j = -3; j <= 3; j++) {
        ray.set(new THREE.Vector3(center.x + (i / 3) * 0.02, top, center.z + (j / 3) * 0.02), down)
        const hit = ray.intersectObject(collider, true)[0]
        if (hit) pts.push(hit.point.clone())
      }
    return pts.length >= 12 ? fitPlane(pts) : null
  }, [watchGroup])

  const measureTilt = useCallback(() => {
    const fit = sampleSurface()
    setTilt(fit ? { deg: fit.tiltDeg, rmsMm: fit.rms * 1000, samples: fit.count } : null)
    return fit
  }, [sampleSurface])
  useEffect(() => {
    if (colliderState === 'ready' && watchLoaded) measureTilt()
  }, [colliderState, watchLoaded, measureTilt])

  /**
   * Set the world tilt, keeping the stone point under the watch fixed in the scene (offset
   * compensates the rotation about the world origin), then re-drop the watch and re-measure
   * once the new transform has reached the scene graph.
   */
  const applyTilt = useCallback(
    (target: { worldRotationX: number; worldRotationZ: number }, pivot: THREE.Vector3, before: number | null) => {
      const p = currentRef.current
      const frame = (q: Placement) =>
        new THREE.Matrix4().compose(
          new THREE.Vector3(...q.worldOffset),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(q.worldRotationX ?? 0, q.worldRotationY, q.worldRotationZ ?? 0, 'YZX')),
          new THREE.Vector3(q.worldScale, q.worldScale, q.worldScale),
        )
      const local = pivot.clone().applyMatrix4(frame(p).invert())
      const rotated: Placement = { ...p, worldRotationX: round(target.worldRotationX), worldRotationZ: round(target.worldRotationZ) }
      const moved = local.applyMatrix4(frame(rotated))
      const offset = new THREE.Vector3(...p.worldOffset).add(pivot).sub(moved)
      commit({ ...rotated, worldOffset: vec3(offset) })

      // Wait until R3F has applied the new rotation to the WorldFrame group, then drop + measure.
      const started = performance.now()
      const poll = () => {
        const outer = colliderRoot.current?.parent?.parent
        const ok = outer && Math.abs(outer.rotation.x - (rotated.worldRotationX ?? 0)) < 1e-6 && Math.abs(outer.rotation.z - (rotated.worldRotationZ ?? 0)) < 1e-6
        if (!ok && performance.now() - started < 2000) {
          setTimeout(poll, 30)
          return
        }
        dropToSurface()
        const after = measureTilt()
        setMessage({
          tone: after && after.tiltDeg < 0.5 ? 'info' : 'error',
          text:
            `Levelled: X ${THREE.MathUtils.radToDeg(rotated.worldRotationX ?? 0).toFixed(2)}°, Z ${THREE.MathUtils.radToDeg(rotated.worldRotationZ ?? 0).toFixed(2)}°. ` +
            `Tilt ${before !== null ? `${before.toFixed(2)}° → ` : ''}${after ? `${after.tiltDeg.toFixed(2)}°` : 'unmeasured'}`,
        })
      }
      setTimeout(poll, 30)
    },
    [commit, dropToSurface, measureTilt],
  )

  const levelSurface = useCallback(() => {
    const fit = sampleSurface()
    if (!fit || !watchGroup) {
      setMessage({ tone: 'error', text: 'Not enough surface under the watch to level — move it over the surface.' })
      return
    }
    const box = new THREE.Box3().setFromObject(watchGroup, true)
    const c = box.getCenter(new THREE.Vector3())
    const pivot = new THREE.Vector3(c.x, fit.a * c.x + fit.b * c.z + fit.c, c.z)
    applyTilt(levelRotation(fit.normal, currentRef.current), pivot, fit.tiltDeg)
  }, [sampleSurface, watchGroup, applyTilt])

  const resetLevel = useCallback(() => {
    if (!watchGroup) return
    const fit = sampleSurface()
    const box = new THREE.Box3().setFromObject(watchGroup, true)
    const c = box.getCenter(new THREE.Vector3())
    const pivot = new THREE.Vector3(c.x, fit ? fit.a * c.x + fit.b * c.z + fit.c : box.min.y, c.z)
    applyTilt({ worldRotationX: 0, worldRotationZ: 0 }, pivot, fit?.tiltDeg ?? null)
  }, [sampleSurface, watchGroup, applyTilt])

  /** Collider hit straight through the hero target, beyond the watch (skips the desk under it). */
  const backgroundDistance = useCallback((hero: CameraShot['hero']): number | null => {
    const collider = colliderRoot.current
    if (!collider) return null
    collider.updateWorldMatrix(true, true)
    const origin = new THREE.Vector3(...hero.position)
    const dir = new THREE.Vector3(...hero.target).sub(origin)
    const targetDist = dir.length()
    if (!(targetDist > 0)) return null
    dir.normalize()
    const hit = new THREE.Raycaster(origin, dir).intersectObject(collider, true).find((h) => h.distance > targetDist * 1.05)
    return hit ? hit.distance : null
  }, [])

  const reset = useMemo(
    () =>
      onResetPlacement
        ? () => {
            setMessage(null)
            onResetPlacement()
          }
        : undefined,
    [onResetPlacement],
  )

  const initialCamera = useRef(current.camera).current

  return (
    <div className={`relative h-full w-full select-none bg-black ${className ?? ''}`}>
      <ViewerErrorBoundary
        resetKey={`${splatUrl}|${watchUrl}`}
        onError={(e) => report('renderer', e)}
        fallback={() => null}
      >
        <Canvas
          camera={{ ...CAMERA, fov: initialCamera.fov, position: initialCamera.position }}
          gl={{ antialias: false }}
          dpr={[1, 1.5]}
          onCreated={({ gl }) => gl.setClearColor('#000000', 1)}
        >
          {/* Plain black background when no splat; never a gradient or fake environment. */}
          <color attach="background" args={['#000000']} />

{/* Lighting comes only from the pano: IBL + an estimated key light with shadows. Without a
              pano there is no light estimate and no fake default rig. */}
          <SceneLightRig estimate={estimate} placementWatchPosition={current.watch.position} watch={watchGroup} />
          {estimate && watchMinY !== null && (look.shadows || look.contact) && (
            // Direct child of the scene so FrameRenderer can draw it alone for the DOF shadow blur.
            <group ref={setCatcher}>
            <ShadowCatcher
              position={[current.watch.position[0], watchMinY, current.watch.position[2]]}
              contactTarget={watchGroup}
              shadowColor={shadowTint}
              keyShadow={look.shadows}
              shadowOpacity={look.shadowOpacity}
              contact={look.contact}
            />
            </group>
          )}
          <Harmonize watch={watchGroup} />
          <FinishPass watch={watchGroup} grain={look.grain} auto={false} apiRef={finishApi} />
          <FinishPass watch={watchGroup} grain={look.grain} edgeSoften={0} lightWrap={0} auto={false} apiRef={finishBlurredApi} />

          {environmentUrl && (
            <ViewerErrorBoundary resetKey={environmentUrl} onError={(e) => report('environment', e)}>
              <Suspense fallback={null}>
                <EquirectEnvironment url={environmentUrl} intensity={environmentIntensity} rotation={envRotation} />
              </Suspense>
            </ViewerErrorBoundary>
          )}

          {splatUrl && (
            <ViewerErrorBoundary resetKey={splatUrl} onError={(e) => report('splat', e)}>
              <SplatWorld
                url={splatUrl}
                transform={current}
                onLoad={(info) => {
                  clear('splat')
                  onSplatLoad?.(info)
                }}
                onError={(e) => report('splat', e)}
                onSpark={(sp) => {
                  sparkRef.current = sp
                }}
              />
            </ViewerErrorBoundary>
          )}

          {colliderUrl && (
            <ViewerErrorBoundary resetKey={colliderUrl} onError={(e) => report('collider', e)}>
              <WorldFrame transform={current}>
                <ColliderMesh
                  url={colliderUrl}
                  onReady={(root) => {
                    colliderRoot.current = root
                    if (root) {
                      clear('collider')
                      setColliderState('ready')
                    }
                  }}
                  onError={(e) => {
                    setColliderState('error')
                    report('collider', e)
                  }}
                />
              </WorldFrame>
            </ViewerErrorBoundary>
          )}

          {watchUrl && (
            <group ref={setWatchGroup} position={current.watch.position} rotation={current.watch.rotation}>
              <ViewerErrorBoundary resetKey={watchUrl} onError={(e) => report('watch', e)}>
                <WatchModel
                  url={watchUrl}
                  targetSize={current.watch.size}
                  onLoad={(info) => {
                    clear('watch')
                    setWatchLoaded(true)
                    onWatchLoad?.(info)
                  }}
                  onError={(e) => report('watch', e)}
                />
              </ViewerErrorBoundary>
            </group>
          )}

          {editable && !previewing && watchGroup && watchLoaded && (
            <TransformControls object={watchGroup} mode={mode} onMouseUp={commitWatchFromGizmo} />
          )}

          <OrbitControls makeDefault enableDamping minDistance={0.02} maxDistance={50} zoomSpeed={0.6} />
          <CameraRig view={current.camera} onCommit={(camera) => commit({ ...currentRef.current, camera })} />
          <ShotRig shot={currentShot} clock={clock} apiRef={rigApi} />
          <FrameRenderer
            watch={watchGroup}
            catcher={catcher}
            spark={sparkRef}
            dof={dofRef}
            rig={rigApi}
            frameAspect={frameAspect}
            exporting={exportingRef}
            finish={finishApi}
            finishBlurred={finishBlurredApi}
            playing={isPlaying}
            apiRef={frameApi}
          />
          <ExportBridge
            clock={clock}
            rig={rigApi}
            frame={frameApi}
            spark={sparkRef}
            shot={currentShotRef}
            exporting={exportingRef}
            onHandle={onRenderHandle}
          />
        </Canvas>
      </ViewerErrorBoundary>
      {/* When editable, keep errors clear of the top-right toolbar (w-60 + margin). */}
      <ViewerErrorOverlay errors={errorItems} className={editable ? 'max-sm:top-60 sm:pr-[16.5rem]' : ''} />
      {editable && (
        <PlacementToolbar
          mode={mode}
          onModeChange={setMode}
          onDrop={dropToSurface}
          dropUnavailable={dropUnavailable}
          message={message}
          onReset={reset}
          watchSize={current.watch.size}
          onWatchSizeChange={(size) => commitSettled({ ...currentRef.current, watch: { ...currentRef.current.watch, size } })}
          worldScale={current.worldScale}
          onWorldScaleChange={(worldScale) => commitSettled({ ...currentRef.current, worldScale })}
          look={look}
          onLookChange={setLook}
          tiltDeg={tilt?.deg ?? null}
          tiltDetail={tilt ? `${tilt.samples} samples, rms ${tilt.rmsMm.toFixed(2)} mm` : undefined}
          levelled={!!(current.worldRotationX || current.worldRotationZ)}
          onLevel={dropUnavailable ? undefined : levelSurface}
          onResetLevel={dropUnavailable ? undefined : resetLevel}
        />
      )}
      {frameAspect ? <FrameGuide aspect={frameAspect} /> : null}
      {onShotChange && (
        <ShotPanel
          shot={currentShot}
          onShotChange={commitShot}
          clock={clock}
          rig={getRig}
          backgroundDistance={backgroundDistance}
        />
      )}
    </div>
  )
}

/**
 * Dims everything outside the export frame. The frame is the largest centered rect of the
 * given aspect; FrameRenderer zooms the camera out when that rect is shorter than the canvas,
 * so the rect always shows the export framing at the shot's vertical fov.
 */
function FrameGuide({ aspect }: { aspect: number }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  let w = 0
  let h = 0
  if (box) {
    h = Math.min(box.h, box.w / aspect)
    w = h * aspect
  }
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" data-testid="frame-guide">
      {box && (
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 outline outline-1 outline-white/40"
          style={{ width: w, height: h, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
        />
      )}
    </div>
  )
}
