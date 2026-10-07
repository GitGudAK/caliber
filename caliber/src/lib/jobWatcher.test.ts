import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, JobStatus } from '../../shared/types'
import { ApiError } from './api'
import { type EventSourceLike, type JobWatchState, watchJob } from './jobWatcher'

function makeJob(status: JobStatus, progress = 0): Job {
  return {
    id: 'job1',
    kind: 'selftest',
    projectId: null,
    status,
    progress,
    steps: [],
    input: null,
    result: null,
    error: null,
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
  }
}

class FakeEventSource implements EventSourceLike {
  url: string
  closed = false
  onerror: ((event: Event) => void) | null = null
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {}
  constructor(url: string) {
    this.url = url
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    ;(this.listeners[type] ??= []).push(listener)
  }
  close() {
    this.closed = true
  }
  emitJob(job: Job) {
    for (const l of this.listeners.job ?? []) l({ data: JSON.stringify(job) } as MessageEvent)
  }
  fail() {
    this.onerror?.(new Event('error'))
  }
}

function setup(fetchJob: (id: string) => Promise<Job>) {
  let source!: FakeEventSource
  const states: JobWatchState[] = []
  const stop = watchJob(
    'job1',
    {
      createEventSource: (url) => (source = new FakeEventSource(url)),
      fetchJob,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      pollIntervalMs: 1000,
    },
    (s) => states.push(s),
  )
  return { source, states, stop, last: () => states[states.length - 1] }
}

describe('watchJob', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opens the SSE route and follows job events to a terminal status', () => {
    const fetchJob = vi.fn()
    const { source, last } = setup(fetchJob)
    expect(source.url).toBe('/api/jobs/job1/events')
    source.emitJob(makeJob('running', 0.5))
    expect(last()).toMatchObject({ transport: 'sse', done: false, job: { progress: 0.5 } })
    source.emitJob(makeJob('succeeded', 1))
    expect(last()).toMatchObject({ transport: 'sse', done: true, job: { status: 'succeeded' } })
    expect(source.closed).toBe(true)
    // The server closing the stream after a terminal status must not trigger polling.
    source.fail()
    expect(fetchJob).not.toHaveBeenCalled()
  })

  it('falls back to polling every second when SSE errors before terminal', async () => {
    const responses = [makeJob('running', 0.3), makeJob('running', 0.6), makeJob('failed', 0.6)]
    const fetchJob = vi.fn(async () => responses.shift()!)
    const { source, last } = setup(fetchJob)
    source.emitJob(makeJob('running', 0.1))
    source.fail()
    expect(source.closed).toBe(true)
    expect(last().transport).toBe('polling')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchJob).toHaveBeenCalledTimes(1)
    expect(last().job?.progress).toBe(0.3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchJob).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchJob).toHaveBeenCalledTimes(3)
    expect(last()).toMatchObject({ done: true, job: { status: 'failed' } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchJob).toHaveBeenCalledTimes(3)
  })

  it('keeps polling through network errors and shows the real message', async () => {
    const fetchJob = vi
      .fn<(id: string) => Promise<Job>>()
      .mockRejectedValueOnce(new Error('Local server unreachable at http://x/api/jobs/job1'))
      .mockResolvedValueOnce(makeJob('succeeded', 1))
    const { source, last } = setup(fetchJob)
    source.fail()
    await vi.advanceTimersByTimeAsync(0)
    expect(last().error).toMatch(/unreachable/)
    expect(last().done).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(last()).toMatchObject({ error: null, done: true })
  })

  it('stops polling on a 4xx (e.g. unknown job)', async () => {
    const fetchJob = vi.fn(async () => {
      throw new ApiError('job not found: job1', 404, '/api/jobs/job1')
    })
    const { source, last } = setup(fetchJob)
    source.fail()
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchJob).toHaveBeenCalledTimes(1)
    expect(last()).toMatchObject({ error: 'job not found: job1', done: true })
  })

  it('surfaces a server-sent named error event before falling back', async () => {
    const fetchJob = vi.fn(async () => new Promise<Job>(() => {}))
    const { source, last } = setup(fetchJob)
    source.onerror?.({ data: JSON.stringify({ error: 'Job job1 disappeared' }) } as unknown as Event)
    expect(last()).toMatchObject({ transport: 'polling', error: 'SSE stream error: Job job1 disappeared' })
    expect(source.closed).toBe(true)
  })

  it('stop() cancels pending polls', async () => {
    const fetchJob = vi.fn(async () => makeJob('running'))
    const { source, stop } = setup(fetchJob)
    source.fail()
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchJob).toHaveBeenCalledTimes(1)
  })
})
