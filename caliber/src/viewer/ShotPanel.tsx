import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Camera, Pause, Play, Plus, Stop, Trash, ArrowsClockwise } from '@phosphor-icons/react'
import { twMerge } from 'tailwind-merge'
import type { CameraKey, CameraMove, CameraShot, Easing } from '../../shared/types'
import {
  MAX_DURATION_SECONDS,
  MIN_DURATION_SECONDS,
  MOVE_DEFAULTS,
  FULL_TURN_DEGREES,
  buildShot,
  insertKey,
  removeKey,
  retimeShot,
  setKey,
  validateShot,
} from '../camera'
import { chrome } from '../components/AppChrome'
import type { ShotClock } from './shotClock'
import { DEFAULT_SHOT_DOF, MAX_APERTURE_DEGREES, MIN_APERTURE_DEGREES } from './look'
import type { CameraView, ShotRigApi } from './ShotRig'

type PresetMove = Exclude<CameraMove, 'custom'>

const MOVES: { id: PresetMove; label: string }[] = [
  { id: 'push-in', label: 'Push in' },
  { id: 'pull-out', label: 'Pull out' },
  { id: 'orbit-arc', label: 'Orbit arc' },
  { id: 'slide', label: 'Slide' },
  { id: 'crane', label: 'Crane' },
  { id: 'focus-pull', label: 'Focus pull' },
]

/** Slider range + readout per move. Units follow MOVE_DEFAULTS in src/camera/moves.ts. */
const AMOUNT: Record<PresetMove, { min: number; max: number; step: number; format: (v: number) => string } | null> = {
  'push-in': { min: 0.05, max: 0.9, step: 0.01, format: (v) => `${Math.round(v * 100)}% of distance` },
  'pull-out': { min: 0.05, max: 0.9, step: 0.01, format: (v) => `${Math.round(v * 100)}% of distance` },
  'orbit-arc': { min: 10, max: 360, step: 1, format: (v) => `${Math.round(v)}° sweep` },
  slide: { min: 0.005, max: 0.3, step: 0.005, format: (v) => `${(v * 100).toFixed(1)} cm travel` },
  crane: { min: 0.005, max: 0.2, step: 0.005, format: (v) => `${(v * 100).toFixed(1)} cm rise` },
  'focus-pull': null,
}

/** Direction labels; null = the move has no direction. */
const DIRECTION: Record<PresetMove, [string, string] | null> = {
  'push-in': null,
  'pull-out': null,
  'orbit-arc': ['↺ Counter-clockwise', '↻ Clockwise'],
  slide: ['Right →', '← Left'],
  crane: ['Down ↓', 'Up ↑'],
  'focus-pull': ['Background → Watch', 'Watch → Background'],
}

const EASINGS: { id: Easing; label: string }[] = [
  { id: 'ease-in-out', label: 'Ease in-out' },
  { id: 'ease-out', label: 'Ease out' },
  { id: 'linear', label: 'Linear' },
]

const clean = (msg: string) => msg.replace(/^buildShot: /, '')
const errMsg = (e: unknown) => clean(e instanceof Error ? e.message : String(e))
const fmt = (t: number) => `${t.toFixed(1)}s`

export interface ShotPanelProps {
  shot: CameraShot | null
  /** `settle` = a slider tick; the owner may debounce reporting it. */
  onShotChange: (shot: CameraShot | null, settle?: boolean) => void
  clock: ShotClock
  rig: () => ShotRigApi | null
  /**
   * Focus pull: distance from the hero camera to the background surface behind the target
   * (collider raycast), or null when there is none.
   */
  backgroundDistance?: (hero: CameraShot['hero']) => number | null
}

function Btn({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={twMerge(
        chrome.row,
        'h-7 px-2 text-xs text-white',
        active ? chrome.rowActive : chrome.rowIdle,
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:opacity-40',
      )}
    >
      {children}
    </button>
  )
}

/** Camera move editor + preview transport, rendered along the bottom of the canvas. */
export function ShotPanel({ shot, onShotChange, clock, rig, backgroundDistance }: ShotPanelProps) {
  // DOF is saved on the shot; regenerated shots (move/amount/hero changes) keep it.
  const dof = shot?.dof ?? DEFAULT_SHOT_DOF
  const setDof = (next: CameraShot['dof'], settle = false) => {
    if (shot) onShotChange({ ...shot, dof: next }, settle)
  }
  const clockState = useSyncExternalStore(clock.subscribe, clock.get)
  const [error, setError] = useState<string | null>(null)
  const [focusNote, setFocusNote] = useState<string | null>(null)
  /** buildShot options for the background end of a focus pull (raycast each build; the shot doesn't store it). */
  const focusOpts = (move: PresetMove, hero: CameraShot['hero']) => {
    if (move !== 'focus-pull') {
      setFocusNote(null)
      return {}
    }
    const d = backgroundDistance?.(hero) ?? null
    setFocusNote(d === null ? 'No background surface found — using 2× distance' : null)
    return d === null ? {} : { backgroundFocusDistance: d }
  }
  const [selectedKey, setSelectedKey] = useState<number | null>(null)
  const [durationDraft, setDurationDraft] = useState(String(shot?.durationSeconds ?? 8))
  useEffect(() => setDurationDraft(String(shot?.durationSeconds ?? 8)), [shot?.durationSeconds])
  useEffect(() => {
    if (selectedKey !== null && (!shot || selectedKey >= shot.keys.length)) setSelectedKey(null)
  }, [shot, selectedKey])

  const problems = shot ? validateShot(shot) : []
  const duration = shot?.durationSeconds ?? 0
  const presetMove = shot && shot.move !== 'custom' ? shot.move : null
  const amountSpec = presetMove ? AMOUNT[presetMove] : null
  const dirLabels = presetMove ? DIRECTION[presetMove] : null

  /** Run an edit; show its error instead of applying when it throws. */
  const attempt = (fn: () => CameraShot | null, settle = false) => {
    try {
      let next = fn()
      if (next && shot?.dof && !next.dof) next = { ...next, dof: shot.dof }
      setError(null)
      onShotChange(next, settle)
      return next
    } catch (e) {
      setError(errMsg(e))
      return null
    }
  }

  const rebuild = (move: PresetMove, over: { amount?: number; direction?: 1 | -1; durationSeconds?: number } = {}, settle = false) => {
    if (!shot) return
    attempt(
      () =>
        buildShot(shot.hero, move, {
          amount: over.amount ?? (move === shot.move ? shot.amount : MOVE_DEFAULTS[move]),
          direction: over.direction ?? shot.direction,
          durationSeconds: over.durationSeconds ?? shot.durationSeconds,
          easing: shot.easing,
          ...focusOpts(move, shot.hero),
        }),
      settle,
    )
  }

  const setHero = () => {
    const api = rig()
    const view = api?.freeView()
    if (!view) {
      setError('The camera is not ready yet.')
      return
    }
    if (clock.get().previewing) clock.stop()
    const move: PresetMove = presetMove ?? 'push-in'
    attempt(() =>
      buildShot(view, move, {
        amount: shot && shot.move === move ? shot.amount : MOVE_DEFAULTS[move],
        direction: shot?.direction ?? 1,
        durationSeconds: shot?.durationSeconds,
        easing: shot?.easing,
        ...focusOpts(move, view),
      }),
    )
    clock.cue(0)
    setSelectedKey(null)
  }

  const commitDuration = () => {
    if (!shot) return
    const d = Number(durationDraft)
    if (durationDraft.trim() === '' || !Number.isFinite(d)) {
      setError(`Duration must be a number between ${MIN_DURATION_SECONDS} and ${MAX_DURATION_SECONDS} seconds`)
      return
    }
    if (d === shot.durationSeconds) return
    // Show exactly what validateShot says about the proposed duration.
    const proposed = validateShot({ ...shot, durationSeconds: d, keys: shot.keys.map((k, i, a) => (i === a.length - 1 ? { ...k, t: d } : k)) })
    const durationProblem = proposed.find((p) => p.startsWith('Duration'))
    if (durationProblem) {
      setError(durationProblem)
      return
    }
    if (shot.move === 'custom') attempt(() => retimeShot(shot, d))
    else rebuild(shot.move, { durationSeconds: d })
    if (clock.get().time > d) clock.cue(d)
  }

  const jumpToKey = (i: number) => {
    if (!shot) return
    const k = shot.keys[i]
    clock.stop(false)
    rig()?.setFreeView({ position: k.position, target: k.target, fov: k.fov })
    clock.cue(k.t)
    setSelectedKey(i)
    setError(null)
  }

  const updateKeyFromView = () => {
    if (!shot || selectedKey === null) return
    const view: CameraView | null | undefined = rig()?.currentView()
    if (!view) {
      setError('The camera is not ready yet.')
      return
    }
    const old = shot.keys[selectedKey]
    const key: CameraKey = { t: old.t, position: view.position, target: view.target, fov: view.fov }
    if (old.focusDistance !== undefined) key.focusDistance = old.focusDistance
    attempt(() => setKey(shot, selectedKey, key))
  }

  const addKey = () => {
    if (!shot) return
    const t = Math.round(clockState.time * 1000) / 1000
    const next = attempt(() => insertKey(shot, t))
    if (next) setSelectedKey(next.keys.findIndex((k) => k.t === t))
  }

  const deleteKey = () => {
    if (!shot || selectedKey === null) return
    if (attempt(() => removeKey(shot, selectedKey))) setSelectedKey(null)
  }

  const playing = clockState.playing
  const time = Math.min(clockState.time, duration)

  return (
    <div
      className={twMerge(chrome.panel, 'absolute inset-x-3 bottom-3 z-20 flex flex-col gap-1 p-1 text-xs text-white')}
      data-testid="shot-panel"
    >
      {/* Row 1: hero + move */}
      <div className="flex flex-wrap items-center gap-1">
        <Btn onClick={setHero} title="Capture the current camera position, target and field of view as the hero framing">
          <Camera size={14} /> {shot ? 'Reset hero to current view' : 'Set as hero shot'}
        </Btn>
        <span className={chrome.divider} />
        {MOVES.map((m) => (
          <Btn
            key={m.id}
            active={shot?.move === m.id}
            disabled={!shot}
            title={shot ? undefined : 'Set a hero shot first'}
            onClick={() => rebuild(m.id)}
          >
            {m.label}
          </Btn>
        ))}
        <Btn
          disabled={!shot}
          title={shot ? 'Full 360° orbit around the watch, 12 s, linear (seamless loop)' : 'Set a hero shot first'}
          active={!!shot && shot.move === 'orbit-arc' && shot.amount >= FULL_TURN_DEGREES}
          onClick={() => {
            if (!shot) return
            attempt(() =>
              buildShot(shot.hero, 'orbit-arc', {
                amount: FULL_TURN_DEGREES,
                direction: shot.direction,
                durationSeconds: 12,
                easing: 'linear',
              }),
            )
          }}
        >
          360° spin
        </Btn>
        <div className="ml-auto flex items-center gap-1" title="Depth of field. Focus follows the shot while previewing, otherwise the orbit target (the watch).">
          <span className="px-1 text-white/55">Depth of field</span>
          <Btn active={dof.enabled} disabled={!shot} title={shot ? undefined : 'Set a hero shot first'} onClick={() => setDof({ ...dof, enabled: !dof.enabled })}>
            {dof.enabled ? 'On' : 'Off'}
          </Btn>
          <input
            type="range"
            min={MIN_APERTURE_DEGREES}
            max={MAX_APERTURE_DEGREES}
            step={0.1}
            value={dof.apertureDegrees}
            disabled={!shot || !dof.enabled}
            onChange={(e) => setDof({ ...dof, apertureDegrees: Number(e.target.value) }, true)}
            className="w-24 accent-white disabled:opacity-40"
            aria-label="Aperture"
          />
          <span className="w-20 font-mono tabular-nums text-white/80">
            aperture {dof.apertureDegrees.toFixed(1)}°
          </span>
        </div>
        {shot?.move === 'custom' && (
          <span className="rounded bg-white/15 px-2 py-1 text-white" title="Keys were edited by hand; pick a move to regenerate from the hero">
            Custom
          </span>
        )}
      </div>

      {/* Row 2: move parameters */}
      {shot && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2">
          {amountSpec && presetMove && (
            <label className="flex items-center gap-2">
              <span className="text-white/55">Amount</span>
              <input
                type="range"
                min={amountSpec.min}
                max={amountSpec.max}
                step={amountSpec.step}
                value={shot.amount}
                onChange={(e) => rebuild(presetMove, { amount: Number(e.target.value) }, true)}
                className="w-32 accent-white"
              />
              <span className="w-28 font-mono tabular-nums">{amountSpec.format(shot.amount)}</span>
            </label>
          )}
          {dirLabels && presetMove && (
            <div className="flex items-center gap-1">
              <span className="text-white/55">Direction</span>
              <Btn active={shot.direction === 1} onClick={() => rebuild(presetMove, { direction: 1 })}>
                {dirLabels[0]}
              </Btn>
              <Btn active={shot.direction === -1} onClick={() => rebuild(presetMove, { direction: -1 })}>
                {dirLabels[1]}
              </Btn>
            </div>
          )}
          {shot.move === 'focus-pull' && !dof.enabled && (
            <span className="text-white/55">Depth of field is off, so the focus pull is not visible.</span>
          )}
          {shot.move === 'focus-pull' && focusNote && <span className="text-amber-200/80">{focusNote}</span>}
          {shot.move === 'orbit-arc' && shot.amount >= FULL_TURN_DEGREES && shot.easing === 'linear' && (
            <span className="text-white/55" title="Starts and ends on the hero at the same speed; export renders [0, duration) so the hero frame isn't doubled">
              loops seamlessly
            </span>
          )}
          <label className="flex items-center gap-2">
            <span className="text-white/55">Duration</span>
            <input
              type="number"
              min={MIN_DURATION_SECONDS}
              max={MAX_DURATION_SECONDS}
              step={0.5}
              value={durationDraft}
              onChange={(e) => setDurationDraft(e.target.value)}
              onBlur={commitDuration}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitDuration()
              }}
              className="w-16 rounded border border-white/15 bg-black/40 px-1 py-0.5 font-mono text-white"
              aria-label="Duration in seconds"
            />
            <span className="text-white/55">s</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-white/55">Easing</span>
            <select
              value={shot.easing}
              onChange={(e) => attempt(() => ({ ...shot, easing: e.target.value as Easing }))}
              className="rounded border border-white/15 bg-black/40 px-1 py-0.5 text-white"
            >
              {EASINGS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Row 3: transport + timeline */}
      {shot && (
        <div className="flex items-center gap-1">
          <Btn
            onClick={() => (playing ? clock.pause() : clock.play(shot.durationSeconds))}
            disabled={problems.length > 0}
            title={playing ? 'Pause' : 'Play the shot'}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}
          </Btn>
          <Btn onClick={() => clock.stop()} disabled={!clockState.previewing} title="Stop preview and return to the free camera">
            <Stop size={14} /> Stop
          </Btn>
          <div className="relative mx-2 flex-1">
            <input
              type="range"
              min={0}
              max={duration}
              step={0.01}
              value={time}
              disabled={problems.length > 0}
              onChange={(e) => {
                clock.seek(Number(e.target.value))
                setSelectedKey(null)
              }}
              className="relative z-10 w-full accent-white"
              aria-label="Shot timeline"
            />
            {/* Key markers */}
            <div className="pointer-events-none absolute inset-x-0 -bottom-1 h-2">
              {shot.keys.map((k, i) => (
                <span
                  key={i}
                  className={twMerge(
                    'absolute h-2 w-1 -translate-x-1/2 rounded-sm',
                    i === selectedKey ? 'bg-white' : 'bg-white/45',
                  )}
                  style={{ left: `${duration > 0 ? (k.t / duration) * 100 : 0}%` }}
                />
              ))}
            </div>
          </div>
          <span className="w-24 text-right font-mono tabular-nums text-white/80">
            {fmt(time)} / {fmt(duration)}
          </span>
        </div>
      )}

      {/* Row 4: keys */}
      {shot && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="px-1 text-white/55">Jump to key</span>
          {shot.keys.map((k, i) => (
            <Btn key={i} active={i === selectedKey} onClick={() => jumpToKey(i)} title={`Put the camera at key ${i + 1} so you can adjust it`}>
              {i + 1} · {fmt(k.t)}
            </Btn>
          ))}
          <span className={chrome.divider} />
          <Btn
            onClick={updateKeyFromView}
            disabled={selectedKey === null}
            title={selectedKey === null ? 'Jump to a key first' : `Replace key ${selectedKey + 1} with the current camera view`}
          >
            <ArrowsClockwise size={14} /> Update key from current view
          </Btn>
          <Btn
            onClick={addKey}
            disabled={time <= 0 || time >= duration}
            title="Insert a key at the playhead (the pose the shot shows there)"
          >
            <Plus size={14} /> Add key at playhead
          </Btn>
          <Btn
            onClick={deleteKey}
            disabled={selectedKey === null || selectedKey === 0 || selectedKey === shot.keys.length - 1}
            title="Delete the selected inner key (first and last keys stay)"
          >
            <Trash size={14} /> Delete key
          </Btn>
        </div>
      )}

      {!shot && <div className="px-2 pb-1 text-white/55">Frame the watch with the orbit camera, then set it as the hero shot.</div>}
      {(error || problems.length > 0) && (
        <div role="alert" className="flex flex-col gap-0.5 border-t border-white/10 px-2 py-1 text-red-300">
          {error && <div>{error}</div>}
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
    </div>
  )
}
