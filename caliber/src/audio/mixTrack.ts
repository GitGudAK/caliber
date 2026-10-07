// Offline render of the project soundtrack to an AudioBuffer exactly as long as the shot,
// with offset, loop, fades and volume applied. exportMp4 muxes it as AAC.
import type { AudioTrack } from '../../shared/types'
import { MIX_SAMPLE_RATE } from './decode'
import { gainCurve, silentTrackReason, sourcePosition } from './trackMath'

export const MIX_CHANNELS = 2

export interface TrackRenderPlan {
  length: number
  numberOfChannels: number
  sampleRate: number
  /** Position in the source file at shot time 0. */
  startOffset: number
  loop: boolean
  /** Gain automation over the whole shot. */
  curve: Float32Array
  curveDuration: number
}

/** Pure: everything renderTrackBuffer schedules. Throws if the result would be silent or invalid. */
export function planTrackRender(
  track: AudioTrack,
  bufferDuration: number,
  shotDuration: number,
  sampleRate = MIX_SAMPLE_RATE,
): TrackRenderPlan {
  if (!(shotDuration > 0) || !Number.isFinite(shotDuration)) throw new Error(`Invalid shot duration ${shotDuration}s for the audio mix.`)
  if (!(sampleRate > 0)) throw new Error(`Invalid sample rate ${sampleRate}.`)
  const silent = silentTrackReason(track, bufferDuration)
  if (silent) throw new Error(`Audio track would be silent: ${silent}`)
  const startOffset = sourcePosition(track, 0, bufferDuration)
  if (startOffset === null) throw new Error('Audio track would be silent: the start offset is past the end of the file.')
  return {
    length: Math.round(shotDuration * sampleRate),
    numberOfChannels: MIX_CHANNELS,
    sampleRate,
    startOffset,
    loop: track.loop,
    curve: gainCurve(track, 0, shotDuration, shotDuration),
    curveDuration: shotDuration,
  }
}

/** The slice of BaseAudioContext the mix uses; injectable so the scheduling is testable without a browser. */
export interface MixContext {
  readonly destination: AudioNode
  createBufferSource(): AudioBufferSourceNode
  createGain(): GainNode
  startRendering(): Promise<AudioBuffer>
}

export interface MixDeps {
  createContext: (o: { numberOfChannels: number; length: number; sampleRate: number }) => MixContext
}

const browserDeps: MixDeps = {
  createContext: (o) => new OfflineAudioContext(o),
}

export async function renderTrackBuffer(
  track: AudioTrack,
  sourceBuffer: AudioBuffer,
  shotDuration: number,
  sampleRate = MIX_SAMPLE_RATE,
  deps: MixDeps = browserDeps,
): Promise<AudioBuffer> {
  const plan = planTrackRender(track, sourceBuffer.duration, shotDuration, sampleRate)
  const ctx = deps.createContext({ numberOfChannels: plan.numberOfChannels, length: plan.length, sampleRate: plan.sampleRate })

  const source = ctx.createBufferSource()
  source.buffer = sourceBuffer
  source.loop = plan.loop
  if (plan.loop) {
    source.loopStart = 0
    source.loopEnd = sourceBuffer.duration
  }
  const gain = ctx.createGain()
  gain.gain.value = plan.curve[0]
  gain.gain.setValueCurveAtTime(plan.curve, 0, plan.curveDuration)
  source.connect(gain)
  gain.connect(ctx.destination)
  source.start(0, plan.startOffset)

  const rendered = await ctx.startRendering()
  if (rendered.length !== plan.length || rendered.sampleRate !== plan.sampleRate) {
    throw new Error(
      `Audio mix came back ${rendered.length} samples at ${rendered.sampleRate} Hz; expected ${plan.length} at ${plan.sampleRate} Hz.`,
    )
  }
  return rendered
}
