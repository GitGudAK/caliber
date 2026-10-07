import { useEffect, useReducer, useRef, useState } from 'react'
import { ArrowClockwise, Play, Stop } from '@phosphor-icons/react'
import type { Asset, AudioTrack, SfxPreview, WorldPreset } from '../../shared/types'
import { AppButton } from '../components/AppButton'
import { chrome } from '../components/AppChrome'
import { ErrorRow } from '../components/ErrorRow'
import { api, errorMessage, isCachedSfx } from '../lib/api'
import { useJob } from '../lib/useJob'
import {
  approvable,
  defaultAmbiencePrompt,
  formProblem,
  initialSfxState,
  isSfxBusy,
  sfxReducer,
  toRequestInput,
} from './sfxReview'
import { defaultTrackFor, silentTrackReason } from './trackMath'
import type { ShotAudioStatus } from './useShotAudio'

const metaString = (a: Asset, key: string) => (typeof a.meta[key] === 'string' ? (a.meta[key] as string) : null)
const metaNumber = (a: Asset, key: string) => (typeof a.meta[key] === 'number' ? (a.meta[key] as number) : null)

export const audioPrompt = (a: Asset) => metaString(a, 'prompt') ?? a.filename

export function AudioSection({
  library,
  libraryError,
  onReloadLibrary,
  track,
  onTrackChange,
  activePreset,
  player,
  shotDuration,
}: {
  library: Asset[] | null
  libraryError: string | null
  /** Reloads the library and resolves with the new list (rejects with the real error). */
  onReloadLibrary: () => Promise<Asset[]>
  track: AudioTrack | null
  onTrackChange: (track: AudioTrack | null) => void
  activePreset: WorldPreset | null
  player: ShotAudioStatus
  shotDuration: number | null
}) {
  const activeAsset = track ? (library?.find((a) => a.id === track.assetId) ?? null) : null
  return (
    <div className={`${chrome.panel} ${chrome.enter} flex flex-col overflow-hidden`}>
      <div className={chrome.sectionHeader}>
        <span>Audio</span>
        {track && activeAsset && <span className="max-w-[60%] truncate text-white/35">{audioPrompt(activeAsset)}</span>}
      </div>
      <div className="flex flex-col gap-1 p-1.5">
        <Library
          library={library}
          libraryError={libraryError}
          onReload={() => void onReloadLibrary().catch(() => {})}
          track={track}
          onTrackChange={onTrackChange}
        />
        {track && (
          <TrackSettings
            track={track}
            asset={activeAsset}
            libraryLoaded={library !== null}
            onTrackChange={onTrackChange}
            player={player}
            shotDuration={shotDuration}
          />
        )}
        <GenerateForm activePreset={activePreset} onReloadLibrary={onReloadLibrary} onUse={(a) => onTrackChange(defaultTrackFor(a))} />
      </div>
    </div>
  )
}

function Library({
  library,
  libraryError,
  onReload,
  track,
  onTrackChange,
}: {
  library: Asset[] | null
  libraryError: string | null
  onReload: () => void
  track: AudioTrack | null
  onTrackChange: (track: AudioTrack | null) => void
}) {
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [playError, setPlayError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const stopPreview = () => {
    audioRef.current?.pause()
    audioRef.current = null
    setPlayingId(null)
  }
  useEffect(() => () => audioRef.current?.pause(), [])

  const togglePreview = (asset: Asset) => {
    const wasPlaying = playingId === asset.id
    stopPreview()
    if (wasPlaying) return
    setPlayError(null)
    const el = new Audio(asset.url)
    el.onended = () => {
      if (audioRef.current === el) stopPreview()
    }
    el.onerror = () => {
      if (audioRef.current !== el) return
      stopPreview()
      setPlayError(`Could not play ${asset.url}: ${el.error?.message || `media error code ${el.error?.code ?? '?'}`}`)
    }
    audioRef.current = el
    setPlayingId(asset.id)
    el.play().catch((e: unknown) => {
      if (audioRef.current !== el) return
      stopPreview()
      setPlayError(`Could not play ${asset.url}: ${errorMessage(e)}`)
    })
  }

  if (libraryError) {
    return (
      <>
        <ErrorRow message={`Could not load audio library: ${libraryError}`} />
        <AppButton onClick={onReload} className="gap-1 self-start text-white">
          <ArrowClockwise size={12} weight="bold" />
          <span>Retry</span>
        </AppButton>
      </>
    )
  }
  if (!library) return <p className="px-2 py-1 text-xs text-white/55">Loading audio…</p>
  return (
    <>
      {library.length === 0 ? (
        <p className="px-2 py-1 text-xs text-white/55">No sounds yet. Generated sounds are saved here and reused.</p>
      ) : (
        <div className="flex max-h-56 flex-col overflow-y-auto">
          {library.map((asset) => {
            const active = track?.assetId === asset.id
            const duration = metaNumber(asset, 'durationSeconds')
            return (
              <div
                key={asset.id}
                className={`${chrome.row} ${active ? chrome.rowActive : chrome.rowIdle} min-w-0 gap-1 px-1 py-1`}
              >
                <AppButton
                  onClick={() => togglePreview(asset)}
                  aria-label={playingId === asset.id ? 'Stop preview' : 'Play preview'}
                  className="h-6 w-6 flex-shrink-0 justify-center p-0 text-white"
                >
                  {playingId === asset.id ? <Stop size={12} weight="fill" /> : <Play size={12} weight="fill" />}
                </AppButton>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs leading-tight text-white/90" title={audioPrompt(asset)}>
                    {audioPrompt(asset)}
                  </span>
                  <span className="flex items-center gap-1 text-xs leading-tight text-white/45">
                    {duration !== null ? `${duration.toFixed(1)}s` : 'length unknown'}
                    {asset.meta.loop === true && (
                      <span className="rounded border border-white/20 px-1 text-[10px] leading-none text-white/60">loop</span>
                    )}
                  </span>
                </span>
                {active ? (
                  <AppButton onClick={() => onTrackChange(null)} className="flex-shrink-0 text-white">
                    Remove
                  </AppButton>
                ) : (
                  <AppButton onClick={() => onTrackChange(defaultTrackFor(asset))} className="flex-shrink-0 text-white">
                    Use
                  </AppButton>
                )}
              </div>
            )
          })}
        </div>
      )}
      {playError && <ErrorRow message={playError} onDismiss={() => setPlayError(null)} />}
    </>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-2 px-1 text-xs text-white/55">
      <span className="w-16 flex-shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-white"
      />
      <span className="w-10 flex-shrink-0 text-right font-mono text-white/70">{format(value)}</span>
    </label>
  )
}

function TrackSettings({
  track,
  asset,
  libraryLoaded,
  onTrackChange,
  player,
  shotDuration,
}: {
  track: AudioTrack
  asset: Asset | null
  libraryLoaded: boolean
  onTrackChange: (track: AudioTrack) => void
  player: ShotAudioStatus
  shotDuration: number | null
}) {
  const set = (patch: Partial<AudioTrack>) => onTrackChange({ ...track, ...patch })
  const fileLength = player.bufferDuration ?? (asset ? metaNumber(asset, 'durationSeconds') : null)
  const silent = fileLength !== null ? silentTrackReason(track, fileLength) : null
  const offsetMax = Math.max(1, Math.ceil(fileLength ?? 22))
  return (
    <div className="mt-1 flex flex-col gap-1 border-t border-white/10 pt-1.5">
      {libraryLoaded && !asset && <ErrorRow message={`The project's audio asset ${track.assetId} is not in the library.`} />}
      <Slider label="Volume" value={track.volume} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(volume) => set({ volume })} />
      <Slider
        label="Start at"
        value={Math.min(track.offsetSeconds, offsetMax)}
        min={0}
        max={offsetMax}
        step={0.05}
        format={(v) => `${v.toFixed(2)}s`}
        onChange={(offsetSeconds) => set({ offsetSeconds })}
      />
      <Slider label="Fade in" value={track.fadeInSeconds} min={0} max={5} step={0.05} format={(v) => `${v.toFixed(2)}s`} onChange={(fadeInSeconds) => set({ fadeInSeconds })} />
      <Slider label="Fade out" value={track.fadeOutSeconds} min={0} max={5} step={0.05} format={(v) => `${v.toFixed(2)}s`} onChange={(fadeOutSeconds) => set({ fadeOutSeconds })} />
      <label className="flex items-center gap-2 px-1 text-xs text-white/55">
        <input type="checkbox" checked={track.loop} onChange={(e) => set({ loop: e.target.checked })} className="accent-white" />
        <span>Loop to fill the shot</span>
      </label>
      {fileLength !== null && shotDuration !== null && !track.loop && fileLength - track.offsetSeconds < shotDuration && !silent && (
        <p className="px-1 text-xs text-white/45">
          Audio ends {(fileLength - track.offsetSeconds).toFixed(1)}s into the {shotDuration}s shot (loop is off).
        </p>
      )}
      {silent && <ErrorRow message={silent} />}
      {player.loading && <p className="px-1 text-xs text-white/45">Decoding audio for preview…</p>}
      {player.error && <ErrorRow message={`Preview audio unavailable: ${player.error}`} />}
      {player.syncSupported === false && (
        <p className="px-1 text-xs text-white/45">
          Shot preview plays silently: the viewer does not report playback state yet (needs isShotPlaying()).
        </p>
      )}
    </div>
  )
}

function GenerateForm({
  activePreset,
  onReloadLibrary,
  onUse,
}: {
  activePreset: WorldPreset | null
  onReloadLibrary: () => Promise<Asset[]>
  onUse: (asset: Asset) => void
}) {
  const [state, dispatch] = useReducer(sfxReducer, defaultAmbiencePrompt(activePreset), initialSfxState)
  const { form, phase } = state
  const busy = isSfxBusy(phase)
  const approved = approvable(state)
  const problem = formProblem(form)
  const jobId = phase.kind === 'running' ? phase.jobId : null
  const { job, error: watchError } = useJob(jobId)
  const [selectError, setSelectError] = useState<string | null>(null)

  const seed = defaultAmbiencePrompt(activePreset)
  useEffect(() => dispatch({ type: 'seedPrompt', prompt: seed }), [seed])

  const finish = async (assetIds: string[], known: Asset[], cached: boolean) => {
    dispatch({ type: 'finished', assets: known, cached })
    setSelectError(null)
    try {
      const list = await onReloadLibrary()
      const first = assetIds.map((id) => list.find((a) => a.id === id) ?? known.find((a) => a.id === id)).find(Boolean)
      if (first) onUse(first)
      else setSelectError(`Generated audio ${assetIds.join(', ') || '(no asset ids)'} is not in the library.`)
    } catch (e) {
      const first = known[0]
      if (first) onUse(first)
      setSelectError(`Could not refresh the audio library: ${errorMessage(e)}`)
    }
  }

  // Terminal job states.
  const jobStatus = job?.status
  useEffect(() => {
    if (!job || phase.kind !== 'running' || job.id !== phase.jobId) return
    if (job.status === 'failed') {
      dispatch({ type: 'failed', message: job.error ?? 'Sound generation failed (the job reported no error message).' })
    } else if (job.status === 'succeeded') {
      const result = job.result as { assetIds?: unknown } | null
      const ids = Array.isArray(result?.assetIds) ? result.assetIds.filter((x): x is string => typeof x === 'string') : []
      void finish(ids, [], false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobStatus, job?.id])

  const review = async () => {
    if (problem || busy) return
    const input = toRequestInput(form)
    dispatch({ type: 'previewStart', input })
    try {
      dispatch({ type: 'previewOk', input, preview: await api.previewSfx(input) })
    } catch (e) {
      dispatch({ type: 'previewFailed', input, message: errorMessage(e) })
    }
  }

  const approve = async () => {
    if (!approved) return
    dispatch({ type: 'approve' })
    try {
      const result = await api.generateSfx(approved.input, approved.hash)
      if (isCachedSfx(result)) await finish(result.assets.map((a) => a.id), result.assets, true)
      else dispatch({ type: 'jobStarted', jobId: result.id })
    } catch (e) {
      dispatch({ type: 'failed', message: errorMessage(e) })
    }
  }

  const reviewed = phase.kind === 'reviewed' || phase.kind === 'submitting' || phase.kind === 'running' ? phase : null

  return (
    <div className="mt-1 flex flex-col gap-1 border-t border-white/10 pt-1.5">
      <span className="px-1 text-xs text-white/55">Generate a sound (ElevenLabs via FAL, paid)</span>
      <textarea
        value={form.prompt}
        disabled={busy}
        onChange={(e) => dispatch({ type: 'edit', patch: { prompt: e.target.value } })}
        rows={3}
        className="w-full resize-y rounded border border-white/15 bg-white/5 px-2 py-1 text-xs text-white/90 outline-none focus:border-white/35 disabled:opacity-50"
      />
      <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-white/55">
        <label className="flex items-center gap-1">
          <span>Length</span>
          <input
            type="number"
            min={0.5}
            max={22}
            step={0.5}
            value={form.durationSeconds}
            disabled={busy}
            onChange={(e) => dispatch({ type: 'edit', patch: { durationSeconds: e.target.valueAsNumber } })}
            className="w-14 rounded border border-white/15 bg-white/5 px-1 py-0.5 text-white/90 disabled:opacity-50"
          />
          <span>s</span>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={form.loop}
            disabled={busy}
            onChange={(e) => dispatch({ type: 'edit', patch: { loop: e.target.checked } })}
            className="accent-white"
          />
          <span>Seamless loop</span>
        </label>
      </div>
      <label className="flex items-center gap-2 px-1 text-xs text-white/55">
        <span className="flex-shrink-0">Prompt influence</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={form.promptInfluence}
          disabled={busy}
          onChange={(e) => dispatch({ type: 'edit', patch: { promptInfluence: Number(e.target.value) } })}
          className="min-w-0 flex-1 accent-white"
        />
        <span className="w-8 text-right font-mono text-white/70">{form.promptInfluence.toFixed(2)}</span>
      </label>

      {!reviewed && phase.kind !== 'previewing' && (
        <>
          <AppButton
            onClick={() => void review()}
            disabled={problem !== null}
            title={problem ?? undefined}
            className="self-start border border-white/20 text-white disabled:pointer-events-none disabled:opacity-40"
          >
            Review request
          </AppButton>
          {problem && form.prompt.trim() && <p className="px-1 text-xs text-white/45">{problem}</p>}
        </>
      )}
      {phase.kind === 'previewing' && <p className="px-1 text-xs text-white/45">Building the request…</p>}

      {reviewed && (
        <div className="flex flex-col gap-1 rounded border border-white/15 bg-white/5 p-1.5">
          <span className="text-xs text-white/55">
            Exact request · <span className="font-mono">{reviewed.preview.endpoint}</span>
          </span>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-white/80">
            {JSON.stringify(reviewed.preview.request, null, 2)}
          </pre>
          <span className="break-all font-mono text-[11px] text-white/45">hash {reviewed.preview.hash}</span>
          <LedgerLine preview={reviewed.preview} />
          {phase.kind === 'reviewed' && (
            <div className="flex flex-wrap gap-1">
              <AppButton
                onClick={() => void approve()}
                disabled={!approved || reviewed.preview.ledgerStatus === 'submitted'}
                className="border border-white/30 bg-white/10 text-white disabled:pointer-events-none disabled:opacity-40"
              >
                {reviewed.preview.ledgerStatus === 'completed' ? 'Reuse existing (nothing sent)' : 'Approve & generate (paid)'}
              </AppButton>
              <AppButton onClick={() => dispatch({ type: 'reset' })} className="text-white">
                Cancel
              </AppButton>
            </div>
          )}
          {phase.kind === 'submitting' && <p className="text-xs text-white/55">Sending…</p>}
        </div>
      )}

      {phase.kind === 'running' && (
        <div className="flex flex-col gap-1 px-1">
          <div className="h-1.5 w-full overflow-hidden rounded bg-white/10">
            <div className="h-full bg-white/70 transition-[width]" style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }} />
          </div>
          {job ? (
            job.steps.map((step) => (
              <div key={step.key} className="flex flex-col text-xs">
                <span className={step.status === 'failed' ? 'text-red-200' : step.status === 'running' ? 'text-white/90' : 'text-white/45'}>
                  {step.label} · {step.status}
                </span>
                {step.detail && <span className="break-words text-[11px] text-white/40">{step.detail}</span>}
              </div>
            ))
          ) : (
            <p className="text-xs text-white/45">Waiting for job {phase.jobId}…</p>
          )}
          {watchError && <ErrorRow message={`Lost the job's live progress: ${watchError}`} />}
        </div>
      )}

      {phase.kind === 'error' && (
        <>
          <ErrorRow
            message={phase.stage === 'preview' ? `Could not build the request: ${phase.message}` : `Generation failed: ${phase.message}`}
          />
          <AppButton onClick={() => void review()} disabled={problem !== null} className="gap-1 self-start text-white">
            <ArrowClockwise size={12} weight="bold" />
            <span>Retry (review again)</span>
          </AppButton>
        </>
      )}
      {phase.kind === 'done' && (
        <p className="px-1 text-xs text-white/55">
          {phase.cached ? 'Already generated: reused the saved sound, nothing was sent.' : 'Generated and added to the library.'}
        </p>
      )}
      {selectError && <ErrorRow message={selectError} onDismiss={() => setSelectError(null)} />}
    </div>
  )
}

function LedgerLine({ preview }: { preview: SfxPreview }) {
  const status = (() => {
    switch (preview.ledgerStatus) {
      case 'completed':
        return <span className="text-xs text-white/80">Already generated — will reuse, nothing sent.</span>
      case 'submitted':
        return (
          <span className="text-xs text-amber-200">
            Already sent and not finished (in flight or interrupted)
            {preview.providerRef ? <>, provider ref <span className="font-mono">{preview.providerRef}</span></> : ''}
            {preview.ledgerUpdatedAt ? ` since ${preview.ledgerUpdatedAt}` : ''}. The app will not resend it automatically (the
            server answers 409), to avoid paying twice.
          </span>
        )
      case 'failed':
        return (
          <span className="text-xs text-amber-200">
            Sent before and failed{preview.ledgerError ? `: ${preview.ledgerError}` : ''}. Approving sends it again (paid).
          </span>
        )
      default:
        return <span className="text-xs text-white/55">New request: approving sends it to the provider (paid).</span>
    }
  })()
  return (
    <>
      {status}
      {preview.ledgerNote && <span className="whitespace-pre-wrap text-xs text-white/60">{preview.ledgerNote}</span>}
    </>
  )
}
