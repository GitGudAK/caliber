// Dev-only sandbox: /viewer-sandbox.html?splat=/samples/splats/butterfly.spz&watch=/samples/casio_watch.glb
// Optional: &cam=x,y,z &flipY=0|1 &ground=<m> &scale=<metric_scale_factor> &size=<watch meters>
//           &wpos=x,y,z &wrot=x,y,z (radians) &env=<equirect url> &envI=<intensity>
//           &collider=<collider .glb url> &edit=1 (placement gizmo + toolbar; the query params
//           above become the initial Placement, and changes are logged below as JSON)
//           &aspect=<w/h, e.g. 0.5625> (export crop guide); window.__render = RenderHandle
//           &export=<projectId> mounts the real ExportPanel (needs &shot=1 for a shot; uploads to that project)
//           &shot=1 (ShotPanel: camera moves; the shot is logged as JSON, status box moves top-left)
import { StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '../index.css'
import type { CameraShot, Placement, Vec3 } from '../../shared/types'
import { StudioCanvas, type StudioCanvasHandle } from './StudioCanvas'
import type { RenderHandle } from './renderHandle'
import { ExportPanel } from '../export/ExportPanel'

const q = new URLSearchParams(window.location.search)
const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined)
const vec = (k: string) => q.get(k)?.split(',').map(Number) as Vec3 | undefined
const editMode = q.get('edit') === '1'
const shotMode = q.get('shot') === '1'
const exportProjectId = q.get('export')

/** Same mapping StudioCanvas uses for its legacy props. */
function initialPlacement(): Placement {
  const wpos = vec('wpos') ?? [0, 0, 0]
  return {
    worldScale: num('scale') ?? 1,
    worldOffset: [0, num('ground') ?? 0, 0],
    worldRotationY: 0,
    flipY: q.has('flipY') ? q.get('flipY') !== '0' : true,
    watch: { position: wpos, rotation: vec('wrot') ?? [0, 0, 0], size: num('size') ?? 0.045 },
    camera: { position: vec('cam') ?? [0, 0.03, 0.18], target: wpos, fov: 35 },
  }
}

function Sandbox() {
  const [status, setStatus] = useState<string[]>([])
  const [placement, setPlacement] = useState<Placement>(initialPlacement)
  const [changes, setChanges] = useState(0)
  const [shot, setShot] = useState<CameraShot | null>(null)
  const [shotChanges, setShotChanges] = useState(0)
  const [renderHandle, setRenderHandle] = useState<RenderHandle | null>(null)
  const [exportAspect, setExportAspect] = useState<number | null>(null)
  const log = (s: string) => setStatus((prev) => [...prev, s])

  // Exposed for manual/automated checks of the deterministic setShotTime path: window.__studio.setShotTime(2)
  const exposeHandle = (h: StudioCanvasHandle | null) => {
    ;(window as unknown as { __studio?: StudioCanvasHandle | null }).__studio = h
  }

  const common = {
    ref: exposeHandle,
    frameAspect: exportAspect ?? num('aspect') ?? null,
    onRenderHandle: (h: RenderHandle | null) => {
      ;(window as unknown as { __render?: unknown }).__render = h
      setRenderHandle(h)
    },
    splatUrl: q.get('splat') ?? undefined,
    watchUrl: q.get('watch') ?? undefined,
    environmentUrl: q.get('env') ?? undefined,
    environmentIntensity: num('envI'),
    colliderUrl: q.get('collider') ?? undefined,
    ...(shotMode
      ? {
          shot,
          onShotChange: (next: CameraShot | null) => {
            setShot(next)
            setShotChanges((n) => n + 1)
            console.info('[sandbox] shot', JSON.stringify(next))
          },
        }
      : {}),
    onSplatLoad: (i: { numSplats: number }) => log(`splat loaded: ${i.numSplats} splats`),
    onWatchLoad: (i: { sourceSize: { toArray(): number[] }; scale: number }) =>
      log(`watch loaded: source ${i.sourceSize.toArray().map((v) => v.toFixed(2)).join('×')} → scale ${i.scale.toExponential(3)}`),
  }

  return (
    <div className="h-full w-full">
      {editMode ? (
        <StudioCanvas
          {...common}
          editable
          placement={placement}
          onPlacementChange={(p) => {
            setPlacement(p)
            setChanges((n) => n + 1)
            console.info('[sandbox] placement', JSON.stringify(p))
          }}
          onResetPlacement={() => {
            setPlacement(initialPlacement())
            setChanges((n) => n + 1)
          }}
        />
      ) : (
        <StudioCanvas
          {...common}
          watchSize={num('size')}
          watchPosition={vec('wpos')}
          watchRotation={vec('wrot')}
          cameraPosition={vec('cam')}
          splatSemantics={{
            flipY: q.has('flipY') ? q.get('flipY') !== '0' : undefined,
            groundPlaneOffset: num('ground'),
            metricScaleFactor: num('scale'),
          }}
        />
      )}
      {exportProjectId && (
        <div className="absolute left-3 top-1/3 z-30 w-72">
          <ExportPanel projectId={exportProjectId} shot={shot} handle={renderHandle} onFrameAspectChange={setExportAspect} />
        </div>
      )}
      <div className={`pointer-events-none absolute ${shotMode ? 'top-3' : 'bottom-3'} left-3 max-h-[45%] max-w-[min(42rem,calc(100%-17rem))] overflow-hidden`}><div className="rounded border border-white/15 bg-black/70 px-2 py-1 font-mono text-xs text-white backdrop-blur-md">
        <div>viewer sandbox{editMode ? ' (edit)' : ''}</div>
        {status.map((s, i) => (
          <div key={i} data-testid="sandbox-status">{s}</div>
        ))}
        {editMode && (
          <div data-testid="sandbox-placement" className="whitespace-pre-wrap break-all text-white/80">
            placement (changes: {changes}): {JSON.stringify(placement)}
          </div>
        )}
        {shotMode && (
          <div data-testid="sandbox-shot" className="whitespace-pre-wrap break-all text-white/80">
            shot (changes: {shotChanges}):{' '}
            {shot
              ? `${shot.move} ${shot.durationSeconds}s ${shot.easing} amount=${shot.amount} dir=${shot.direction} keys=${JSON.stringify(shot.keys.map((k) => ({ t: k.t, p: k.position, tg: k.target })))}`
              : 'none'}
          </div>
        )}
      </div></div>
    </div>
  )
}

// Reuse the root across HMR re-executions of this module.
const container = document.getElementById('root') as HTMLElement & { __root?: Root }
container.__root ??= createRoot(container)
container.__root.render(
  <StrictMode>
    <Sandbox />
  </StrictMode>,
)
