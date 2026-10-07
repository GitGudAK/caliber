// Playback clock for camera-shot preview. A tiny external store (no React state per frame):
// the canvas rig reads it every frame, the ShotPanel subscribes for the playhead readout.
//
// - previewing: the camera is driven by the shot (OrbitControls disabled).
// - playing: time advances on requestAnimationFrame (via the rig's useFrame).
// - seek(t) / setTime(t): previewing, paused, at an exact time (deterministic; used by export).

export interface ShotClockState {
  previewing: boolean
  playing: boolean
  /** Seconds from the start of the shot. Kept when preview stops so the playhead stays put. */
  time: number
}

export interface ShotClock {
  get: () => ShotClockState
  subscribe: (fn: () => void) => () => void
  play: (duration: number) => void
  pause: () => void
  seek: (t: number) => void
  /** Leave preview. The rig restores the free camera unless `restoreFreeView` is false. */
  stop: (restoreFreeView?: boolean) => void
  /** Advance while playing; stops at `duration` (paused on the last frame). */
  advance: (dt: number, duration: number) => void
  /** Move the playhead without previewing (e.g. after "Jump to key" hands the camera back to orbit). */
  cue: (t: number) => void
  /** Whether the last stop() asked for the free view to be restored. */
  restoreOnStop: () => boolean
}

export function createShotClock(): ShotClock {
  let state: ShotClockState = { previewing: false, playing: false, time: 0 }
  let restore = true
  const subs = new Set<() => void>()
  const set = (next: Partial<ShotClockState>) => {
    state = { ...state, ...next }
    for (const fn of subs) fn()
  }
  return {
    get: () => state,
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    play(duration) {
      // Restart from the beginning when the playhead sits at the end.
      const time = state.time >= duration - 1e-6 ? 0 : Math.max(0, state.time)
      set({ previewing: true, playing: true, time })
    },
    pause: () => set({ playing: false }),
    seek: (t) => set({ previewing: true, playing: false, time: Math.max(0, t) }),
    stop(restoreFreeView = true) {
      restore = restoreFreeView
      set({ previewing: false, playing: false })
    },
    advance(dt, duration) {
      if (!state.playing) return
      const time = state.time + dt
      if (time >= duration) set({ time: duration, playing: false })
      else set({ time })
    },
    cue: (t) => set({ time: Math.max(0, t) }),
    restoreOnStop: () => restore,
  }
}
