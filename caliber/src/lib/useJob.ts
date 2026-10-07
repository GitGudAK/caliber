import { useEffect, useState } from 'react'
import type { Job } from '../../shared/types'
import { api } from './api'
import { type JobTransport, type JobWatchState, watchJob } from './jobWatcher'

export type { JobTransport }

const browserDeps = {
  createEventSource: (url: string) => new EventSource(url),
  fetchJob: (id: string) => api.getJob(id),
  setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => window.clearTimeout(handle as number),
}

const IDLE: JobWatchState = { job: null, error: null, transport: 'sse', done: false }

// Live job state: SSE on API.jobEvents, falling back to 1s polling of API.job
// if the stream errors before a terminal status. Stops on succeeded/failed.
export function useJob(jobId: string | null | undefined): {
  job: Job | null
  error: string | null
  transport: JobTransport
} {
  const [state, setState] = useState<JobWatchState & { id: string | null }>({ ...IDLE, id: null })

  useEffect(() => {
    if (!jobId) return
    setState({ ...IDLE, id: jobId })
    return watchJob(jobId, browserDeps, (next) => setState({ ...next, id: jobId }))
  }, [jobId])

  // Never show a previous job's state while switching ids.
  if (!jobId || state.id !== jobId) return { job: null, error: null, transport: 'sse' }
  return { job: state.job, error: state.error, transport: state.transport }
}
