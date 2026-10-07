import { API } from '../../shared/api'
import type { Job, JobStatus } from '../../shared/types'
import { ApiError, errorMessage } from './api'

// Framework-free job watcher: SSE first, polling fallback. useJob wraps it.
// Kept pure-ish (all I/O injected) so the fallback logic is unit-testable.

export type JobTransport = 'sse' | 'polling'

export interface JobWatchState {
  job: Job | null
  error: string | null
  transport: JobTransport
  done: boolean
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  onerror: ((event: Event) => void) | null
  close(): void
}

export interface JobWatcherDeps {
  createEventSource: (url: string) => EventSourceLike
  fetchJob: (id: string) => Promise<Job>
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  pollIntervalMs?: number
}

export function isTerminal(status: JobStatus) {
  return status === 'succeeded' || status === 'failed'
}

// Polling stops on client errors (e.g. 404: the job does not exist); network
// errors and 5xx keep polling while showing the real error.
function isFatalPollError(error: unknown) {
  return error instanceof ApiError && error.status >= 400 && error.status < 500
}

export function watchJob(
  jobId: string,
  deps: JobWatcherDeps,
  onChange: (state: JobWatchState) => void,
): () => void {
  const interval = deps.pollIntervalMs ?? 1000
  let state: JobWatchState = { job: null, error: null, transport: 'sse', done: false }
  let source: EventSourceLike | null = null
  let timer: unknown = null
  let stopped = false

  const emit = (patch: Partial<JobWatchState>) => {
    if (stopped) return
    state = { ...state, ...patch }
    onChange(state)
  }

  const closeSource = () => {
    if (source) {
      source.onerror = null
      source.close()
      source = null
    }
  }

  const acceptJob = (job: Job) => {
    const done = isTerminal(job.status)
    emit({ job, error: null, done })
    if (done) {
      closeSource()
      stopped = true
    }
    return done
  }

  const poll = async () => {
    timer = null
    if (stopped) return
    try {
      const job = await deps.fetchJob(jobId)
      if (stopped) return
      if (acceptJob(job)) return
    } catch (error) {
      if (stopped) return
      if (isFatalPollError(error)) {
        emit({ error: errorMessage(error), done: true })
        stopped = true
        return
      }
      emit({ error: errorMessage(error) })
    }
    if (!stopped) timer = deps.setTimeout(poll, interval)
  }

  const fallBackToPolling = () => {
    closeSource()
    if (stopped) return
    emit({ transport: 'polling' })
    void poll()
  }

  try {
    source = deps.createEventSource(API.jobEvents(jobId))
    source.addEventListener('job', (event) => {
      let job: Job
      try {
        job = JSON.parse(event.data) as Job
      } catch (error) {
        emit({ error: `Malformed SSE job event: ${errorMessage(error)}` })
        fallBackToPolling()
        return
      }
      acceptJob(job)
    })
    source.onerror = (event) => {
      // Errors after a terminal status are just the server closing the stream;
      // acceptJob already closed the source in that case.
      if (state.job && isTerminal(state.job.status)) return
      // The server may send a named `event: error` with data {error}; show it.
      const data = (event as MessageEvent).data
      if (typeof data === 'string' && data) {
        let message = data
        try {
          const parsed = JSON.parse(data) as { error?: unknown }
          if (typeof parsed.error === 'string') message = parsed.error
        } catch {
          // keep raw text
        }
        emit({ error: `SSE stream error: ${message}` })
      }
      fallBackToPolling()
    }
  } catch (error) {
    emit({ error: `EventSource unavailable: ${errorMessage(error)}` })
    fallBackToPolling()
  }

  return () => {
    stopped = true
    closeSource()
    if (timer !== null) deps.clearTimeout(timer)
    timer = null
  }
}
