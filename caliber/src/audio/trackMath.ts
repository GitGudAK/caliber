// Pure math for the project soundtrack (AudioTrack). Shared by the live preview player
// (ShotAudio) and the offline export mix (mixTrack), so both sound the same.
//
// Model: shot time t runs 0..shotDuration. The audio file is read from
// offsetSeconds + t; with loop on it wraps around the whole file, with loop off it
// goes silent once the file ends. Gain = volume x fade-in ramp x fade-out ramp.
import type { AudioTrack } from '../../shared/types'

export const DEFAULT_TRACK: Omit<AudioTrack, 'assetId' | 'loop'> = {
  volume: 0.8,
  offsetSeconds: 0,
  fadeInSeconds: 0.5,
  fadeOutSeconds: 1.0,
}

/** A new track for a library asset with the default mix; loop follows the asset (meta.loop). */
export function defaultTrackFor(asset: { id: string; meta: Record<string, unknown> }): AudioTrack {
  return { assetId: asset.id, ...DEFAULT_TRACK, loop: asset.meta.loop === true }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** Linear gain at shot time t (0 outside the shot). Fades multiply when they overlap. */
export function trackGainAt(track: AudioTrack, t: number, shotDuration: number): number {
  if (!(t >= 0) || t > shotDuration) return 0
  let g = clamp01(track.volume)
  if (track.fadeInSeconds > 0 && t < track.fadeInSeconds) g *= t / track.fadeInSeconds
  const outStart = shotDuration - track.fadeOutSeconds
  if (track.fadeOutSeconds > 0 && t > outStart) g *= Math.max(0, (shotDuration - t) / track.fadeOutSeconds)
  return clamp01(g)
}

/** Seconds into the audio file heard at shot time t; null when the file has ended (loop off). */
export function sourcePosition(track: AudioTrack, t: number, bufferDuration: number): number | null {
  if (!(bufferDuration > 0)) return null
  const p = Math.max(0, track.offsetSeconds) + Math.max(0, t)
  if (track.loop) return ((p % bufferDuration) + bufferDuration) % bufferDuration
  return p < bufferDuration ? p : null
}

/**
 * Gain samples from shot time `from` to `to`, evenly spaced (>= 2 points), for
 * AudioParam.setValueCurveAtTime (which interpolates linearly between them).
 */
export function gainCurve(
  track: AudioTrack,
  from: number,
  to: number,
  shotDuration: number,
  pointsPerSecond = 200,
): Float32Array {
  const span = Math.max(0, to - from)
  const n = Math.max(2, Math.ceil(span * pointsPerSecond) + 1)
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) curve[i] = trackGainAt(track, from + (span * i) / (n - 1), shotDuration)
  return curve
}

/** Why this track would be silent for the whole shot, or null. Shown in the UI; export refuses it. */
export function silentTrackReason(track: AudioTrack, bufferDuration: number): string | null {
  if (!(bufferDuration > 0)) return 'The audio file is empty.'
  if (!track.loop && track.offsetSeconds >= bufferDuration) {
    return `Start offset ${track.offsetSeconds.toFixed(2)}s is past the end of the ${bufferDuration.toFixed(2)}s audio, so nothing would play. Lower the offset or turn on loop.`
  }
  if (track.volume <= 0) return 'Volume is 0, so nothing would be heard.'
  return null
}
