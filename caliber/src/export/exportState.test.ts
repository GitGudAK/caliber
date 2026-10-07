import { describe, expect, it } from 'vitest'
import type { Asset } from '../../shared/types'
import {
  blockedReason,
  downloadFilename,
  etaSeconds,
  exportReducer,
  formatEta,
  initialExportPhase,
  savedPath,
  type ExportPhase,
} from './exportState'

const asset = { id: 'a', key: 'exports/p/2026-x-push-in.mp4' } as Asset
const run = (...actions: Parameters<typeof exportReducer>[1][]) => actions.reduce(exportReducer, initialExportPhase)

describe('exportReducer', () => {
  it('walks the happy path idle -> rendering -> saving -> done', () => {
    let s: ExportPhase = run({ type: 'start', frameCount: 60, now: 1000 })
    expect(s).toEqual({ kind: 'rendering', frame: 0, frameCount: 60, startedAt: 1000 })
    s = exportReducer(s, { type: 'frame', frame: 30 })
    expect(s).toMatchObject({ kind: 'rendering', frame: 30 })
    s = exportReducer(s, { type: 'encoded' })
    expect(s).toEqual({ kind: 'saving', frameCount: 60 })
    s = exportReducer(s, { type: 'saved', asset, downloadName: 'x.mp4' })
    expect(s).toEqual({ kind: 'done', asset, downloadName: 'x.mp4' })
  })

  it('clamps frames and never goes backwards', () => {
    const s = run({ type: 'start', frameCount: 10, now: 0 }, { type: 'frame', frame: 7 }, { type: 'frame', frame: 3 })
    expect(s).toMatchObject({ frame: 7 })
    expect(exportReducer(s, { type: 'frame', frame: 99 })).toMatchObject({ frame: 10 })
  })

  it('cancel from rendering or saving, but not from idle/done', () => {
    expect(run({ type: 'start', frameCount: 10, now: 0 }, { type: 'cancelled' })).toEqual({ kind: 'cancelled' })
    expect(run({ type: 'start', frameCount: 10, now: 0 }, { type: 'encoded' }, { type: 'cancelled' })).toEqual({
      kind: 'cancelled',
    })
    expect(run({ type: 'cancelled' })).toEqual(initialExportPhase)
  })

  it('failure keeps the real message', () => {
    expect(run({ type: 'start', frameCount: 10, now: 0 }, { type: 'failed', message: 'boom 413' })).toEqual({
      kind: 'error',
      message: 'boom 413',
    })
  })

  it('ignores start and reset while busy; reset clears terminal states', () => {
    const busy = run({ type: 'start', frameCount: 10, now: 0 }, { type: 'frame', frame: 2 })
    expect(exportReducer(busy, { type: 'start', frameCount: 99, now: 5 })).toBe(busy)
    expect(exportReducer(busy, { type: 'reset' })).toBe(busy)
    expect(exportReducer({ kind: 'cancelled' }, { type: 'reset' })).toEqual(initialExportPhase)
    // A new export can start after a terminal state.
    expect(exportReducer({ kind: 'error', message: 'x' }, { type: 'start', frameCount: 3, now: 0 }).kind).toBe('rendering')
  })

  it('ignores out-of-order events', () => {
    expect(run({ type: 'encoded' })).toEqual(initialExportPhase)
    expect(run({ type: 'saved', asset, downloadName: 'x' })).toEqual(initialExportPhase)
    expect(run({ type: 'start', frameCount: 3, now: 0 }, { type: 'saved', asset, downloadName: 'x' }).kind).toBe('rendering')
  })
})

describe('eta', () => {
  it('is null before the first frame, then extrapolates the average', () => {
    const s = run({ type: 'start', frameCount: 100, now: 0 })
    expect(etaSeconds(s, 5000)).toBeNull()
    expect(etaSeconds(exportReducer(s, { type: 'frame', frame: 25 }), 10_000)).toBeCloseTo(30)
    expect(formatEta(null)).toBe('estimating…')
    expect(formatEta(42.4)).toBe('42s left')
    expect(formatEta(125)).toBe('2m 05s left')
  })
})

describe('blockedReason', () => {
  const ok = { status: 'ok' } as const
  it('explains in priority order', () => {
    expect(blockedReason({ hasShot: false, hasHandle: false, support: ok })).toBe('Pick a camera move first')
    expect(blockedReason({ hasShot: true, hasHandle: false, support: ok })).toBe('Viewer not ready')
    expect(blockedReason({ hasShot: true, hasHandle: true, support: { status: 'unsupported', message: 'No H.264 here' } })).toBe(
      'No H.264 here',
    )
    expect(blockedReason({ hasShot: true, hasHandle: true, support: ok })).toBeNull()
  })
})

describe('names', () => {
  it('builds caliber-<label>-<format>.mp4 and the on-disk path', () => {
    expect(downloadFilename('orbit-arc', 'vertical-1080x1920-30')).toBe('caliber-orbit-arc-vertical-1080x1920-30.mp4')
    expect(savedPath(asset)).toBe('data/exports/p/2026-x-push-in.mp4')
  })
})
