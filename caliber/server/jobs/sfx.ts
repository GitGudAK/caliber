// Job kind 'sfx': one FAL ElevenLabs sound-effects generation -> one library audio asset.
//
// Paid. The route only creates this job after the user approved the exact request hash
// (POST /api/audio echoes approvedHash), and the whole provider call runs inside
// runPaidRequest, so a completed request is never sent twice.
//
// Steps: submit (FAL accepted the request, providerRef known) -> generate (queue/progress
// polling) -> download (audio.url into a temp file) -> postprocess (ffmpeg analysis; trim +
// loudness-normalize unless it is a loop) -> asset row + file at library/audio/<hash12>.mp3.
//
// Server restarts: the in-process runner marks interrupted jobs 'failed' on boot, but the
// provider_requests row deliberately stays 'submitted'. We cannot know whether FAL accepted
// (and charged for) the request, so it must never be resent automatically. POST
// /api/audio/preview reports that row with its providerRef (the FAL request id, recorded as
// soon as submit returns) and POST /api/audio answers 409 with the same explanation. The user
// checks the request on FAL by that id and resolves the ledger row by hand.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SfxRequestInput } from '../../shared/types.ts'
import type { Repository } from '../db/repository.ts'
import { requireKey } from '../env.ts'
import {
  analyzeAndPostprocessAudio,
  buildSfxInput,
  ELEVENLABS_SFX_ENDPOINT,
  ELEVENLABS_SFX_POLL_MS,
  sfxAudioFile,
  type AudioTools,
  type PostprocessResult,
  type SfxInput,
} from '../providers/elevenlabs.ts'
import { runFal, type FalStatusUpdate, type FalSubmitted } from '../providers/fal.ts'
import { fetchBytes } from '../providers/http.ts'
import { requestHash } from '../providers/requestHash.ts'
import { mimeFor } from '../storage/mime.ts'
import type { AssetStorage } from '../storage/storage.ts'
import { runPaidRequest } from './paidRequest.ts'
import type { JobRunner } from './runner.ts'

export const SFX_PROVIDER = 'fal' as const
export const SFX_ENDPOINT = ELEVENLABS_SFX_ENDPOINT

/** The network layer, injectable so tests never reach FAL. */
export interface SfxNetwork {
  run(
    endpoint: string,
    input: SfxInput,
    hooks: { onSubmit: (submitted: FalSubmitted) => void; onStatus: (update: FalStatusUpdate) => void },
  ): Promise<{ submitted: FalSubmitted; data: unknown }>
  download(url: string): Promise<Uint8Array>
}

/** Real FAL. The key is read at call time, so a missing key fails the job with a clear message. */
export function createFalSfxNetwork(): SfxNetwork {
  return {
    async run(endpoint, input, hooks) {
      const { submitted, data } = await runFal(endpoint, input, {
        apiKey: requireKey('FAL_KEY'),
        fetch,
        intervalMs: ELEVENLABS_SFX_POLL_MS,
        onSubmit: hooks.onSubmit,
        onStatus: hooks.onStatus,
      })
      return { submitted, data }
    },
    download: (url) => fetchBytes(url, { fetch, provider: 'FAL' }),
  }
}

/** The exact FAL body for a validated SfxRequestInput (count is always 1 per request). */
export function buildSfxRequest(input: SfxRequestInput): SfxInput {
  return buildSfxInput({
    text: input.prompt,
    loop: input.loop,
    durationSeconds: input.durationSeconds,
    promptInfluence: input.promptInfluence,
  })
}

export function sfxRequestHash(body: SfxInput): string {
  return requestHash(SFX_PROVIDER, SFX_ENDPOINT, body)
}

export const sfxStorageKey = (hash: string) => `library/audio/${hash.slice(0, 12)}.mp3`

export interface SfxJobInput {
  request: SfxRequestInput
  /** The hash the user approved; the job refuses to run if the rebuilt body differs. */
  approvedHash: string
}

export interface SfxJobResult {
  assetIds: string[]
}

export const SFX_STEPS = [
  { key: 'submit', label: 'Submit to FAL ElevenLabs' },
  { key: 'generate', label: 'Generate sound effect' },
  { key: 'download', label: 'Download audio' },
  { key: 'postprocess', label: 'Analyze / trim / normalize' },
]

export function registerSfx(
  runner: JobRunner,
  deps: { repo: Repository; storage: AssetStorage; network: SfxNetwork; tools?: AudioTools },
) {
  const { repo, storage, network, tools } = deps

  runner.register<SfxJobInput, SfxJobResult>('sfx', {
    steps: SFX_STEPS,
    async run(input, ctx) {
      const body = buildSfxRequest(input.request)
      const hash = sfxRequestHash(body)
      if (hash !== input.approvedHash) {
        throw new Error(`Request hash ${hash} does not match the approved hash ${input.approvedHash}; nothing was sent.`)
      }

      const { record, cached } = await runPaidRequest({
        repo,
        provider: SFX_PROVIDER,
        endpoint: SFX_ENDPOINT,
        body,
        displayBody: body,
        send: async ({ onProviderRef }) => {
          let markSubmitted!: (s: FalSubmitted) => void
          let failSubmit!: (e: unknown) => void
          const submitted = new Promise<FalSubmitted>((resolve, reject) => {
            markSubmitted = resolve
            failSubmit = reject
          })

          const call = network.run(SFX_ENDPOINT, body, {
            onSubmit: (s) => {
              onProviderRef(s.requestId)
              ctx.detail('submit', `FAL request ${s.requestId}`)
              markSubmitted(s)
            },
            onStatus: (update) => ctx.detail('generate', describeStatus(update)),
          })
          // If submit itself fails, the submit step fails with that error.
          call.catch(failSubmit)

          await ctx.step('submit', () => submitted)
          ctx.progress(0.1)
          const { submitted: sub, data } = await ctx.step('generate', () => call)
          ctx.progress(0.7)

          const audio = sfxAudioFile(data)
          const workDir = await mkdtemp(path.join(tmpdir(), 'caliber-sfx-'))
          try {
            const localPath = path.join(workDir, 'audio.mp3')
            await ctx.step('download', async () => {
              const bytes = await network.download(audio.url)
              if (bytes.byteLength === 0) throw new Error(`FAL returned an empty audio file (${audio.url})`)
              await writeFile(localPath, bytes)
              ctx.detail('download', `${bytes.byteLength} bytes`)
            })
            ctx.progress(0.8)

            const analysis: PostprocessResult = await ctx.step('postprocess', async () => {
              const result = await analyzeAndPostprocessAudio(localPath, {
                extension: '.mp3',
                postprocess: !body.loop,
                tools,
              })
              ctx.detail(
                'postprocess',
                result.postprocessed
                  ? `Trimmed ${result.trimmed_seconds?.total ?? 0}s, normalized; ${result.after.duration_seconds}s`
                  : `Loop: left untouched (${result.before.duration_seconds}s)`,
              )
              return result
            })

            const key = sfxStorageKey(hash)
            const saved = await storage.saveFromFile(key, localPath)
            const asset = repo.assets.create({
              projectId: null,
              kind: 'audio',
              key,
              filename: path.basename(key),
              mime: mimeFor(key),
              bytes: saved.bytes,
              meta: {
                prompt: input.request.prompt,
                loop: body.loop,
                durationSeconds: analysis.after.duration_seconds ?? null,
                analysis,
                requestHash: hash,
                falRequestId: sub.requestId,
              },
            })
            return { providerRef: sub.requestId, response: data, outputs: { assetIds: [asset.id] } }
          } finally {
            await rm(workDir, { recursive: true, force: true })
          }
        },
      })

      if (cached) {
        for (const s of SFX_STEPS) ctx.detail(s.key, 'Already generated; reused the library asset (nothing sent)')
      }
      return { assetIds: record.outputs.assetIds ?? [] }
    },
  })
}

function describeStatus(update: FalStatusUpdate): string {
  const parts = [update.status]
  if (update.queuePosition !== undefined) parts.push(`queue position ${update.queuePosition}`)
  const last = update.logs.at(-1)?.message
  if (last) parts.push(last)
  return parts.join(' · ')
}
