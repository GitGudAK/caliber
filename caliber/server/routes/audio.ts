// Library audio (FAL ElevenLabs SFX). See shared/api.ts for the contract and
// server/jobs/sfx.ts for the paid job.
//
// preview: no network. Builds the exact request body, fingerprints it, and reports what the
// ledger knows. A 'submitted' row (in flight, or orphaned by a server restart) is reported
// with its providerRef so the user can check FAL before doing anything; it is never resent.
import { Hono } from 'hono'
import type { Asset, ProviderRequestRecord, SfxPreview, SfxRequestInput } from '../../shared/types.ts'
import type { Services } from '../app.ts'
import { buildSfxRequest, SFX_ENDPOINT, sfxRequestHash, type SfxJobInput } from '../jobs/sfx.ts'
import { RequestInFlightError } from '../jobs/paidRequest.ts'
import { readJsonObject } from './body.ts'
import { badRequest, HttpError } from './errors.ts'

export const SFX_PROMPT_MAX = 1000

const SFX_KEYS = ['prompt', 'durationSeconds', 'loop', 'promptInfluence']

/** Strict parse of SfxRequestInput (plus any extra allowed keys, which are returned untouched). */
export function parseSfxRequest(body: Record<string, unknown>, extraKeys: string[] = []): SfxRequestInput {
  const allowed = [...SFX_KEYS, ...extraKeys]
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw badRequest(`Unknown field "${key}" (expected ${allowed.join(', ')})`)
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw badRequest('"prompt" must be a non-empty string')
  const prompt = body.prompt.trim()
  if (prompt.length > SFX_PROMPT_MAX) {
    throw badRequest(`"prompt" must be at most ${SFX_PROMPT_MAX} characters (got ${prompt.length})`)
  }
  if (typeof body.loop !== 'boolean') throw badRequest(`"loop" must be a boolean (got ${JSON.stringify(body.loop)})`)

  const input: SfxRequestInput = { prompt, loop: body.loop }
  if (body.durationSeconds !== undefined) {
    const d = body.durationSeconds
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0.5 || d > 22) {
      throw badRequest(`"durationSeconds" must be a number between 0.5 and 22 (got ${JSON.stringify(d)})`)
    }
    input.durationSeconds = d
  }
  if (body.promptInfluence !== undefined) {
    const p = body.promptInfluence
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      throw badRequest(`"promptInfluence" must be a number between 0 and 1 (got ${JSON.stringify(p)})`)
    }
    input.promptInfluence = p
  }
  return input
}

const conflict = (message: string) => new HttpError(409, message)

export function audioRoutes(services: Services) {
  const { repo, runner } = services

  const outputAssets = (record: ProviderRequestRecord | undefined): Asset[] =>
    record?.status === 'completed'
      ? (record.outputs.assetIds ?? []).map((id) => repo.assets.get(id)).filter((a): a is Asset => !!a)
      : []

  return new Hono()
    .get('/', (c) => c.json(services.library.listAudio()))
    .post('/preview', async (c) => {
      const input = parseSfxRequest(await readJsonObject(c.req.raw))
      const request = buildSfxRequest(input)
      const hash = sfxRequestHash(request)
      const record = repo.providerRequests.get(hash)
      const preview: SfxPreview & {
        providerRef: string | null
        ledgerUpdatedAt: string | null
        ledgerError: string | null
        ledgerNote: string | null
      } = {
        endpoint: SFX_ENDPOINT,
        request,
        hash,
        ledgerStatus: record?.status ?? 'new',
        existingAssets: outputAssets(record),
        providerRef: record?.providerRef ?? null,
        ledgerUpdatedAt: record?.updatedAt ?? null,
        ledgerError: record?.error ?? null,
        ledgerNote: record ? ledgerNote(record) : null,
      }
      return c.json(preview)
    })
    .post('/', async (c) => {
      const body = await readJsonObject(c.req.raw)
      const input = parseSfxRequest(body, ['approvedHash'])
      if (typeof body.approvedHash !== 'string' || !body.approvedHash) {
        throw badRequest('"approvedHash" is required: preview the request first and approve its hash')
      }
      const hash = sfxRequestHash(buildSfxRequest(input))
      if (hash !== body.approvedHash) {
        throw conflict(
          `This request (hash ${hash}) is not the one you approved (hash ${body.approvedHash}). ` +
            'Nothing was sent. Preview it again and approve the new request.',
        )
      }
      const record = repo.providerRequests.get(hash)
      if (record?.status === 'completed') return c.json({ cached: true as const, assets: outputAssets(record) }, 200)
      if (record?.status === 'submitted') throw conflict(new RequestInFlightError(record).message)
      const jobInput: SfxJobInput = { request: input, approvedHash: hash }
      return c.json(runner.create('sfx', jobInput, null), 201)
    })
}

function ledgerNote(record: ProviderRequestRecord): string | null {
  switch (record.status) {
    case 'completed':
      return 'Already generated. Approving reuses the library asset; nothing is sent or paid.'
    case 'submitted':
      return (
        `This exact request was sent ${record.providerRef ? `(FAL request ${record.providerRef}) ` : '(no FAL request id was recorded) '}` +
        `and has not finished as of ${record.updatedAt}. It may still be running, or the local server restarted mid-job. ` +
        'It will not be resent: FAL may already have charged for it. Check the request on FAL, then resolve the provider_requests row by hand.'
      )
    case 'failed':
      return `The last attempt failed: ${record.error ?? 'unknown error'}. Approving sends it again (a new paid request).`
  }
}
