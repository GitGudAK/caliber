import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ExportUnsupportedError,
  assertEncodable,
  computeFrameTimings,
  exportMp4,
  frameTimestamp,
  validateExportOptions,
  type BackendConfig,
  type EncoderCapabilities,
  type ExportBackend,
  type ExportMp4Options,
} from './exportMp4'
import { DEFAULT_EXPORT_PRESET_ID, EXPORT_PRESETS, getExportPreset } from './presets'

const yes: EncoderCapabilities = { canEncodeVideo: async () => true, canEncodeAudio: async () => true }

function fakeAudio(numberOfChannels = 2, sampleRate = 48000, seconds = 1): AudioBuffer {
  return { numberOfChannels, sampleRate, length: seconds * sampleRate, duration: seconds } as unknown as AudioBuffer
}

function fakeBackend() {
  const log: string[] = []
  const frames: Array<[number, number]> = []
  let cfg: BackendConfig | undefined
  const backend: ExportBackend = {
    start: async () => void log.push('start'),
    addAudio: async () => void log.push('audio'),
    addFrame: async (t, d) => void frames.push([t, d]),
    finalize: async () => {
      log.push('finalize')
      return new Blob(['mp4'], { type: 'video/mp4' })
    },
    cancel: async () => void log.push('cancel'),
  }
  return {
    log,
    frames,
    get cfg() {
      return cfg
    },
    create: (c: BackendConfig) => {
      cfg = c
      return backend
    },
  }
}

function baseOptions(over: Partial<ExportMp4Options> = {}): ExportMp4Options {
  return {
    canvas: { width: 640, height: 360 } as HTMLCanvasElement,
    width: 640,
    height: 360,
    fps: 30,
    durationSeconds: 1,
    renderFrame: () => {},
    ...over,
  }
}

beforeEach(() => {
  vi.stubGlobal('VideoEncoder', class {})
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('frame timing math', () => {
  it('computes exact frame counts', () => {
    expect(computeFrameTimings(30, 2).frameCount).toBe(60)
    expect(computeFrameTimings(60, 2).frameCount).toBe(120)
    expect(computeFrameTimings(30, 10).frameCount).toBe(300)
    expect(computeFrameTimings(24, 1).frameCount).toBe(24)
  })

  it('is robust to floating point in duration*fps', () => {
    // 0.1*30 = 3.0000000000000004 in floats; must still be 3 frames, not 4.
    expect(computeFrameTimings(30, 0.1).frameCount).toBe(3)
    expect(computeFrameTimings(60, 0.7).frameCount).toBe(42)
  })

  it('rounds partial frames up so the video is never shorter than requested', () => {
    const t = computeFrameTimings(30, 1.01)
    expect(t.frameCount).toBe(31)
    expect(t.totalDuration).toBeGreaterThanOrEqual(1.01)
  })

  it('gives every frame duration 1/fps and timestamps i/fps without drift', () => {
    const { frameCount, frameDuration } = computeFrameTimings(60, 10)
    expect(frameDuration).toBeCloseTo(1 / 60, 12)
    expect(frameTimestamp(0, 60)).toBe(0)
    expect(frameTimestamp(599, 60)).toBe(599 / 60)
    expect(frameTimestamp(frameCount - 1, 60) + frameDuration).toBeCloseTo(10, 9)
  })

  it('rejects invalid fps / duration', () => {
    expect(() => computeFrameTimings(0, 1)).toThrow(/fps/)
    expect(() => computeFrameTimings(30, 0)).toThrow(/durationSeconds/)
    expect(() => computeFrameTimings(NaN, 1)).toThrow(/fps/)
  })

  it('validates even dimensions and bitrate', () => {
    expect(() => validateExportOptions({ width: 641, height: 360, fps: 30, durationSeconds: 1 })).toThrow(/width must be even/)
    expect(() => validateExportOptions({ width: 640, height: 0, fps: 30, durationSeconds: 1 })).toThrow(/height/)
    expect(() => validateExportOptions({ width: 640, height: 360, fps: 30, durationSeconds: 1, bitrate: -1 })).toThrow(/bitrate/)
    expect(() => validateExportOptions({ width: 640, height: 360, fps: 30, durationSeconds: 1 })).not.toThrow()
  })
})

describe('presets', () => {
  it('are valid, even-sized, unique, and cover the three aspect ratios at 30 and 60 fps', () => {
    const ids = new Set(EXPORT_PRESETS.map((p) => p.id))
    expect(ids.size).toBe(EXPORT_PRESETS.length)
    for (const p of EXPORT_PRESETS) {
      expect(() => validateExportOptions({ ...p, durationSeconds: 1 })).not.toThrow()
      expect([30, 60]).toContain(p.fps)
    }
    const shapes = (w: number, h: number) => EXPORT_PRESETS.filter((p) => p.width === w && p.height === h).map((p) => p.fps).sort()
    expect(shapes(1080, 1080)).toEqual([30, 60])
    expect(shapes(1080, 1920)).toEqual([30, 60])
    expect(shapes(1920, 1080)).toEqual([30, 60])
    expect(getExportPreset(DEFAULT_EXPORT_PRESET_ID).id).toBe(DEFAULT_EXPORT_PRESET_ID)
  })
})

describe('capability checks', () => {
  it('names H.264 and the size when video is not encodable', async () => {
    const caps: EncoderCapabilities = { canEncodeVideo: async () => false, canEncodeAudio: async () => true }
    const p = assertEncodable(caps, { width: 1920, height: 1080 })
    await expect(p).rejects.toBeInstanceOf(ExportUnsupportedError)
    await expect(assertEncodable(caps, { width: 1920, height: 1080 })).rejects.toThrow(/H\.264 \(avc\).*1920x1080/)
  })

  it('names AAC and refuses to drop audio when audio is not encodable', async () => {
    const caps: EncoderCapabilities = { canEncodeVideo: async () => true, canEncodeAudio: async () => false }
    await expect(assertEncodable(caps, { width: 640, height: 360, audio: { numberOfChannels: 6, sampleRate: 96000 } })).rejects.toThrow(
      /AAC.*6 channel\(s\) at 96000 Hz.*rather than dropping the audio/,
    )
    // Without audio the same caps pass.
    await expect(assertEncodable(caps, { width: 640, height: 360 })).resolves.toBeUndefined()
  })

  it('reports missing WebCodecs clearly', async () => {
    vi.unstubAllGlobals()
    if (typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined') return // env has WebCodecs
    await expect(assertEncodable(yes, { width: 640, height: 360 })).rejects.toThrow(/WebCodecs/)
  })
})

describe('exportMp4 orchestration (fake backend)', () => {
  it('renders each frame at exact times, then captures with exact timestamp/duration', async () => {
    const fb = fakeBackend()
    const renders: Array<[number, number]> = []
    const progress: number[] = []
    const blob = await exportMp4(
      baseOptions({ fps: 30, durationSeconds: 2, renderFrame: (t, i) => void renders.push([t, i]), onProgress: (f) => progress.push(f) }),
      { capabilities: yes, createBackend: fb.create },
    )
    expect(blob.type).toBe('video/mp4')
    expect(renders).toHaveLength(60)
    expect(fb.frames).toHaveLength(60)
    renders.forEach(([t, i], k) => {
      expect(i).toBe(k)
      expect(t).toBe(k / 30)
      expect(fb.frames[k]).toEqual([k / 30, 1 / 30])
    })
    expect(fb.log).toEqual(['start', 'finalize'])
    expect(progress.at(-1)).toBe(1)
    expect(progress.every((p, k) => k === 0 || p >= progress[k - 1])).toBe(true)
    expect(fb.cfg).toMatchObject({ fps: 30, hasAudio: false })
  })

  it('awaits async renderFrame before capturing', async () => {
    const fb = fakeBackend()
    const order: string[] = []
    const origAdd = fb.create
    await exportMp4(
      baseOptions({
        fps: 10,
        durationSeconds: 0.2,
        renderFrame: async (_t, i) => {
          await new Promise((r) => setTimeout(r, 5))
          order.push(`render${i}`)
        },
      }),
      {
        capabilities: yes,
        createBackend: (c) => {
          const b = origAdd(c)
          return { ...b, addFrame: async (t, d) => (order.push(`capture${Math.round(t * 10)}`), b.addFrame(t, d)) }
        },
      },
    )
    expect(order).toEqual(['render0', 'capture0', 'render1', 'capture1'])
  })

  it('adds trimmed audio when provided', async () => {
    const fb = fakeBackend()
    const trim = vi.fn((a: AudioBuffer) => a)
    const audio = fakeAudio(2, 48000, 5)
    await exportMp4(baseOptions({ durationSeconds: 1, audio }), { capabilities: yes, createBackend: fb.create, trimAudio: trim })
    expect(trim).toHaveBeenCalledWith(audio, 1)
    expect(fb.log).toEqual(['start', 'audio', 'finalize'])
    expect(fb.cfg?.hasAudio).toBe(true)
  })

  it('fails before creating an output when codec is unsupported', async () => {
    const create = vi.fn()
    const caps: EncoderCapabilities = { canEncodeVideo: async () => false, canEncodeAudio: async () => true }
    await expect(exportMp4(baseOptions(), { capabilities: caps, createBackend: create })).rejects.toThrow(/H\.264/)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects a canvas whose size does not match the export size', async () => {
    await expect(
      exportMp4(baseOptions({ canvas: { width: 1280, height: 720 } as HTMLCanvasElement }), { capabilities: yes, createBackend: fakeBackend().create }),
    ).rejects.toThrow(/Canvas is 1280x720 but export size is 640x360/)
  })

  it('aborts mid-export: stops rendering, cancels the output, rejects with AbortError', async () => {
    const fb = fakeBackend()
    const ac = new AbortController()
    let rendered = 0
    const p = exportMp4(
      baseOptions({
        fps: 30,
        durationSeconds: 2,
        signal: ac.signal,
        renderFrame: (_t, i) => {
          rendered++
          if (i === 9) ac.abort()
        },
      }),
      { capabilities: yes, createBackend: fb.create },
    )
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(rendered).toBe(10)
    expect(fb.frames).toHaveLength(9) // frame 9 was rendered but abort hit before capture
    expect(fb.log).toEqual(['start', 'cancel'])
  })

  it('rejects immediately if already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const create = vi.fn()
    await expect(exportMp4(baseOptions({ signal: ac.signal }), { capabilities: yes, createBackend: create })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('cancels the output and surfaces the original error when renderFrame throws', async () => {
    const fb = fakeBackend()
    await expect(
      exportMp4(
        baseOptions({
          renderFrame: (_t, i) => {
            if (i === 3) throw new Error('scene exploded')
          },
        }),
        { capabilities: yes, createBackend: fb.create },
      ),
    ).rejects.toThrow('scene exploded')
    expect(fb.log).toEqual(['start', 'cancel'])
  })
})
