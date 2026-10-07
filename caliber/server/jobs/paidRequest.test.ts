// Real SQLite repository on a temp file; send() is a fake. No network.
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteRepository, type Repository } from '../db/repository.ts'
import { openDatabase } from '../db/sqlite.ts'
import { requestHash } from '../providers/requestHash.ts'
import { RequestInFlightError, runPaidRequest } from './paidRequest.ts'

// Vitest 2 (vite 5) strips the "node:" prefix from node:sqlite and then fails to
// resolve "sqlite". Hand it the real built-in module.
vi.mock('node:sqlite', () => createRequire(import.meta.url)('node:sqlite'))

let dir: string
let repo: Repository

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'caliber-paid-'))
  repo = createSqliteRepository(openDatabase(path.join(dir, 'test.db')), (key) => `/assets/${key}`)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const body = { prompt: 'oak desk', image: 'AAAA' }
const base = { provider: 'fal' as const, endpoint: 'fal-ai/nano-banana-2', body, displayBody: { prompt: 'oak desk', image: '[base64 3 bytes]' } }

describe('runPaidRequest', () => {
  it('sends once, records completed, then serves the cache without calling send', async () => {
    const send = vi.fn(async () => ({ providerRef: 'req-1', response: { ok: 1 }, outputs: { assetIds: ['a1'] } }))
    const first = await runPaidRequest({ repo, ...base, send })
    expect(first.cached).toBe(false)
    expect(first.record.status).toBe('completed')
    expect(first.record.hash).toBe(requestHash('fal', 'fal-ai/nano-banana-2', body))
    expect(first.record.request).toEqual(base.displayBody)
    expect(first.record.providerRef).toBe('req-1')

    const second = await runPaidRequest({ repo, ...base, send })
    expect(second.cached).toBe(true)
    expect(second.record.outputs).toEqual({ assetIds: ['a1'] })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a different body is a different request', async () => {
    const send = vi.fn(async () => ({ providerRef: null, response: null, outputs: {} }))
    await runPaidRequest({ repo, ...base, send })
    await runPaidRequest({ repo, ...base, body: { ...body, image: 'BBBB' }, send })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('records a failure with its message and rethrows; a failed record may be retried', async () => {
    const failing = vi.fn(async ({ onProviderRef }: { onProviderRef: (r: string) => void }) => {
      onProviderRef('req-9')
      throw new Error('FAL 422: bad prompt')
    })
    await expect(runPaidRequest({ repo, ...base, send: failing })).rejects.toThrow('FAL 422: bad prompt')
    const hash = requestHash('fal', 'fal-ai/nano-banana-2', body)
    const failed = repo.providerRequests.get(hash)!
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('FAL 422: bad prompt')
    expect(failed.providerRef).toBe('req-9')

    const ok = vi.fn(async () => ({ providerRef: 'req-10', response: {}, outputs: {} }))
    const retried = await runPaidRequest({ repo, ...base, send: ok })
    expect(ok).toHaveBeenCalledTimes(1)
    expect(retried.record.status).toBe('completed')
    expect(retried.record.error).toBeNull()
  })

  it('refuses to resend a request that is submitted (in flight or interrupted)', async () => {
    const hash = requestHash('fal', 'fal-ai/nano-banana-2', body)
    repo.providerRequests.put({
      hash, provider: 'fal', endpoint: base.endpoint, request: base.displayBody,
      status: 'submitted', providerRef: 'req-live', response: null, outputs: {}, error: null,
    })
    const send = vi.fn(async () => ({ providerRef: null, response: null, outputs: {} }))
    const attempt = runPaidRequest({ repo, ...base, send })
    await expect(attempt).rejects.toBeInstanceOf(RequestInFlightError)
    await expect(runPaidRequest({ repo, ...base, send })).rejects.toThrow(/req-live/)
    expect(send).not.toHaveBeenCalled()
    expect(repo.providerRequests.get(hash)!.status).toBe('submitted')
  })

  it('leaves a submitted record while send is running', async () => {
    let seen: string | undefined
    await runPaidRequest({
      repo, ...base,
      send: async ({ hash }) => {
        seen = repo.providerRequests.get(hash)!.status
        return { providerRef: null, response: null, outputs: {} }
      },
    })
    expect(seen).toBe('submitted')
  })
})
