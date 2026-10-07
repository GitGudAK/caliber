// Web Audio player that follows the shot preview clock. Call sync(t, playing) every frame;
// it (re)starts a source at the right file position when playback starts or drifts by
// more than DRIFT_LIMIT, and stops when the shot is not playing.
import type { AudioTrack } from '../../shared/types'
import { decodeAudioUrl } from './decode'
import { gainCurve, sourcePosition } from './trackMath'

export const DRIFT_LIMIT_SECONDS = 0.06

export interface VoiceClock {
  /** AudioContext time when the voice started. */
  startCtx: number
  /** Shot time at that moment. */
  startShot: number
}

export type SyncDecision = 'idle' | 'stop' | 'start' | 'keep'

/** Pure: what sync() should do this frame. */
export function syncDecision(
  voice: VoiceClock | null,
  t: number,
  playing: boolean,
  ctxNow: number,
  driftLimit = DRIFT_LIMIT_SECONDS,
): SyncDecision {
  if (!playing) return voice ? 'stop' : 'idle'
  if (!voice) return 'start'
  const heard = voice.startShot + (ctxNow - voice.startCtx)
  return Math.abs(heard - t) > driftLimit ? 'start' : 'keep'
}

interface Voice extends VoiceClock {
  source: AudioBufferSourceNode | null
  gain: GainNode | null
}

export interface ShotAudioDeps {
  createContext: () => AudioContext
  decode: (url: string) => Promise<AudioBuffer>
}

const browserDeps: ShotAudioDeps = {
  createContext: () => new AudioContext(),
  decode: (url) => decodeAudioUrl(url),
}

export class ShotAudio {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private track: AudioTrack | null = null
  private shotDuration = 0
  private voice: Voice | null = null
  private loadToken = 0
  private readonly deps: ShotAudioDeps

  constructor(deps: Partial<ShotAudioDeps> = {}) {
    this.deps = { ...browserDeps, ...deps }
  }

  /** Decode `url`; the newest call wins. Resolves with the buffer (or rejects with the real error). */
  async load(url: string): Promise<AudioBuffer> {
    const token = ++this.loadToken
    this.stop()
    this.buffer = null
    const buffer = await this.deps.decode(url)
    if (token === this.loadToken) this.buffer = buffer
    return buffer
  }

  unload() {
    this.loadToken++
    this.stop()
    this.buffer = null
  }

  /** Mix settings and shot length. Any change restarts the voice on the next sync. */
  setTrack(track: AudioTrack | null, shotDuration: number) {
    const changed = JSON.stringify(track) !== JSON.stringify(this.track) || shotDuration !== this.shotDuration
    this.track = track
    this.shotDuration = shotDuration
    if (changed) this.stop()
  }

  sync(t: number, playing: boolean) {
    const ready = playing && !!this.track && !!this.buffer && this.shotDuration > 0
    const now = this.ctx?.currentTime ?? 0
    const decision = syncDecision(this.voice, t, ready, now)
    if (decision === 'stop') this.stop()
    else if (decision === 'start') this.start(t)
  }

  stop() {
    const v = this.voice
    this.voice = null
    if (!v) return
    try {
      v.source?.stop()
    } catch {
      // Already stopped (ended naturally); nothing to do.
    }
    v.source?.disconnect()
    v.gain?.disconnect()
  }

  dispose() {
    this.unload()
    void this.ctx?.close()
    this.ctx = null
  }

  private start(t: number) {
    this.stop()
    const track = this.track
    const buffer = this.buffer
    if (!track || !buffer) return
    if (!this.ctx) this.ctx = this.deps.createContext()
    const ctx = this.ctx
    if (ctx.state === 'suspended') void ctx.resume()
    const now = ctx.currentTime
    const pos = sourcePosition(track, t, buffer.duration)
    const remaining = this.shotDuration - t
    if (pos === null || remaining <= 0) {
      // Past the end of a non-looping file (or the shot): silent, but track the clock so we don't retry every frame.
      this.voice = { startCtx: now, startShot: t, source: null, gain: null }
      return
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = track.loop
    if (track.loop) {
      source.loopStart = 0
      source.loopEnd = buffer.duration
    }
    const gain = ctx.createGain()
    const curve = gainCurve(track, t, this.shotDuration, this.shotDuration)
    gain.gain.value = curve[0]
    gain.gain.setValueCurveAtTime(curve, now, remaining)
    source.connect(gain)
    gain.connect(ctx.destination)
    source.start(now, pos)
    source.stop(now + remaining)
    this.voice = { startCtx: now, startShot: t, source, gain }
  }
}
