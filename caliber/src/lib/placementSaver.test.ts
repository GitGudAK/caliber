import { describe, expect, it } from 'vitest'
import { createDebouncedSaver, defaultSpzKey, sortSpzKeys, type SaverState, type SaverTimers } from './placementSaver'

// Manual clock so debounce behavior is deterministic.
function fakeTimers() {
  let now = 0
  let nextId = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: SaverTimers = {
    set: (fn, ms) => {
      const id = nextId++
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clear: (handle) => {
      pending.delete(handle as number)
    },
  }
  const advance = (ms: number) => {
    now += ms
    for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) {
        pending.delete(id)
        t.fn()
      }
    }
  }
  return { timers, advance, pendingCount: () => pending.size }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function deferred() {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createDebouncedSaver', () => {
  it('coalesces rapid updates into one save of the newest value', async () => {
    const clock = fakeTimers()
    const saved: number[] = []
    const states: SaverState[] = []
    const saver = createDebouncedSaver<number>({
      save: async (v) => {
        saved.push(v)
      },
      delayMs: 500,
      timers: clock.timers,
      onState: (s) => states.push(s),
    })
    saver.update(1)
    clock.advance(200)
    saver.update(2)
    clock.advance(200)
    saver.update(3)
    clock.advance(499)
    expect(saved).toEqual([])
    expect(saver.getState().status).toBe('pending')
    clock.advance(1)
    await flush()
    expect(saved).toEqual([3])
    expect(saver.getState()).toEqual({ status: 'saved', error: null })
    expect(saver.unsaved()).toBeNull()
    expect(states.map((s) => s.status)).toContain('saving')
  })

  it('keeps the latest value after a failure and saves it on retry', async () => {
    const clock = fakeTimers()
    const calls: number[] = []
    let fail = true
    const saver = createDebouncedSaver<number>({
      save: async (v) => {
        calls.push(v)
        if (fail) throw new Error('HTTP 500: disk full')
      },
      timers: clock.timers,
    })
    saver.update(7)
    clock.advance(500)
    await flush()
    expect(saver.getState()).toEqual({ status: 'error', error: 'HTTP 500: disk full' })
    expect(saver.unsaved()).toEqual({ value: 7 })

    fail = false
    saver.retry()
    await flush()
    expect(calls).toEqual([7, 7])
    expect(saver.getState().status).toBe('saved')
    expect(saver.unsaved()).toBeNull()
  })

  it('after a failure, the next update saves the newest value', async () => {
    const clock = fakeTimers()
    const calls: number[] = []
    let fail = true
    const saver = createDebouncedSaver<number>({
      save: async (v) => {
        calls.push(v)
        if (fail) throw new Error('offline')
      },
      timers: clock.timers,
    })
    saver.update(1)
    clock.advance(500)
    await flush()
    expect(saver.getState().status).toBe('error')
    fail = false
    saver.update(2)
    expect(saver.getState().status).toBe('pending')
    clock.advance(500)
    await flush()
    expect(calls).toEqual([1, 2])
    expect(saver.getState().status).toBe('saved')
  })

  it('never runs two saves at once and saves changes made during a save', async () => {
    const clock = fakeTimers()
    const calls: number[] = []
    const gates: ReturnType<typeof deferred>[] = []
    const saver = createDebouncedSaver<number>({
      save: (v) => {
        calls.push(v)
        const d = deferred()
        gates.push(d)
        return d.promise
      },
      timers: clock.timers,
    })
    saver.update(1)
    clock.advance(500)
    expect(calls).toEqual([1])
    saver.update(2)
    saver.update(3)
    clock.advance(500) // debounce fires while save(1) is still in flight
    expect(calls).toEqual([1])
    gates[0].resolve()
    await flush()
    expect(calls).toEqual([1, 3])
    gates[1].resolve()
    await flush()
    expect(saver.getState().status).toBe('saved')
    await saver.whenIdle()
  })

  it('a failed in-flight save does not clobber a newer queued value', async () => {
    const clock = fakeTimers()
    const calls: number[] = []
    const gates: ReturnType<typeof deferred>[] = []
    const saver = createDebouncedSaver<number>({
      save: (v) => {
        calls.push(v)
        const d = deferred()
        gates.push(d)
        return d.promise
      },
      timers: clock.timers,
    })
    saver.update(1)
    clock.advance(500)
    saver.update(2)
    gates[0].reject(new Error('boom'))
    await flush()
    expect(saver.unsaved()).toEqual({ value: 2 })
    clock.advance(500)
    expect(calls).toEqual([1, 2])
    gates[1].resolve()
    await flush()
    expect(saver.getState().status).toBe('saved')
  })

  it('discard drops the pending value without saving', async () => {
    const clock = fakeTimers()
    const calls: number[] = []
    const saver = createDebouncedSaver<number>({
      save: async (v) => {
        calls.push(v)
      },
      timers: clock.timers,
    })
    saver.update(1)
    saver.discard()
    clock.advance(1000)
    await flush()
    expect(calls).toEqual([])
    expect(clock.pendingCount()).toBe(0)
    expect(saver.getState().status).toBe('idle')
  })
})

describe('spz keys', () => {
  it('sorts numeric resolutions ascending with full_res last', () => {
    expect(sortSpzKeys(['full_res', '500k', '100k', '2m'])).toEqual(['100k', '500k', '2m', 'full_res'])
  })
  it("defaults to 500k, else the smallest", () => {
    expect(defaultSpzKey(['full_res', '500k', '100k'])).toBe('500k')
    expect(defaultSpzKey(['full_res', '150k'])).toBe('150k')
    expect(defaultSpzKey(['full_res'])).toBe('full_res')
    expect(defaultSpzKey([])).toBeNull()
  })
})
