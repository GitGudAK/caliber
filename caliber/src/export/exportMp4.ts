/**
 * Client-side MP4 exporter (H.264 + optional AAC) using WebCodecs via Mediabunny.
 *
 * Deterministic OFFLINE rendering, not real-time capture: for every frame i we call
 * `renderFrame(i / fps, i)`, then capture the canvas with an exact timestamp (i / fps)
 * and duration (1 / fps). Wall-clock time is irrelevant; a slow frame just makes the
 * export take longer, never drops or duplicates frames.
 *
 * ── Caller guarantees (integration contract) ─────────────────────────────────────
 * 1. `canvas.width === width` and `canvas.height === height` (backing-store pixels, not
 *    CSS size). Set them, and the renderer's size with devicePixelRatio = 1, before
 *    calling. Width/height must be even (H.264 4:2:0). The exporter checks this.
 * 2. When `renderFrame` resolves, the canvas must already contain the finished frame for
 *    that time. With three.js / R3F: drive the clock manually (no rAF loop advancing time
 *    during export; pause `useFrame`-driven animation or use `frameloop="never"` and call
 *    `gl.render(scene, camera)` yourself inside renderFrame).
 * 3. WebGL canvases: either create the renderer with `preserveDrawingBuffer: true`, OR
 *    render synchronously inside renderFrame (gl.render in the same task, no await after
 *    it). Capture happens right after renderFrame resolves; without preserveDrawingBuffer
 *    the browser may clear the drawing buffer once the task yields, giving black frames.
 *    Spark splats: Spark sorts splats asynchronously (worker). Before rendering a frame
 *    after a camera move, the caller must wait until Spark's sort for that view has been
 *    applied (otherwise the frame shows the previous sort order). If the sort cannot be
 *    awaited, render the same frame twice with an await in between, then render once
 *    more synchronously so the buffer is fresh at capture time.
 * 4. Audio (optional) is an AudioBuffer starting at t = 0. Longer audio is trimmed to the
 *    video duration; shorter audio simply ends early. If AAC can't be encoded with that
 *    buffer's channel count / sample rate, export FAILS with an error (audio is never
 *    silently dropped). Mono or stereo at 44.1/48 kHz is the safe choice.
 *
 * Later integration (not built here): POST the returned Blob (type video/mp4) to the local
 * server, which saves it under data/exports/.
 *
 * ── Manual browser verification ──────────────────────────────────────────────────
 * In Chrome/Edge (WebCodecs required), on any page of the app, run in DevTools:
 *
 *   const { exportMp4 } = await import('/src/export/exportMp4.ts')
 *   const c = document.createElement('canvas'); c.width = 640; c.height = 360
 *   const g = c.getContext('2d')
 *   const blob = await exportMp4({
 *     canvas: c, width: 640, height: 360, fps: 30, durationSeconds: 2,
 *     renderFrame: (t, i) => { g.fillStyle = `hsl(${t * 180},70%,50%)`; g.fillRect(0,0,640,360)
 *       g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText(`frame ${i}  t=${t.toFixed(3)}`, 20, 200) },
 *     onProgress: (f) => console.log(f.toFixed(2)),
 *   })
 *   open(URL.createObjectURL(blob))
 *
 * Expect: progress logs rising to 1.00; blob.type 'video/mp4'; the video plays for exactly
 * 2.00 s, 60 frames, hue sweeping, labels "frame 0 … frame 59" with t = i/30.
 * `ffprobe -show_streams` on the saved file should show h264, 640x360, r_frame_rate 30/1,
 * nb_frames 60. Abort test: pass `signal` from an AbortController and call abort() mid-way;
 * the promise rejects with an AbortError and no further renderFrame calls happen.
 * Audio test: pass `audio: new AudioBuffer({ length: 48000*2, numberOfChannels: 2,
 * sampleRate: 48000 })` filled with a sine; ffprobe should show an aac stream too.
 */

import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny'

export const VIDEO_CODEC = 'avc' as const
export const AUDIO_CODEC = 'aac' as const
export const DEFAULT_AUDIO_BITRATE = 192_000
export const MP4_MIME = 'video/mp4'

export interface ExportMp4Options {
  canvas: HTMLCanvasElement | OffscreenCanvas
  width: number
  height: number
  fps: number
  durationSeconds: number
  /** Render the scene at exactly `timeSeconds` into `canvas`. See caller guarantees above. */
  renderFrame: (timeSeconds: number, frameIndex: number) => void | Promise<void>
  audio?: AudioBuffer
  /** Video bitrate in bits/s, passed as Quality({ bitrate }) — a bare number would be read as a 0–1 quality level. */
  bitrate?: number
  /** Called with a fraction in [0, 1]. 1 is reported only after the file is finalized. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

// ── Pure timing math ─────────────────────────────────────────────────────────────

export interface FrameTimings {
  frameCount: number
  /** Duration of every frame in seconds (1 / fps). */
  frameDuration: number
  /** Total video duration in seconds (frameCount / fps). */
  totalDuration: number
}

/**
 * Number of frames needed to cover `durationSeconds` at `fps`. Rounds up so the video is
 * never shorter than requested, with an epsilon so 2.0 s × 30 fps is exactly 60, not 61.
 */
export function computeFrameTimings(fps: number, durationSeconds: number): FrameTimings {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`fps must be a positive number, got ${fps}`)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`durationSeconds must be a positive number, got ${durationSeconds}`)
  }
  const frameCount = Math.max(1, Math.ceil(durationSeconds * fps - 1e-6))
  return { frameCount, frameDuration: 1 / fps, totalDuration: frameCount / fps }
}

/** Timestamp of frame i in seconds. Computed from the index (not accumulated) to avoid drift. */
export function frameTimestamp(frameIndex: number, fps: number): number {
  return frameIndex / fps
}

export function validateExportOptions(o: Pick<ExportMp4Options, 'width' | 'height' | 'fps' | 'durationSeconds' | 'bitrate'>): void {
  for (const [name, v] of [['width', o.width], ['height', o.height]] as const) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer, got ${v}`)
    if (v % 2 !== 0) throw new Error(`${name} must be even for H.264 encoding, got ${v}`)
  }
  if (o.bitrate !== undefined && (!Number.isFinite(o.bitrate) || o.bitrate <= 0)) {
    throw new Error(`bitrate must be a positive number of bits/s, got ${o.bitrate}`)
  }
  computeFrameTimings(o.fps, o.durationSeconds)
}

// ── Capability checks (injectable) ───────────────────────────────────────────────

export interface EncoderCapabilities {
  canEncodeVideo(codec: typeof VIDEO_CODEC, opts: { width: number; height: number; bitrate?: number }): Promise<boolean>
  canEncodeAudio(codec: typeof AUDIO_CODEC, opts: { numberOfChannels: number; sampleRate: number; bitrate: number }): Promise<boolean>
}

export class ExportUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportUnsupportedError'
  }
}

export const mediabunnyCapabilities: EncoderCapabilities = {
  canEncodeVideo: (codec, { width, height, bitrate }) =>
    canEncodeVideo(codec, { width, height, ...(bitrate !== undefined ? { quality: new Quality({ bitrate: Math.round(bitrate) }) } : {}) }),
  canEncodeAudio: (codec, { numberOfChannels, sampleRate, bitrate }) =>
    canEncodeAudio(codec, { numberOfChannels, sampleRate, quality: new Quality({ bitrate: Math.round(bitrate) }) }),
}

export async function assertEncodable(
  caps: EncoderCapabilities,
  o: { width: number; height: number; bitrate?: number; audio?: { numberOfChannels: number; sampleRate: number } },
): Promise<void> {
  if (typeof globalThis.VideoEncoder === 'undefined') {
    throw new ExportUnsupportedError(
      'MP4 export needs the WebCodecs API (VideoEncoder), which this browser does not provide. Use a recent Chrome, Edge or Safari.',
    )
  }
  const videoOk = await caps.canEncodeVideo(VIDEO_CODEC, { width: o.width, height: o.height, bitrate: o.bitrate })
  if (!videoOk) {
    throw new ExportUnsupportedError(
      `This browser cannot encode H.264 (avc) video at ${o.width}x${o.height}` +
        (o.bitrate !== undefined ? ` / ${o.bitrate} bps` : '') +
        '. MP4 export is not possible here; try a smaller preset or another browser.',
    )
  }
  if (o.audio) {
    const { numberOfChannels, sampleRate } = o.audio
    const audioOk = await caps.canEncodeAudio(AUDIO_CODEC, { numberOfChannels, sampleRate, bitrate: DEFAULT_AUDIO_BITRATE })
    if (!audioOk) {
      throw new ExportUnsupportedError(
        `This browser cannot encode AAC audio with ${numberOfChannels} channel(s) at ${sampleRate} Hz. ` +
          'Export was stopped rather than dropping the audio; remove the audio track or resample it to stereo 48 kHz.',
      )
    }
  }
}

// ── Encoding backend (injectable) ────────────────────────────────────────────────

export interface ExportBackend {
  start(): Promise<void>
  addAudio(audio: AudioBuffer): Promise<void>
  /** Capture the canvas as it is right now. */
  addFrame(timestamp: number, duration: number): Promise<void>
  finalize(): Promise<Blob>
  cancel(): Promise<void>
}

export interface BackendConfig {
  canvas: HTMLCanvasElement | OffscreenCanvas
  fps: number
  bitrate?: number
  hasAudio: boolean
}

export function createMediabunnyBackend(cfg: BackendConfig): ExportBackend {
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  })
  const video = new CanvasSource(cfg.canvas, {
    codec: VIDEO_CODEC,
    quality: cfg.bitrate !== undefined ? new Quality({ bitrate: Math.round(cfg.bitrate) }) : new Quality('high'),
  })
  output.addVideoTrack(video, { frameRate: cfg.fps })
  let audioSource: AudioBufferSource | null = null
  if (cfg.hasAudio) {
    audioSource = new AudioBufferSource({ codec: AUDIO_CODEC, quality: new Quality({ bitrate: DEFAULT_AUDIO_BITRATE }) })
    output.addAudioTrack(audioSource)
  }
  return {
    start: () => output.start(),
    addAudio: async (audio) => {
      if (!audioSource) throw new Error('addAudio called but backend was created without an audio track')
      await audioSource.add(audio)
    },
    addFrame: (timestamp, duration) => video.add(timestamp, duration),
    finalize: async () => {
      await output.finalize()
      const buf = output.target.buffer
      if (!buf) throw new Error('Mediabunny finalized but produced no buffer')
      return new Blob([buf], { type: MP4_MIME })
    },
    cancel: async () => {
      if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel()
    },
  }
}

/** Copy of `audio` cut to at most `maxSeconds`. Returns the original if already short enough. */
export function trimAudioBuffer(audio: AudioBuffer, maxSeconds: number): AudioBuffer {
  const maxLength = Math.round(maxSeconds * audio.sampleRate)
  if (audio.length <= maxLength) return audio
  const out = new AudioBuffer({ length: maxLength, numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate })
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    out.copyToChannel(audio.getChannelData(ch).subarray(0, maxLength), ch)
  }
  return out
}

// ── Main entry ───────────────────────────────────────────────────────────────────

export interface ExportDeps {
  capabilities: EncoderCapabilities
  createBackend: (cfg: BackendConfig) => ExportBackend
  trimAudio: (audio: AudioBuffer, maxSeconds: number) => AudioBuffer
}

const defaultDeps: ExportDeps = {
  capabilities: mediabunnyCapabilities,
  createBackend: createMediabunnyBackend,
  trimAudio: trimAudioBuffer,
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('MP4 export was aborted', 'AbortError')
}

export async function exportMp4(options: ExportMp4Options, deps: Partial<ExportDeps> = {}): Promise<Blob> {
  const d: ExportDeps = { ...defaultDeps, ...deps }
  const { canvas, width, height, fps, durationSeconds, renderFrame, audio, bitrate, onProgress, signal } = options

  validateExportOptions({ width, height, fps, durationSeconds, bitrate })
  if (canvas.width !== width || canvas.height !== height) {
    throw new Error(
      `Canvas is ${canvas.width}x${canvas.height} but export size is ${width}x${height}. ` +
        'Resize the canvas backing store (and renderer, with pixel ratio 1) before exporting.',
    )
  }
  if (signal?.aborted) throw abortError(signal)

  await assertEncodable(d.capabilities, {
    width,
    height,
    bitrate,
    audio: audio ? { numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate } : undefined,
  })

  const { frameCount, frameDuration, totalDuration } = computeFrameTimings(fps, durationSeconds)
  const backend = d.createBackend({ canvas, fps, bitrate, hasAudio: !!audio })

  try {
    if (signal?.aborted) throw abortError(signal)
    await backend.start()
    // Non-fragmented MP4 (in-memory fast start) does not need interleaved writes,
    // so the whole audio track can be added up front.
    if (audio) await backend.addAudio(d.trimAudio(audio, totalDuration))

    for (let i = 0; i < frameCount; i++) {
      if (signal?.aborted) throw abortError(signal)
      const t = frameTimestamp(i, fps)
      await renderFrame(t, i)
      if (signal?.aborted) throw abortError(signal)
      await backend.addFrame(t, frameDuration)
      // Reserve the last few percent for finalize (moov write / buffer copy).
      onProgress?.(((i + 1) / frameCount) * 0.99)
    }

    if (signal?.aborted) throw abortError(signal)
    const blob = await backend.finalize()
    onProgress?.(1)
    return blob
  } catch (err) {
    try {
      await backend.cancel()
    } catch {
      // The original error is the one worth surfacing; cancel failure is secondary.
    }
    throw err
  }
}
