import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Job } from '../../shared/types.ts'
import type { Services } from '../app.ts'
import { badRequest, notFound } from './errors.ts'

const KEEP_ALIVE_MS = 15_000
const isTerminal = (job: Job) => job.status === 'succeeded' || job.status === 'failed'

export function jobRoutes(services: Services) {
  const { repo, runner } = services

  const requireJob = (id: string): Job => {
    const job = runner.get(id)
    if (!job) throw notFound(`Job ${id} not found`)
    return job
  }

  return new Hono()
    .post('/selftest', async (c) => {
      let projectId: string | null = null
      const text = await c.req.text()
      if (text.trim()) {
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          throw badRequest('Request body must be JSON')
        }
        const value = (body as { projectId?: unknown } | null)?.projectId
        if (value !== undefined && value !== null) {
          if (typeof value !== 'string') throw badRequest('"projectId" must be a string')
          if (!repo.projects.get(value)) throw notFound(`Project ${value} not found`)
          projectId = value
        }
      }
      return c.json(runner.create('selftest', { diagnostic: true }, projectId), 201)
    })
    .get('/:id', (c) => c.json(requireJob(c.req.param('id'))))
    .get('/:id/events', (c) => {
      const id = c.req.param('id')
      requireJob(id) // 404 as JSON before switching to an event stream

      return streamSSE(c, async (stream) => {
        // Serialize writes so events stay in order.
        let chain: Promise<void> = Promise.resolve()
        const send = (job: Job) => {
          chain = chain.then(() => stream.writeSSE({ event: 'job', id: job.updatedAt, data: JSON.stringify(job) }))
          return chain
        }

        let finish!: () => void
        const done = new Promise<void>((resolve) => (finish = resolve))

        // Subscribe before reading the current state so no change is missed.
        const unsubscribe = runner.subscribe(id, (job) => {
          void send(job)
          if (isTerminal(job)) finish()
        })
        const keepAlive = setInterval(() => {
          chain = chain.then(() => stream.write(': ping\n\n').then(() => undefined))
        }, KEEP_ALIVE_MS)
        stream.onAbort(() => finish())

        try {
          const current = runner.get(id)
          if (!current) throw new Error(`Job ${id} disappeared`)
          await send(current)
          if (isTerminal(current)) finish()
          await done
          await chain
        } finally {
          clearInterval(keepAlive)
          unsubscribe()
        }
      }, async (error, stream) => {
        console.error(`[sse job ${id}]`, error)
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: error.message }) })
      })
    })
}
