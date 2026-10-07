import { useEffect, useRef, useState } from 'react'
import type { AudioTrack } from '../../shared/types'
import type { StudioCanvasHandle } from '../viewer/StudioCanvas'
import { ShotAudio } from './ShotAudio'

/** The viewer method preview sync needs. Feature-checked until StudioCanvasHandle declares it. */
type PlayableHandle = StudioCanvasHandle & { isShotPlaying?: () => boolean }

export interface ShotAudioStatus {
  /** Decode error for the active track's file (verbatim). */
  error: string | null
  loading: boolean
  /** Decoded file length, seconds. */
  bufferDuration: number | null
  /** false when the viewer cannot report whether the shot is playing (no isShotPlaying()). */
  syncSupported: boolean | null
}

/**
 * Plays the project soundtrack in step with the shot preview. Reads the StudioCanvas
 * handle every animation frame (getShotTime + isShotPlaying); no React state per frame.
 */
export function useShotAudio(
  handleRef: { current: StudioCanvasHandle | null },
  track: AudioTrack | null,
  audioUrl: string | null,
  shotDuration: number | null,
): ShotAudioStatus {
  const playerRef = useRef<ShotAudio | null>(null)
  const [status, setStatus] = useState<ShotAudioStatus>({ error: null, loading: false, bufferDuration: null, syncSupported: null })

  useEffect(() => {
    const player = new ShotAudio()
    playerRef.current = player
    return () => {
      player.dispose()
      if (playerRef.current === player) playerRef.current = null
    }
  }, [])

  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    if (!audioUrl) {
      player.unload()
      setStatus((s) => ({ ...s, error: null, loading: false, bufferDuration: null }))
      return
    }
    let live = true
    setStatus((s) => ({ ...s, error: null, loading: true, bufferDuration: null }))
    player.load(audioUrl).then(
      (buffer) => live && setStatus((s) => ({ ...s, loading: false, bufferDuration: buffer.duration })),
      (e: unknown) => live && setStatus((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) })),
    )
    return () => {
      live = false
    }
  }, [audioUrl])

  useEffect(() => {
    playerRef.current?.setTrack(track, shotDuration ?? 0)
  }, [track, shotDuration])

  useEffect(() => {
    let raf = 0
    let supported: boolean | null = null
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const player = playerRef.current
      if (!player) return
      const handle = handleRef.current as PlayableHandle | null
      if (!handle) {
        player.sync(0, false)
        return
      }
      const canSync = typeof handle.isShotPlaying === 'function'
      if (canSync !== supported) {
        supported = canSync
        setStatus((s) => ({ ...s, syncSupported: canSync }))
      }
      if (!canSync) {
        player.sync(0, false)
        return
      }
      player.sync(handle.getShotTime(), handle.isShotPlaying!())
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      playerRef.current?.stop()
    }
  }, [handleRef])

  return status
}
