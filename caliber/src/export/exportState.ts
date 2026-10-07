// Pure state machine for ExportPanel. No React, no DOM — unit tested in exportState.test.ts.
import type { Asset } from '../../shared/types'

export type ExportPhase =
  | { kind: 'idle' }
  | { kind: 'rendering'; frame: number; frameCount: number; startedAt: number }
  | { kind: 'saving'; frameCount: number }
  | { kind: 'done'; asset: Asset; downloadName: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

export type ExportAction =
  | { type: 'start'; frameCount: number; now: number }
  | { type: 'frame'; frame: number }
  | { type: 'encoded' }
  | { type: 'saved'; asset: Asset; downloadName: string }
  | { type: 'cancelled' }
  | { type: 'failed'; message: string }
  | { type: 'reset' }

export const initialExportPhase: ExportPhase = { kind: 'idle' }

export const isBusy = (p: ExportPhase) => p.kind === 'rendering' || p.kind === 'saving'

export function exportReducer(state: ExportPhase, action: ExportAction): ExportPhase {
  switch (action.type) {
    case 'start':
      if (isBusy(state)) return state
      return { kind: 'rendering', frame: 0, frameCount: action.frameCount, startedAt: action.now }
    case 'frame':
      if (state.kind !== 'rendering') return state
      return { ...state, frame: Math.min(state.frameCount, Math.max(state.frame, action.frame)) }
    case 'encoded':
      if (state.kind !== 'rendering') return state
      return { kind: 'saving', frameCount: state.frameCount }
    case 'saved':
      if (state.kind !== 'saving') return state
      return { kind: 'done', asset: action.asset, downloadName: action.downloadName }
    case 'cancelled':
      if (!isBusy(state)) return state
      return { kind: 'cancelled' }
    case 'failed':
      if (!isBusy(state)) return state
      return { kind: 'error', message: action.message }
    case 'reset':
      return isBusy(state) ? state : initialExportPhase
  }
}

/** Seconds left at the current average frame rate; null until one frame is done. */
export function etaSeconds(state: ExportPhase, now: number): number | null {
  if (state.kind !== 'rendering' || state.frame <= 0) return null
  const perFrame = (now - state.startedAt) / 1000 / state.frame
  return Math.max(0, perFrame * (state.frameCount - state.frame))
}

export function formatEta(seconds: number | null): string {
  if (seconds === null) return 'estimating…'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s left`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s left`
}

export type EncoderSupport = { status: 'checking' } | { status: 'ok' } | { status: 'unsupported'; message: string }

/** Why "Download video" is disabled, or null when it can run. Order = what the user should fix first. */
export function blockedReason(o: { hasShot: boolean; hasHandle: boolean; support: EncoderSupport }): string | null {
  if (!o.hasShot) return 'Pick a camera move first'
  if (!o.hasHandle) return 'Viewer not ready'
  if (o.support.status === 'checking') return 'Checking video encoder support…'
  if (o.support.status === 'unsupported') return o.support.message
  return null
}

export function slugPart(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'export'
  )
}

/** caliber-<label>-<format>.mp4 */
export function downloadFilename(label: string, format: string): string {
  return `caliber-${slugPart(label)}-${slugPart(format)}.mp4`
}

/** The on-disk location relative to the project root, for display. */
export function savedPath(asset: Pick<Asset, 'key'>): string {
  return `data/${asset.key}`
}
