// Dev-only look sandbox: /look-sandbox.html
// Optional: &preset=<dir under /data/assets/presets> &cam=hero|low|top|mirror &before=1
// Automation: window.__look.set({...toggles}), window.__look.cam('low'), await window.__look.fps(3)
import { StrictMode, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import '../index.css'
import { SplatWorld } from '../viewer/SplatWorld'
import { WatchModel } from '../viewer/WatchModel'
import { ColliderMesh } from '../viewer/ColliderMesh'
import { WorldFrame, type WorldTransform } from '../viewer/WorldFrame'
import { EquirectEnvironment } from '../viewer/EquirectEnvironment'
import { estimateLightFromUrl, type LightEstimate } from './estimateLight'
import { panoRotationY, type Vec3 } from './panoMath'
import { SceneLightRig } from './SceneLightRig'
import { ShadowCatcher, shadowTintFromEstimate } from './ShadowCatcher'
import { Harmonize } from './Harmonize'
import { FinishPass } from './FinishPass'

const q = new URLSearchParams(window.location.search)
const PRESET = `/data/assets/presets/${q.get('preset') ?? 'ef4332bd-8607-4063-b44b-c0d8b0e38351'}`
const SPLAT = `${PRESET}/world-500k.spz`
const PANO = `${PRESET}/pano.png`
const COLLIDER = `${PRESET}/collider.glb`
const WATCH = '/samples/casio_watch.glb'

const WORLD: WorldTransform = { worldScale: 0.06, worldOffset: [0, 0.0294, 0], worldRotationY: 0, flipY: true }
const WATCH_POS: Vec3 = [0, 0.0265, -0.05]
const WATCH_ROT: Vec3 = [0, Math.PI, 0]
const WATCH_SIZE = 0.065

const CAMS: Record<string, { p: Vec3; t: Vec3 }> = {
  hero: { p: [0.045, 0.06, 0.06], t: [0, 0.02, -0.05] },
  wide: { p: [0.16, 0.13, 0.16], t: [0, 0.01, -0.05] },
  low: { p: [0.05, 0.007, 0.0], t: [0, 0.006, -0.05] },
  top: { p: [0.0, 0.4, -0.0499], t: [0, 0, -0.05] },
  mirror: { p: [0, 0.03, 0.03], t: [0, 0.03, -0.05] },
  back: { p: [-0.04, 0.05, -0.15], t: [0, 0.02, -0.05] },
}

export interface LookState {
  before: boolean
  keyShadow: boolean
  contact: boolean
  fill: boolean
  harmonize: boolean
  tint: boolean
  grain: boolean
  soften: boolean
  wrap: boolean
  envFix: boolean
  mirror: boolean
  showWatch: boolean
  ui: boolean
  vsm: boolean
  staticShadow: boolean
}

const DEFAULTS: LookState = {
  before: q.get('before') === '1',
  keyShadow: true,
  contact: true,
  fill: true,
  harmonize: true,
  tint: false,
  grain: true,
  soften: true,
  wrap: true,
  envFix: true,
  mirror: false,
  showWatch: true,
  ui: q.get('ui') !== '0',
  vsm: q.get('vsm') !== '0',
  staticShadow: true,
}

/** Takes over rendering like StudioCanvas's FrameRenderer (priority 1); FinishPass runs at 2. */
function PlainRenderer() {
  useFrame(({ gl, scene, camera }) => gl.render(scene, camera), 1)
  return null
}

function CameraPreset({ name, controls }: { name: string; controls: React.RefObject<OrbitControlsImpl | null> }) {
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    const c = CAMS[name] ?? (name.startsWith('custom') ? CAMS.custom : CAMS.hero)
    camera.position.set(...c.p)
    controls.current?.target.set(...c.t)
    controls.current?.update()
  }, [name, camera, controls])
  return null
}

function Expose() {
  const three = useThree()
  useEffect(() => {
    ;(window as unknown as { __look: Record<string, unknown> }).__look.three = three
  })
  return null
}

/** __look.grab(name): saves the finished canvas (after FinishPass) via the dev capture endpoint. */
function Grabber() {
  const pending = useRef<{ name: string; wait: number; done: (v: string) => void }[]>([])
  useEffect(() => {
    ;(window as unknown as { __look: Record<string, unknown> }).__look.grab = (name: string, wait = 4) =>
      new Promise<string>((done) => pending.current.push({ name, wait, done }))
  }, [])
  useFrame(({ gl }) => {
    const job = pending.current[0]
    if (!job || job.wait-- > 0) return
    pending.current.shift()
    const url = gl.domElement.toDataURL('image/png')
    fetch(`/__save?name=${encodeURIComponent(job.name)}`, { method: 'POST', body: url })
      .then((r) => r.text())
      .then(job.done, (e: Error) => job.done(`ERROR ${e.message}`))
  }, 3)
  return null
}

function FpsProbe() {
  const frames = useRef<number[]>([])
  useFrame(() => {
    frames.current.push(performance.now())
    if (frames.current.length > 600) frames.current.shift()
  })
  useEffect(() => {
    const w = window as unknown as { __look: Record<string, unknown> }
    w.__look.fps = async (seconds = 3) => {
      const t0 = performance.now()
      await new Promise((r) => setTimeout(r, seconds * 1000))
      const n = frames.current.filter((t) => t >= t0).length
      return n / seconds
    }
  }, [])
  return null
}

function Sandbox() {
  const [s, setS] = useState<LookState>(DEFAULTS)
  const [cam, setCam] = useState(q.get('cam') ?? 'hero')
  const [estimate, setEstimate] = useState<LightEstimate | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [watch, setWatch] = useState<THREE.Group | null>(null)
  const [watchLoaded, setWatchLoaded] = useState(false)
  const [rest, setRest] = useState<{ p: Vec3; n: Vec3 } | null>(null)
  const collider = useRef<THREE.Object3D | null>(null)
  const controls = useRef<OrbitControlsImpl | null>(null)
  const add = (m: string) => setLog((l) => [...l, m])
  const envRot = s.envFix ? panoRotationY(WORLD) : 0

  ;(window as unknown as { __look: Record<string, unknown> }).__look ??= {}
  useEffect(() => {
    const w = window as unknown as { __look: Record<string, unknown> }
    w.__look.set = (patch: Partial<LookState>) => setS((p) => ({ ...p, ...patch }))
    // Queue captures: [{ name, patch, cam | [p, t] }]; each is applied, then grabbed a few frames later.
    w.__look.queue = async (jobs: { name: string; patch: Partial<LookState>; cam: string | [Vec3, Vec3] }[]) => {
      const look = w.__look as { grab: (n: string, wait?: number) => Promise<string> }
      const out: string[] = []
      for (const j of jobs) {
        setS((p) => ({ ...p, ...j.patch }))
        if (typeof j.cam === 'string') setCam(j.cam)
        else {
          CAMS.custom = { p: j.cam[0], t: j.cam[1] }
          setCam('custom' + Math.random())
        }
        out.push(j.name + ':' + (await look.grab(j.name, 45)))
      }
      return out
    }
    w.__look.cam = (n: string) => setCam(n)
    w.__look.camAt = (p: Vec3, t: Vec3) => {
      CAMS.custom = { p, t }
      setCam('custom' + Math.random())
    }
    w.__look.state = () => ({ s, cam, estimate, rest, ready: !!estimate && watchLoaded && !!rest && splatReady.current })
  })
  const splatReady = useRef(false)

  useEffect(() => {
    estimateLightFromUrl(PANO, { rotationY: panoRotationY(WORLD) })
      .then((e) => {
        setEstimate(e)
        add(
          `light: dir ${e.direction.map((v) => v.toFixed(2)).join(',')} elev ${e.elevationDeg.toFixed(1)}° pano px ${e.pixel
            .map((v) => v.toFixed(0))
            .join(',')}/${e.analysedSize.join('x')} I ${e.intensity.toFixed(2)} contrast ${e.contrast.toFixed(1)}`,
        )
        add(`color ${e.color.map((v) => v.toFixed(2))} amb ${e.ambientColor.map((v) => v.toFixed(2))} ×${e.ambientIntensity.toFixed(2)} wb ${e.whiteBalance.map((v) => v.toFixed(2))} ground ${e.groundColor.map((v) => v.toFixed(2))}`)
      })
      .catch((e: Error) => add(`ERROR ${e.message}`))
  }, [])

  // Resting point: raycast straight down from the watch onto the collider (the desk surface).
  useEffect(() => {
    if (!watchLoaded || !watch) return
    let tries = 0
    const id = setInterval(() => {
      const root = collider.current
      if (!root && tries++ < 60) return
      clearInterval(id)
      watch.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(watch, true)
      const center = box.getCenter(new THREE.Vector3())
      if (root) {
        root.updateMatrixWorld(true)
        const ray = new THREE.Raycaster(new THREE.Vector3(center.x, box.max.y + 0.05, center.z), new THREE.Vector3(0, -1, 0))
        const hits = ray.intersectObject(root, true).filter((h) => h.point.y < box.min.y + 0.01)
        const hit = hits[0]
        if (hit) {
          const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0)
          if (n.y < 0) n.negate()
          add(`rest: collider hit y ${hit.point.y.toFixed(4)} (watch min y ${box.min.y.toFixed(4)}) normal ${n.toArray().map((v) => v.toFixed(2))}`)
          // The watch stands on its lowest point; the plane goes there (desk normal ~ up).
          setRest({ p: [center.x, box.min.y, center.z], n: [0, 1, 0] })
          return
        }
      }
      add(`rest: no collider hit; using watch bbox min y ${box.min.y.toFixed(4)}`)
      setRest({ p: [center.x, box.min.y, center.z], n: [0, 1, 0] })
    }, 250)
    return () => clearInterval(id)
  }, [watchLoaded, watch])

  const before = s.before
  const toggles: (keyof LookState)[] = ['before', 'keyShadow', 'contact', 'fill', 'harmonize', 'tint', 'grain', 'soften', 'wrap', 'envFix', 'mirror', 'showWatch', 'vsm', 'staticShadow']
  const mirrorMat = useMemo(() => new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.02, color: 0xffffff }), [])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      <Canvas camera={{ fov: 35, near: 0.001, far: 100, position: CAMS.hero.p }} gl={{ antialias: false }} dpr={[1, 1.5]}>
        <color attach="background" args={['#000000']} />
        <PlainRenderer />
        <FpsProbe />
        <Expose />
        <Grabber />
        <CameraPreset name={cam} controls={controls} />
        <OrbitControls ref={controls} makeDefault enableDamping minDistance={0.005} maxDistance={5} />

        <Suspense fallback={null}>
          <EquirectEnvironment url={PANO} intensity={1} rotationY={before ? 0 : envRot} />
        </Suspense>
        <SplatWorld
          url={SPLAT}
          transform={WORLD}
          onLoad={(i) => {
            splatReady.current = true
            add(`splat: ${i.numSplats}`)
          }}
          onError={(e) => add(`ERROR ${e.message}`)}
        />
        <WorldFrame transform={WORLD}>
          <ColliderMesh url={COLLIDER} onReady={(r) => (collider.current = r)} onError={(e) => add(`ERROR ${e.message}`)} />
        </WorldFrame>

        <group ref={setWatch} position={WATCH_POS} rotation={WATCH_ROT} visible={s.showWatch}>
          <WatchModel url={WATCH} targetSize={WATCH_SIZE} onLoad={() => setWatchLoaded(true)} onError={(e) => add(`ERROR ${e.message}`)} />
        </group>
        {s.mirror && (
          <mesh position={[0, 0.03, -0.05]} material={mirrorMat}>
            <sphereGeometry args={[0.012, 64, 32]} />
          </mesh>
        )}

        {before ? (
          <>
            {/* StudioCanvas's current placeholder rig + R3F defaults (ACES), env unrotated. */}
            <ambientLight intensity={0.6} />
            <directionalLight position={[0.3, 0.5, 0.4]} intensity={2.5} />
          </>
        ) : (
          <>
            <SceneLightRig estimate={estimate} placementWatchPosition={WATCH_POS} shadow={s.keyShadow} fill={s.fill} shadowType={s.vsm ? 'vsm' : 'pcf'} shadowRadius={s.vsm ? 24 : 6} watch={s.staticShadow ? watch : null} />
            {rest && estimate && (
              <ShadowCatcher
                position={rest.p}
                normal={rest.n}
                keyShadow={s.keyShadow}
                contact={s.contact}
                contactTarget={watch}
                shadowColor={shadowTintFromEstimate(estimate)}
              />
            )}
            {s.harmonize && (
              <Harmonize watch={watch} toneMapping="neutral" whiteBalance={estimate?.whiteBalance} tintStrength={s.tint ? 0.25 : 0} />
            )}
            <FinishPass watch={watch} grain={s.grain ? 0.025 : 0} edgeSoften={s.soften ? 0.7 : 0} lightWrap={s.wrap ? 0.35 : 0} />
          </>
        )}
      </Canvas>
      <div style={{ display: s.ui ? 'block' : 'none', position: 'absolute', top: 8, left: 8, font: '11px ui-monospace, monospace', color: '#fff', background: 'rgba(0,0,0,0.6)', padding: 6, borderRadius: 4, maxWidth: 520 }}>
        <div>look sandbox — cam: {Object.keys(CAMS).map((c) => (
          <button key={c} onClick={() => setCam(c)} style={{ marginRight: 4, textDecoration: c === cam ? 'underline' : 'none' }}>{c}</button>
        ))}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {toggles.map((k) => (
            <label key={k}>
              <input type="checkbox" checked={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.checked })} /> {k}
            </label>
          ))}
        </div>
        {log.map((l, i) => (
          <div key={i} data-testid="look-log">{l}</div>
        ))}
      </div>
    </div>
  )
}

const container = document.getElementById('root') as HTMLElement & { __root?: Root }
container.__root ??= createRoot(container)
container.__root.render(
  <StrictMode>
    <Sandbox />
  </StrictMode>,
)
