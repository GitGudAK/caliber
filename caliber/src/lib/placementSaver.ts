// Debounced, coalescing saver for the latest value of something (the project
// scene/placement). Pure: timers and the save call are injected so it can be
// unit-tested without React or the network.
//
// Guarantees:
// - Rapid updates within `delayMs` collapse into one save of the newest value.
// - Only one save is in flight at a time; changes made during a save are saved after it.
// - A failed save keeps the newest value dirty. It is retried on the next update()
//   or retry(); nothing is dropped.

export type SaverStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export interface SaverState {
  status: SaverStatus
  error: string | null
}

export interface SaverTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export interface DebouncedSaverOptions<T> {
  save: (value: T) => Promise<void>
  delayMs?: number
  onState?: (state: SaverState) => void
  timers?: SaverTimers
}

export interface DebouncedSaver<T> {
  /** Record a new value and (re)start the debounce. */
  update: (value: T) => void
  /** Save the newest unsaved value now (e.g. a Retry button). */
  retry: () => void
  /** Drop any unsaved value and pending timer. Does not abort an in-flight save. */
  discard: () => void
  /** Resolves once no save is in flight. */
  whenIdle: () => Promise<void>
  /** The newest value passed to update() that has not been saved successfully, if any. */
  unsaved: () => { value: T } | null
  getState: () => SaverState
  dispose: () => void
}

const defaultTimers: SaverTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createDebouncedSaver<T>({
  save,
  delayMs = 500,
  onState,
  timers = defaultTimers,
}: DebouncedSaverOptions<T>): DebouncedSaver<T> {
  let latest: { value: T } | null = null
  let dirty = false
  let timer: unknown = null
  let inFlight: Promise<void> | null = null
  let disposed = false
  let state: SaverState = { status: 'idle', error: null }

  const setState = (next: SaverState) => {
    state = next
    if (!disposed) onState?.(next)
  }

  const clearTimer = () => {
    if (timer !== null) {
      timers.clear(timer)
      timer = null
    }
  }

  const run = () => {
    clearTimer()
    if (disposed || !dirty || !latest) return
    // A save is running; it will pick up the newer value when it finishes.
    if (inFlight) return
    const { value } = latest
    dirty = false
    setState({ status: 'saving', error: null })
    inFlight = save(value).then(
      () => {
        inFlight = null
        if (dirty) {
          // Changed while saving. If no debounce is waiting, save the newer value now.
          if (timer === null) run()
          else setState({ status: 'pending', error: null })
        } else {
          setState({ status: 'saved', error: null })
        }
      },
      (error: unknown) => {
        inFlight = null
        // Keep the newest value dirty unless something newer is already queued.
        dirty = true
        const message = error instanceof Error ? error.message : String(error)
        if (timer === null) setState({ status: 'error', error: message })
      },
    )
  }

  return {
    update(value) {
      if (disposed) return
      latest = { value }
      dirty = true
      clearTimer()
      timer = timers.set(run, delayMs)
      if (!inFlight) setState({ status: 'pending', error: null })
    },
    retry() {
      if (disposed) return
      run()
    },
    discard() {
      clearTimer()
      dirty = false
      latest = null
      if (!inFlight) setState({ status: 'idle', error: null })
    },
    async whenIdle() {
      while (inFlight) await inFlight
    },
    unsaved: () => (dirty && latest ? { value: latest.value } : null),
    getState: () => state,
    dispose() {
      clearTimer()
      disposed = true
    },
  }
}

/**
 * Order spz resolution keys from smallest to largest. Numeric keys like "100k" / "2m"
 * sort by count; anything else (e.g. "full_res") sorts after them.
 */
export function sortSpzKeys(keys: string[]): string[] {
  const size = (key: string) => {
    const m = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(key)
    if (!m) return Number.POSITIVE_INFINITY
    const mult = m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1
    return Number(m[1]) * mult
  }
  return [...keys].sort((a, b) => size(a) - size(b) || a.localeCompare(b))
}

/** '500k' if present, else the smallest available; null when there are none. */
export function defaultSpzKey(keys: string[]): string | null {
  if (keys.includes('500k')) return '500k'
  return sortSpzKeys(keys)[0] ?? null
}
