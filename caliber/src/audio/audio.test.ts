import { describe, expect, it, vi } from 'vitest'
import type { AudioTrack, SfxPreview } from '../../shared/types'
import { TEMPLATES } from '../../shared/templates'
import { planTrackRender, renderTrackBuffer, type MixContext } from './mixTrack'
import { ShotAudio, syncDecision } from './ShotAudio'
import {
  approvable,
  defaultAmbiencePrompt,
  formProblem,
  initialSfxState,
  sfxReducer,
  shortAmbientDescription,
  toRequestInput,
  type SfxState,
} from './sfxReview'
import { defaultTrackFor, gainCurve, silentTrackReason, sourcePosition, trackGainAt } from './trackMath'

const track = (patch: Partial<AudioTrack> = {}): AudioTrack => ({
  assetId: 'a1',
  volume: 0.8,
  offsetSeconds: 0,
  fadeInSeconds: 0.5,
  fadeOutSeconds: 1,
  loop: true,
  ...patch,
})

describe('trackGainAt', () => {
  it('ramps in, holds volume, ramps out', () => {
    const tr = track()
    expect(trackGainAt(tr, 0, 6)).toBe(0)
    expect(trackGainAt(tr, 0.25, 6)).toBeCloseTo(0.4)
    expect(trackGainAt(tr, 0.5, 6)).toBeCloseTo(0.8)
    expect(trackGainAt(tr, 3, 6)).toBeCloseTo(0.8)
    expect(trackGainAt(tr, 5.5, 6)).toBeCloseTo(0.4)
    expect(trackGainAt(tr, 6, 6)).toBe(0)
  })
  it('is 0 outside the shot and with no fades is flat', () => {
    expect(trackGainAt(track(), -0.1, 6)).toBe(0)
    expect(trackGainAt(track(), 6.1, 6)).toBe(0)
    const flat = track({ fadeInSeconds: 0, fadeOutSeconds: 0, volume: 1 })
    expect(trackGainAt(flat, 0, 6)).toBe(1)
    expect(trackGainAt(flat, 6, 6)).toBe(1)
  })
  it('multiplies overlapping fades on a short shot', () => {
    const tr = track({ volume: 1, fadeInSeconds: 2, fadeOutSeconds: 2 })
    expect(trackGainAt(tr, 1, 2)).toBeCloseTo(0.5 * 0.5)
  })
  it('clamps volume to 0..1', () => {
    expect(trackGainAt(track({ volume: 3, fadeInSeconds: 0, fadeOutSeconds: 0 }), 1, 6)).toBe(1)
  })
})

describe('sourcePosition', () => {
  it('adds offset and wraps when looping', () => {
    expect(sourcePosition(track({ offsetSeconds: 2 }), 1, 10)).toBe(3)
    expect(sourcePosition(track({ offsetSeconds: 2 }), 9, 10)).toBeCloseTo(1)
    expect(sourcePosition(track({ offsetSeconds: 25 }), 0, 10)).toBeCloseTo(5)
  })
  it('goes silent past the end without loop', () => {
    const tr = track({ loop: false, offsetSeconds: 2 })
    expect(sourcePosition(tr, 7.9, 10)).toBeCloseTo(9.9)
    expect(sourcePosition(tr, 8, 10)).toBeNull()
    expect(sourcePosition(tr, 0, 0)).toBeNull()
  })
})

describe('gainCurve / defaults / silence', () => {
  it('samples trackGainAt evenly over the span', () => {
    const tr = track()
    const c = gainCurve(tr, 0, 6, 6, 10)
    expect(c.length).toBe(61)
    expect(c[0]).toBe(0)
    expect(c[30]).toBeCloseTo(0.8)
    expect(c[60]).toBe(0)
    expect(gainCurve(tr, 6, 6, 6).length).toBe(2)
  })
  it('defaultTrackFor uses the spec defaults and the asset loop flag', () => {
    expect(defaultTrackFor({ id: 'x', meta: { loop: true } })).toEqual({
      assetId: 'x',
      volume: 0.8,
      offsetSeconds: 0,
      fadeInSeconds: 0.5,
      fadeOutSeconds: 1,
      loop: true,
    })
    expect(defaultTrackFor({ id: 'x', meta: {} }).loop).toBe(false)
  })
  it('flags tracks that would be silent', () => {
    expect(silentTrackReason(track({ loop: false, offsetSeconds: 10 }), 10)).toMatch(/past the end/)
    expect(silentTrackReason(track({ loop: true, offsetSeconds: 10 }), 10)).toBeNull()
    expect(silentTrackReason(track({ volume: 0 }), 10)).toMatch(/Volume is 0/)
  })
})

describe('planTrackRender / renderTrackBuffer', () => {
  it('plans an exactly shot-long stereo buffer', () => {
    const plan = planTrackRender(track({ offsetSeconds: 12 }), 10, 6, 48000)
    expect(plan.length).toBe(288000)
    expect(plan.numberOfChannels).toBe(2)
    expect(plan.startOffset).toBeCloseTo(2)
    expect(plan.loop).toBe(true)
    expect(plan.curveDuration).toBe(6)
  })
  it('refuses silent or invalid mixes instead of exporting silence', () => {
    expect(() => planTrackRender(track({ loop: false, offsetSeconds: 11 }), 10, 6)).toThrow(/silent/)
    expect(() => planTrackRender(track(), 10, 0)).toThrow(/shot duration/)
  })

  function fakeContext(renderLength: number, sampleRate: number) {
    const calls: Record<string, unknown[]> = {}
    const record = (k: string, ...args: unknown[]) => {
      calls[k] = args
    }
    const gainParam = { value: 1, setValueCurveAtTime: (...a: unknown[]) => record('curve', ...a) }
    const source = {
      buffer: null as unknown,
      loop: false,
      loopStart: -1,
      loopEnd: -1,
      connect: (n: unknown) => record('sourceConnect', n),
      start: (...a: unknown[]) => record('start', ...a),
    }
    const gain = { gain: gainParam, connect: (n: unknown) => record('gainConnect', n) }
    const destination = { name: 'dest' }
    const rendered = { length: renderLength, sampleRate } as AudioBuffer
    const ctx = {
      destination,
      createBufferSource: () => source,
      createGain: () => gain,
      startRendering: async () => rendered,
    } as unknown as MixContext
    return { ctx, calls, source, gain, destination, rendered }
  }

  it('schedules loop, offset, gain curve and checks the rendered length', async () => {
    const f = fakeContext(96000, 48000)
    const created: unknown[] = []
    const src = { duration: 10 } as AudioBuffer
    const out = await renderTrackBuffer(track({ offsetSeconds: 3 }), src, 2, 48000, {
      createContext: (o) => {
        created.push(o)
        return f.ctx
      },
    })
    expect(out).toBe(f.rendered)
    expect(created).toEqual([{ numberOfChannels: 2, length: 96000, sampleRate: 48000 }])
    expect(f.source.buffer).toBe(src)
    expect(f.source.loop).toBe(true)
    expect(f.source.loopEnd).toBe(10)
    expect(f.calls.start).toEqual([0, 3])
    const [curve, when, dur] = f.calls.curve as [Float32Array, number, number]
    expect(when).toBe(0)
    expect(dur).toBe(2)
    expect(curve[0]).toBe(0)
    expect(f.calls.gainConnect).toEqual([f.destination])
  })
  it('throws when the rendered buffer has the wrong length', async () => {
    const f = fakeContext(10, 48000)
    await expect(
      renderTrackBuffer(track(), { duration: 10 } as AudioBuffer, 2, 48000, { createContext: () => f.ctx }),
    ).rejects.toThrow(/expected 96000/)
  })
})

describe('syncDecision', () => {
  it('starts, keeps within 60 ms, restarts on drift, stops when paused', () => {
    expect(syncDecision(null, 1, false, 5)).toBe('idle')
    expect(syncDecision(null, 1, true, 5)).toBe('start')
    const v = { startCtx: 5, startShot: 1 }
    expect(syncDecision(v, 1.5, true, 5.53)).toBe('keep')
    expect(syncDecision(v, 1.5, true, 5.6)).toBe('start')
    expect(syncDecision(v, 3, true, 5.5)).toBe('start')
    expect(syncDecision(v, 1.5, false, 5.5)).toBe('stop')
  })
})

describe('ShotAudio', () => {
  function fakeAudioContext() {
    const started: unknown[][] = []
    const stopped: number[] = []
    const ctx = {
      currentTime: 0,
      state: 'running',
      destination: {},
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      createBufferSource: () => ({
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        connect: () => {},
        disconnect: () => {},
        start: (...a: unknown[]) => started.push(a),
        stop: () => stopped.push(1),
      }),
      createGain: () => ({ gain: { value: 1, setValueCurveAtTime: () => {} }, connect: () => {}, disconnect: () => {} }),
    }
    return { ctx, started, stopped }
  }

  it('plays from the right position, ignores small drift, restarts on seek, stops on pause', async () => {
    const f = fakeAudioContext()
    const player = new ShotAudio({
      createContext: () => f.ctx as unknown as AudioContext,
      decode: async () => ({ duration: 4 }) as AudioBuffer,
    })
    await player.load('/assets/x.mp3')
    player.setTrack(track({ offsetSeconds: 1 }), 6)
    player.sync(0.5, false)
    expect(f.started).toHaveLength(0)
    player.sync(0.5, true)
    expect(f.started).toEqual([[0, 1.5]])
    f.ctx.currentTime = 1
    player.sync(1.52, true) // 20 ms drift: keep
    expect(f.started).toHaveLength(1)
    player.sync(4, true) // seek: restart at (1 + 4) mod 4 = 1
    expect(f.started[1]).toEqual([1, 1])
    player.sync(4, false)
    expect(f.stopped.length).toBeGreaterThanOrEqual(2)
  })
})

describe('sfx review reducer (money rule)', () => {
  const preview = (hash: string): SfxPreview => ({
    endpoint: 'fal-ai/elevenlabs/sound-effects/v2',
    request: {},
    hash,
    ledgerStatus: 'new',
    existingAssets: [],
  })
  const reviewed = (): SfxState => {
    let s = initialSfxState('ambient environment, loop of rain')
    const input = toRequestInput(s.form)
    s = sfxReducer(s, { type: 'previewStart', input })
    return sfxReducer(s, { type: 'previewOk', input, preview: preview('h1') })
  }

  it('only allows approval of the reviewed request', () => {
    const s = initialSfxState('x')
    expect(approvable(s)).toBeNull()
    expect(sfxReducer(s, { type: 'approve' })).toBe(s)
    const r = reviewed()
    expect(approvable(r)).toEqual({ input: toRequestInput(r.form), hash: 'h1' })
  })
  it('any edit after review invalidates it', () => {
    for (const patch of [{ prompt: 'other' }, { durationSeconds: 5 }, { loop: false }, { promptInfluence: 0.9 }]) {
      const s = sfxReducer(reviewed(), { type: 'edit', patch })
      expect(s.phase.kind).toBe('editing')
      expect(approvable(s)).toBeNull()
      expect(sfxReducer(s, { type: 'approve' }).phase.kind).toBe('editing')
    }
  })
  it('drops a preview that comes back for an outdated form', () => {
    let s = initialSfxState('a')
    const input = toRequestInput(s.form)
    s = sfxReducer(s, { type: 'previewStart', input })
    s = sfxReducer(s, { type: 'previewOk', input: { ...input, prompt: 'b' }, preview: preview('h2') })
    expect(s.phase.kind).toBe('previewing')
  })
  it('locks the form while sending and walks submitting -> running -> done', () => {
    let s = sfxReducer(reviewed(), { type: 'approve' })
    expect(s.phase.kind).toBe('submitting')
    expect(sfxReducer(s, { type: 'edit', patch: { prompt: 'z' } })).toBe(s)
    s = sfxReducer(s, { type: 'jobStarted', jobId: 'j1' })
    expect(s.phase).toMatchObject({ kind: 'running', jobId: 'j1' })
    s = sfxReducer(s, { type: 'finished', assets: [], cached: false })
    expect(s.phase.kind).toBe('done')
  })
  it('failure is an error that needs a fresh review', () => {
    let s = sfxReducer(reviewed(), { type: 'approve' })
    s = sfxReducer(s, { type: 'failed', message: 'HTTP 409: not the one you approved' })
    expect(s.phase).toEqual({ kind: 'error', message: 'HTTP 409: not the one you approved', stage: 'generate' })
    expect(approvable(s)).toBeNull()
  })
  it('seeds the prompt only until the user types', () => {
    let s = sfxReducer(initialSfxState('a'), { type: 'seedPrompt', prompt: 'b' })
    expect(s.form.prompt).toBe('b')
    s = sfxReducer(s, { type: 'edit', patch: { prompt: 'mine' } })
    expect(sfxReducer(s, { type: 'seedPrompt', prompt: 'c' }).form.prompt).toBe('mine')
    expect(sfxReducer(reviewed(), { type: 'seedPrompt', prompt: 'c' }).phase.kind).toBe('reviewed')
  })
  it('validates the form', () => {
    expect(formProblem({ prompt: ' ', durationSeconds: 10, loop: true, promptInfluence: 0.3 })).toMatch(/prompt/)
    expect(formProblem({ prompt: 'x', durationSeconds: 30, loop: true, promptInfluence: 0.3 })).toMatch(/0.5 and 22/)
    expect(formProblem({ prompt: 'x', durationSeconds: NaN, loop: true, promptInfluence: 0.3 })).toMatch(/0.5 and 22/)
    expect(formProblem({ prompt: 'x', durationSeconds: 10, loop: true, promptInfluence: 0.3 })).toBeNull()
  })
})

describe('defaultAmbiencePrompt', () => {
  it("uses the template's ambiencePrompt when the preset's templateId matches", () => {
    const t = TEMPLATES[0]
    expect(defaultAmbiencePrompt({ templateId: t.id, prompts: { world: 'ignored' } })).toBe(t.ambiencePrompt)
  })
  it('builds one from the world prompt otherwise', () => {
    expect(
      defaultAmbiencePrompt({ templateId: null, prompts: { world: 'A quiet stone courtyard at dusk. Empty, no people.' } }),
    ).toBe('ambient environment, loop of a quiet stone courtyard at dusk, no music, no voices')
    expect(defaultAmbiencePrompt({ templateId: 'unknown', prompts: {} })).toMatch(/no music, no voices$/)
    expect(defaultAmbiencePrompt(null)).toMatch(/^ambient environment, loop of/)
  })
  it('shortens long descriptions at a word boundary', () => {
    const s = shortAmbientDescription('word '.repeat(60))
    expect(s.length).toBeLessThanOrEqual(110)
    expect(s.endsWith(' ')).toBe(false)
  })
})
