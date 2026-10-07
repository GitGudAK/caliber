import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ArrowClockwise, CaretDown, CaretRight, DownloadSimple, X } from '@phosphor-icons/react'
import type { Asset, AudioTrack, CameraShot } from '../../shared/types'
import { decodeAudioUrl } from '../audio/decode'
import { renderTrackBuffer } from '../audio/mixTrack'
import { AppButton } from '../components/AppButton'
import { chrome } from '../components/AppChrome'
import { ErrorRow } from '../components/ErrorRow'
import { api, errorMessage } from '../lib/api'
import { formatBytes, formatTime } from '../lib/format'
import type { RenderHandle } from '../viewer/renderHandle'
import { ExportUnsupportedError, assertEncodable, computeFrameTimings, exportMp4, mediabunnyCapabilities } from './exportMp4'
import {
  blockedReason,
  downloadFilename,
  etaSeconds,
  exportReducer,
  formatEta,
  initialExportPhase,
  isBusy,
  savedPath,
  type EncoderSupport,
} from './exportState'
import { DEFAULT_EXPORT_PRESET_ID, EXPORT_PRESETS, getExportPreset, type ExportPresetId } from './presets'

export interface ExportPanelProps {
  projectId: string
  shot: CameraShot | null
  handle: RenderHandle | null
  /** width / height of the chosen format while the panel is open (viewer draws the crop guide); null when collapsed. */
  onFrameAspectChange: (aspect: number | null) => void
  /** Project soundtrack; when set, the export muxes it (or fails; audio is never dropped silently). */
  audioTrack?: AudioTrack | null
  /** The library asset for audioTrack (null when it is not in the library / not loaded yet). */
  audioAsset?: Asset | null
}

const audioLabel = (a: Asset) => (typeof a.meta.prompt === 'string' ? a.meta.prompt : a.filename)

type Shape = 'vertical' | 'square' | 'landscape'

const SHAPES: { id: Shape; label: string }[] = [
  { id: 'vertical', label: 'Vertical 9:16' },
  { id: 'square', label: 'Square 1:1' },
  { id: 'landscape', label: 'Landscape 16:9' },
]

const shapeOf = (id: string): Shape | null =>
  id.startsWith('vertical') ? 'vertical' : id.startsWith('square') ? 'square' : id.startsWith('landscape') ? 'landscape' : null

const presetFor = (shape: Shape, fps: 30 | 60) => {
  const preset = EXPORT_PRESETS.find((p) => shapeOf(p.id) === shape && p.fps === fps)
  if (!preset) throw new Error(`No export preset for ${shape} at ${fps} fps`)
  return preset
}

/** "Vertical 9:16 · 30 fps" for a stored preset id; the raw id if it is no longer known. */
function formatLabel(presetId: unknown): string {
  if (typeof presetId !== 'string') return 'unknown format'
  const preset = EXPORT_PRESETS.find((p) => p.id === presetId)
  const shape = SHAPES.find((s) => s.id === shapeOf(presetId))
  return preset && shape ? `${shape.label} · ${preset.fps} fps` : presetId
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the browser time to start reading the blob before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const seg = (active: boolean) =>
  `${chrome.row} ${active ? chrome.rowActive : chrome.rowIdle} h-7 flex-1 justify-center px-2 text-xs text-white disabled:pointer-events-none disabled:opacity-40`

export function ExportPanel({ projectId, shot, handle, onFrameAspectChange, audioTrack = null, audioAsset = null }: ExportPanelProps) {
  const [open, setOpen] = useState(false)
  const [presetId, setPresetId] = useState<ExportPresetId>(DEFAULT_EXPORT_PRESET_ID)
  const preset = getExportPreset(presetId)
  const shape = shapeOf(presetId) ?? 'landscape'

  const [phase, dispatch] = useReducer(exportReducer, initialExportPhase)
  const [support, setSupport] = useState<EncoderSupport>({ status: 'checking' })
  const [exportsList, setExportsList] = useState<Asset[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** Encoded video that failed to save, so the render is not lost. */
  const [unsaved, setUnsaved] = useState<{ blob: Blob; name: string } | null>(null)

  // Crop guide follows the chosen format while the panel is open.
  useEffect(() => {
    onFrameAspectChange(open ? preset.width / preset.height : null)
  }, [open, preset.width, preset.height, onFrameAspectChange])
  useEffect(() => () => onFrameAspectChange(null), [onFrameAspectChange])

  // Abort a running export if the panel goes away.
  useEffect(() => () => abortRef.current?.abort(), [])

  // Real encoder capability for this size/bitrate.
  useEffect(() => {
    let live = true
    setSupport({ status: 'checking' })
    assertEncodable(mediabunnyCapabilities, { width: preset.width, height: preset.height, bitrate: preset.bitrate }).then(
      () => live && setSupport({ status: 'ok' }),
      (e: unknown) =>
        live &&
        setSupport({
          status: 'unsupported',
          message: e instanceof ExportUnsupportedError ? e.message : `Could not check video encoder support: ${errorMessage(e)}`,
        }),
    )
    return () => {
      live = false
    }
  }, [preset.width, preset.height, preset.bitrate])

  const loadExports = useCallback(async () => {
    setListError(null)
    try {
      setExportsList(await api.listExports(projectId))
    } catch (e) {
      setListError(errorMessage(e))
    }
  }, [projectId])
  useEffect(() => {
    setExportsList(null)
    void loadExports()
  }, [loadExports])

  const blocked = blockedReason({ hasShot: !!shot, hasHandle: !!handle, support })
  const busy = isBusy(phase)

  const run = async () => {
    if (!shot || !handle || blocked || busy) return
    const controller = new AbortController()
    abortRef.current = controller
    const { signal } = controller
    const label = shot.move
    const durationSeconds = shot.durationSeconds
    const downloadName = downloadFilename(label, preset.id)
    setUnsaved(null)

    let blob: Blob | null = null
    try {
      const { frameCount } = computeFrameTimings(preset.fps, durationSeconds)
      dispatch({ type: 'start', frameCount, now: Date.now() })
      // Soundtrack first: if it cannot be mixed, fail before spending time on frames.
      let audio: AudioBuffer | undefined
      if (audioTrack) {
        if (!audioAsset) throw new Error(`Audio track asset ${audioTrack.assetId} is not in the audio library; remove the track or reload.`)
        try {
          const source = await decodeAudioUrl(audioAsset.url)
          audio = await renderTrackBuffer(audioTrack, source, durationSeconds)
        } catch (e) {
          throw new Error(`Audio mix failed: ${errorMessage(e)}`)
        }
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      }
      await handle.beginExport(preset.width, preset.height)
      try {
        blob = await exportMp4({
          canvas: handle.canvas,
          width: preset.width,
          height: preset.height,
          fps: preset.fps,
          durationSeconds,
          bitrate: preset.bitrate,
          audio,
          signal,
          renderFrame: async (t, i) => {
            await handle.renderAt(t)
            dispatch({ type: 'frame', frame: i + 1 })
          },
        })
      } finally {
        handle.endExport()
      }
      dispatch({ type: 'encoded' })
      const asset = await api.uploadExport(projectId, blob, { label, durationSeconds, preset: preset.id }, signal)
      triggerDownload(blob, downloadName)
      dispatch({ type: 'saved', asset, downloadName })
      void loadExports()
    } catch (e) {
      if (signal.aborted) {
        dispatch({ type: 'cancelled' })
      } else {
        if (blob) setUnsaved({ blob, name: downloadName })
        dispatch({ type: 'failed', message: errorMessage(e) })
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  const toggle = () => {
    if (busy) return
    setOpen((o) => !o)
  }

  return (
    <div className={`${chrome.panel} ${chrome.enter} flex flex-col overflow-hidden`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`${chrome.sectionHeader} w-full text-left hover:text-white/80`}
      >
        <span className="flex items-center gap-1">
          {open ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />}
          Export
        </span>
        {phase.kind === 'rendering' && (
          <span className="text-white/35">
            {phase.frame}/{phase.frameCount}
          </span>
        )}
        {phase.kind === 'saving' && <span className="text-white/35">Saving…</span>}
      </button>

      {open && (
        <div className="flex flex-col gap-1.5 p-1.5">
          <div className="flex gap-1" role="group" aria-label="Format">
            {SHAPES.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={busy}
                aria-pressed={shape === s.id}
                onClick={() => setPresetId(presetFor(s.id, preset.fps).id)}
                className={seg(shape === s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1" role="group" aria-label="Frame rate">
            {([30, 60] as const).map((fps) => (
              <button
                key={fps}
                type="button"
                disabled={busy}
                aria-pressed={preset.fps === fps}
                onClick={() => setPresetId(presetFor(shape, fps).id)}
                className={seg(preset.fps === fps)}
              >
                {fps} fps
              </button>
            ))}
          </div>
          <p className="px-1 text-xs text-white/45">
            {preset.width} × {preset.height}
            {shot ? ` · ${shot.durationSeconds}s · ${computeFrameTimings(preset.fps, shot.durationSeconds).frameCount} frames` : ''}
          </p>
          {audioTrack && (
            <p className="truncate px-1 text-xs text-white/55" title={audioAsset ? audioLabel(audioAsset) : audioTrack.assetId}>
              with audio: {audioAsset ? audioLabel(audioAsset) : `${audioTrack.assetId} (not in library)`}
            </p>
          )}

          {phase.kind === 'rendering' || phase.kind === 'saving' ? (
            <div className="flex flex-col gap-1 px-1">
              <div className="h-1.5 w-full overflow-hidden rounded bg-white/10">
                <div
                  className="h-full bg-white/70 transition-[width]"
                  style={{
                    width: `${phase.kind === 'saving' ? 100 : (phase.frame / phase.frameCount) * 100}%`,
                  }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-white/55">
                <span>
                  {phase.kind === 'saving'
                    ? 'Saving to data/exports…'
                    : `Frame ${phase.frame} of ${phase.frameCount} · ${formatEta(etaSeconds(phase, Date.now()))}`}
                </span>
                <AppButton onClick={() => abortRef.current?.abort()} className="gap-1 text-white">
                  <X size={12} weight="bold" />
                  <span>Cancel</span>
                </AppButton>
              </div>
            </div>
          ) : (
            <>
              <AppButton
                onClick={() => void run()}
                disabled={blocked !== null}
                title={blocked ?? undefined}
                className="gap-1 self-start border border-white/20 text-white disabled:pointer-events-none disabled:opacity-40"
              >
                <DownloadSimple size={14} weight="bold" />
                <span>Download video</span>
              </AppButton>
              {blocked &&
                (support.status === 'unsupported' && blocked === support.message ? (
                  <ErrorRow message={blocked} />
                ) : (
                  <p className="px-1 text-xs text-white/55">{blocked}</p>
                ))}
            </>
          )}

          {phase.kind === 'cancelled' && (
            <p className="px-1 text-xs text-white/55">Cancelled. Nothing was saved.</p>
          )}
          {phase.kind === 'error' && (
            <>
              <ErrorRow message={phase.message} onDismiss={() => dispatch({ type: 'reset' })} />
              {unsaved && (
                <AppButton
                  onClick={() => triggerDownload(unsaved.blob, unsaved.name)}
                  className="gap-1 self-start text-white"
                >
                  <DownloadSimple size={12} weight="bold" />
                  <span>Download the unsaved video</span>
                </AppButton>
              )}
            </>
          )}
          {phase.kind === 'done' && (
            <div className="flex flex-col px-1 text-xs">
              <span className="text-white/90">Saved and downloaded as {phase.downloadName}</span>
              <a
                href={phase.asset.url}
                target="_blank"
                rel="noreferrer"
                title={phase.asset.url}
                className="truncate font-mono text-[11px] leading-tight text-white/45 hover:text-white/80"
              >
                {savedPath(phase.asset)}
              </a>
            </div>
          )}

          <div className="mt-1 flex flex-col border-t border-white/10 pt-1">
            <span className="px-1 py-0.5 text-xs text-white/55">Previous exports</span>
            {listError ? (
              <>
                <ErrorRow message={`Could not load exports: ${listError}`} />
                <AppButton onClick={() => void loadExports()} className="gap-1 self-start text-white">
                  <ArrowClockwise size={12} weight="bold" />
                  <span>Retry</span>
                </AppButton>
              </>
            ) : !exportsList ? (
              <p className="px-1 text-xs text-white/45">Loading…</p>
            ) : exportsList.length === 0 ? (
              <p className="px-1 text-xs text-white/45">None yet.</p>
            ) : (
              exportsList.map((asset) => (
                <a
                  key={asset.id}
                  href={asset.url}
                  target="_blank"
                  rel="noreferrer"
                  title={savedPath(asset)}
                  className={`${chrome.row} ${chrome.rowIdle} min-w-0 flex-col items-start gap-0 px-1 py-1`}
                >
                  <span className="truncate text-xs font-medium leading-tight text-white/90">
                    {typeof asset.meta.label === 'string' ? asset.meta.label : asset.filename}
                  </span>
                  <span className="truncate text-xs leading-tight text-white/45">
                    {formatLabel(asset.meta.preset)} · {formatBytes(asset.bytes)} · {formatTime(asset.createdAt)}
                  </span>
                </a>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
