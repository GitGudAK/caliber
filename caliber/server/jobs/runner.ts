import { EventEmitter } from 'node:events'
import type { Job, JobStep } from '../../shared/types.ts'
import type { Repository } from '../db/repository.ts'
import { now } from '../ids.ts'

export interface JobContext {
  job: Job
  /** Mark a step running, run fn, mark it succeeded/failed. Rethrows on failure. */
  step<T>(key: string, fn: () => Promise<T>): Promise<T>
  /** Free-text status for the currently running step (e.g. provider queue position). */
  detail(key: string, detail: string): void
  progress(value: number): void
}

export interface JobDefinition<Input = unknown, Result = unknown> {
  steps: { key: string; label: string }[]
  run(input: Input, ctx: JobContext): Promise<Result>
}

// The app only depends on this interface; an in-process runner is one implementation.
export interface JobRunner {
  register<I, R>(kind: string, definition: JobDefinition<I, R>): void
  create(kind: string, input: unknown, projectId: string | null): Job
  get(id: string): Job | undefined
  subscribe(id: string, listener: (job: Job) => void): () => void
}

export function createInProcessJobRunner(repo: Repository): JobRunner {
  const definitions = new Map<string, JobDefinition<any, any>>()
  const events = new EventEmitter()
  events.setMaxListeners(0)

  // Jobs don't survive a server restart. Say so instead of leaving them "running" forever.
  for (const job of repo.jobs.listByStatus(['queued', 'running'])) {
    repo.jobs.update(job.id, {
      status: 'failed',
      error: 'The local server restarted while this job was running. Retry to start it again.',
      steps: job.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed', finishedAt: now() } : s)),
    })
  }

  // The job row disappears when its project is deleted mid-run; stop quietly.
  const current = (id: string) => {
    const job = repo.jobs.get(id)
    if (!job) throw new JobDeletedError(id)
    return job
  }

  const update = (id: string, patch: Parameters<Repository['jobs']['update']>[1]) => {
    current(id)
    const job = repo.jobs.update(id, patch)
    events.emit(id, job)
    return job
  }

  const patchStep = (id: string, key: string, patch: Partial<JobStep>) => {
    const job = current(id)
    if (!job.steps.some((s) => s.key === key)) throw new Error(`Job ${job.kind} has no step "${key}"`)
    return update(id, { steps: job.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)) })
  }

  async function execute(job: Job) {
    const definition = definitions.get(job.kind)!
    update(job.id, { status: 'running' })
    const ctx: JobContext = {
      job,
      async step(key, fn) {
        patchStep(job.id, key, { status: 'running', startedAt: now() })
        try {
          const result = await fn()
          patchStep(job.id, key, { status: 'succeeded', finishedAt: now() })
          return result
        } catch (error) {
          patchStep(job.id, key, { status: 'failed', finishedAt: now(), detail: errorMessage(error) })
          throw error
        }
      },
      detail: (key, detail) => void patchStep(job.id, key, { detail }),
      progress: (value) => void update(job.id, { progress: Math.max(0, Math.min(1, value)) }),
    }
    try {
      const result = await definition.run(job.input, ctx)
      update(job.id, { status: 'succeeded', progress: 1, result: result ?? null })
    } catch (error) {
      if (error instanceof JobDeletedError) return
      console.error(`[job ${job.kind} ${job.id}]`, error)
      try {
        update(job.id, { status: 'failed', error: errorMessage(error) })
      } catch (inner) {
        if (!(inner instanceof JobDeletedError)) throw inner
      }
    }
  }

  return {
    register(kind, definition) {
      definitions.set(kind, definition)
    },
    create(kind, input, projectId) {
      const definition = definitions.get(kind)
      if (!definition) throw new Error(`Unknown job kind: ${kind}`)
      const job = repo.jobs.create({
        kind,
        projectId,
        input,
        steps: definition.steps.map((s) => ({ ...s, status: 'pending' })),
      })
      queueMicrotask(() => void execute(job))
      return job
    },
    get: (id) => repo.jobs.get(id),
    subscribe(id, listener) {
      events.on(id, listener)
      return () => events.off(id, listener)
    },
  }
}

class JobDeletedError extends Error {
  constructor(id: string) {
    super(`Job ${id} was deleted while running`)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
