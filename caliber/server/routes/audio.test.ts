// /api/audio + the 'sfx' job + PATCH scene.audio, against a temp data dir and real SQLite.
// ZERO network: FAL is an injected fake, and global fetch is stubbed to throw so any
// accidental real call fails the test. The "downloaded" audio is a tiny mp3 made by ffmpeg.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, AudioTrack, Job, Project, SfxPreview } from '../../shared/types.ts'
import { createApp, createServices } from '../app.ts'
import { sfxRequestHash, type SfxNetwork } from '../jobs/sfx.ts'
import { buildSfxInput } from '../providers/elevenlabs.ts'
import { requestHash } from '../providers/requestHash.ts'

vi.mock('node:sqlite', () => createRequire(import.meta.url)('node:sqlite'))

const FFMPEG = existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg'

let fixtureDir: string
let mp3: Uint8Array
let dir: string
let services: ReturnType<typeof createServices>
let app: ReturnType<typeof createApp>
let network: { run: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> }

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'caliber-sfx-fixture-'))
  const file = path.join(fixtureDir, 'tone.mp3')
  // 0.3s silence + 1s tone + 0.3s silence, so post-processing has something to trim.
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=0.3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=0.3',
    '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-c:a', 'libmp3lame', '-b:a', '64k', file,
  ])
  mp3 = new Uint8Array(readFileSync(file))
})
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Real network access attempted in a test')
  }))
  network = {
    run: vi.fn(async (_endpoint: string, _input: unknown, hooks: Parameters<SfxNetwork['run']>[2]) => {
      const submitted = {
        endpoint: 'fal-ai/elevenlabs/sound-effects/v2',
        requestId: 'fake-req-1',
        statusUrl: 'https://fake.invalid/status',
        responseUrl: 'https://fake.invalid/response',
      }
      hooks.onSubmit(submitted)
      hooks.onStatus({ endpoint: submitted.endpoint, requestId: 'fake-req-1', status: 'IN_QUEUE', queuePosition: 2, logs: [], raw: {} })
      return { submitted, data: { audio: { url: 'https://fake.invalid/out.mp3' } } }
    }),
    download: vi.fn(async () => mp3),
  }
  dir = mkdtempSync(path.join(tmpdir(), 'caliber-audio-'))
  services = createServices(dir, { sfxNetwork: network as unknown as SfxNetwork })
  app = createApp(services)
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

const json = (url: string, body: unknown, method = 'POST') =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const req = { prompt: 'Mechanical watch ticking, close mic', loop: false, durationSeconds: 3 }

async function preview(body: unknown = req): Promise<SfxPreview & { providerRef: string | null; ledgerNote: string | null }> {
  const res = await json('/api/audio/preview', body)
  expect(res.status).toBe(200)
  return res.json() as never
}

async function waitForJob(id: string): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const job = services.runner.get(id)!
    if (job.status === 'succeeded' || job.status === 'failed') return job
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('POST /api/audio/preview', () => {
  it('builds the exact body and hash with no network', async () => {
    const p = await preview()
    const expectedBody = buildSfxInput({ text: req.prompt, loop: false, durationSeconds: 3 })
    expect(p.endpoint).toBe('fal-ai/elevenlabs/sound-effects/v2')
    expect(p.request).toEqual(expectedBody)
    expect(p.request).toEqual({ text: req.prompt, loop: false, prompt_influence: 0.3, output_format: 'mp3_44100_128', duration_seconds: 3 })
    expect(p.hash).toBe(requestHash('fal', 'fal-ai/elevenlabs/sound-effects/v2', expectedBody))
    expect(p.ledgerStatus).toBe('new')
    expect(p.existingAssets).toEqual([])
    expect(network.run).not.toHaveBeenCalled()
    expect(network.download).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  type Case = [string, Record<string, unknown>, string]
  const cases: Case[] = [
    ['empty prompt', { ...req, prompt: '   ' }, '"prompt" must be a non-empty string'],
    ['prompt too long', { ...req, prompt: 'x'.repeat(1001) }, 'at most 1000 characters'],
    ['duration too short', { ...req, durationSeconds: 0.4 }, '"durationSeconds" must be a number between 0.5 and 22'],
    ['duration too long', { ...req, durationSeconds: 23 }, '"durationSeconds" must be a number between 0.5 and 22'],
    ['duration string', { ...req, durationSeconds: '3' }, '"durationSeconds" must be a number'],
    ['influence > 1', { ...req, promptInfluence: 1.5 }, '"promptInfluence" must be a number between 0 and 1'],
    ['loop missing', { prompt: 'x' }, '"loop" must be a boolean'],
    ['loop not boolean', { ...req, loop: 'yes' }, '"loop" must be a boolean'],
    ['unknown key', { ...req, count: 2 }, 'Unknown field "count"'],
    ['approvedHash on preview', { ...req, approvedHash: 'abc' }, 'Unknown field "approvedHash"'],
  ]
  it.each(cases)('rejects %s with 400', async (_name, body, message) => {
    const res = await json('/api/audio/preview', body)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain(message)
  })

  it('reports an orphaned submitted ledger row with its providerRef', async () => {
    const p0 = await preview()
    services.repo.providerRequests.put({
      hash: p0.hash, provider: 'fal', endpoint: p0.endpoint, request: p0.request,
      status: 'submitted', providerRef: 'fal-orphan-42', response: null, outputs: {}, error: null,
    })
    const p = await preview()
    expect(p.ledgerStatus).toBe('submitted')
    expect(p.providerRef).toBe('fal-orphan-42')
    expect(p.ledgerNote).toContain('fal-orphan-42')
    expect(p.ledgerNote).toContain('will not be resent')

    const res = await json('/api/audio', { ...req, approvedHash: p.hash })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('fal-orphan-42')
    expect(network.run).not.toHaveBeenCalled()
  })
})

describe('POST /api/audio', () => {
  it('409s when the approved hash does not match, and sends nothing', async () => {
    const p = await preview()
    const res = await json('/api/audio', { ...req, durationSeconds: 4, approvedHash: p.hash })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('not the one you approved')
    expect(network.run).not.toHaveBeenCalled()
    expect(services.repo.providerRequests.get(p.hash)).toBeUndefined()
  })

  it('400s without approvedHash', async () => {
    const res = await json('/api/audio', req)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('approvedHash')
  })

  it('happy path: job -> asset + completed ledger; second POST is cached and sends nothing', async () => {
    const p = await preview()
    const res = await json('/api/audio', { ...req, approvedHash: p.hash })
    expect(res.status).toBe(201)
    const created = (await res.json()) as Job
    expect(created.kind).toBe('sfx')
    expect(created.steps.map((s) => s.key)).toEqual(['submit', 'generate', 'download', 'postprocess'])

    const job = await waitForJob(created.id)
    expect(job.error).toBeNull()
    expect(job.status).toBe('succeeded')
    expect(job.steps.every((s) => s.status === 'succeeded')).toBe(true)
    expect(job.steps.find((s) => s.key === 'submit')!.detail).toContain('fake-req-1')
    expect(job.steps.find((s) => s.key === 'generate')!.detail).toContain('queue position 2')
    const { assetIds } = job.result as { assetIds: string[] }
    expect(assetIds).toHaveLength(1)

    expect(network.run).toHaveBeenCalledTimes(1)
    expect(network.run.mock.calls[0][1]).toEqual(p.request)
    expect(network.download).toHaveBeenCalledWith('https://fake.invalid/out.mp3')

    const asset = services.repo.assets.get(assetIds[0])!
    expect(asset.kind).toBe('audio')
    expect(asset.projectId).toBeNull()
    expect(asset.key).toBe(`library/audio/${p.hash.slice(0, 12)}.mp3`)
    expect(asset.mime).toBe('audio/mpeg')
    expect(existsSync(path.join(dir, 'assets', asset.key))).toBe(true)
    expect(asset.meta.prompt).toBe(req.prompt)
    expect(asset.meta.loop).toBe(false)
    expect(asset.meta.requestHash).toBe(p.hash)
    expect(asset.meta.falRequestId).toBe('fake-req-1')
    const analysis = asset.meta.analysis as { postprocessed: boolean }
    expect(analysis.postprocessed).toBe(true)
    // 1.6s source, silence trimmed: measured duration is real and shorter.
    expect(asset.meta.durationSeconds as number).toBeGreaterThan(0.5)
    expect(asset.meta.durationSeconds as number).toBeLessThan(1.5)

    const record = services.repo.providerRequests.get(p.hash)!
    expect(record.status).toBe('completed')
    expect(record.providerRef).toBe('fake-req-1')
    expect(record.outputs).toEqual({ assetIds })

    const again = await preview()
    expect(again.ledgerStatus).toBe('completed')
    expect(again.existingAssets.map((a) => a.id)).toEqual(assetIds)

    const second = await json('/api/audio', { ...req, approvedHash: p.hash })
    expect(second.status).toBe(200)
    const cached = (await second.json()) as { cached: boolean; assets: Asset[] }
    expect(cached.cached).toBe(true)
    expect(cached.assets.map((a) => a.id)).toEqual(assetIds)
    expect(network.run).toHaveBeenCalledTimes(1)

    const library = (await (await app.request('/api/audio')).json()) as Asset[]
    expect(library.map((a) => a.id)).toEqual(assetIds)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('loops are not post-processed', async () => {
    const loopReq = { prompt: 'Rain on a window, ambience', loop: true }
    const p = await preview(loopReq)
    const job = await waitForJob(((await (await json('/api/audio', { ...loopReq, approvedHash: p.hash })).json()) as Job).id)
    expect(job.status).toBe('succeeded')
    const asset = services.repo.assets.get((job.result as { assetIds: string[] }).assetIds[0])!
    expect((asset.meta.analysis as { postprocessed: boolean }).postprocessed).toBe(false)
    expect(asset.meta.loop).toBe(true)
    expect(asset.meta.durationSeconds as number).toBeGreaterThan(1.5)
  })

  it('a provider failure fails the job and marks the ledger failed with the providerRef', async () => {
    network.run.mockImplementationOnce(async (_e: string, _i: unknown, hooks: Parameters<SfxNetwork['run']>[2]) => {
      hooks.onSubmit({ endpoint: 'x', requestId: 'fake-req-bad', statusUrl: 's', responseUrl: 'r' })
      throw new Error('FAL request failed: content policy')
    })
    const p = await preview()
    const job = await waitForJob(((await (await json('/api/audio', { ...req, approvedHash: p.hash })).json()) as Job).id)
    expect(job.status).toBe('failed')
    expect(job.error).toContain('content policy')
    expect(job.steps.find((s) => s.key === 'generate')!.status).toBe('failed')
    const record = services.repo.providerRequests.get(p.hash)!
    expect(record.status).toBe('failed')
    expect(record.providerRef).toBe('fake-req-bad')
    expect(services.library.listAudio()).toEqual([])
    const again = await preview()
    expect(again.ledgerStatus).toBe('failed')
    expect(again.ledgerNote).toContain('content policy')
  })

  it('hash matches sfxRequestHash for the rebuilt body', async () => {
    const p = await preview({ ...req, promptInfluence: 0.6 })
    expect(p.hash).toBe(sfxRequestHash(buildSfxInput({ text: req.prompt, loop: false, durationSeconds: 3, promptInfluence: 0.6 })))
  })
})

describe('PATCH scene.audio', () => {
  let projectId: string
  let audioAsset: Asset
  const track = (): AudioTrack => ({ assetId: audioAsset.id, volume: 0.8, offsetSeconds: 0, fadeInSeconds: 0.5, fadeOutSeconds: 1, loop: true })
  const patchScene = (audio: unknown) =>
    json(`/api/projects/${projectId}`, { scene: { presetId: null, placement: null, ...(audio === undefined ? {} : { audio }) } }, 'PATCH')

  beforeEach(async () => {
    projectId = ((await (await json('/api/projects', { name: 'Audio test' })).json()) as Project).id
    audioAsset = services.repo.assets.create({
      projectId: null, kind: 'audio', key: 'library/audio/test.mp3', filename: 'test.mp3', mime: 'audio/mpeg', bytes: 1, meta: {},
    })
  })

  it('stores, keeps on omission, and clears with null', async () => {
    const res = await patchScene(track())
    expect(res.status).toBe(200)
    expect(((await res.json()) as Project).scene.audio).toEqual(track())

    const kept = (await (await patchScene(undefined)).json()) as Project
    expect(kept.scene.audio).toEqual(track())
    const renamed = (await (await json(`/api/projects/${projectId}`, { name: 'R' }, 'PATCH')).json()) as Project
    expect(renamed.scene.audio).toEqual(track())

    const cleared = (await (await patchScene(null)).json()) as Project
    expect(cleared.scene.audio).toBeNull()
    const reread = (await (await app.request(`/api/projects/${projectId}`)).json()) as Project
    expect(reread.scene.audio).toBeNull()
  })

  it('404s for a missing or non-library or non-audio asset', async () => {
    expect((await patchScene({ ...track(), assetId: 'nope' })).status).toBe(404)
    const projectAudio = services.repo.assets.create({
      projectId, kind: 'audio', key: `projects/${projectId}/a.mp3`, filename: 'a.mp3', mime: 'audio/mpeg', bytes: 1, meta: {},
    })
    expect((await patchScene({ ...track(), assetId: projectAudio.id })).status).toBe(404)
    const notAudio = services.repo.assets.create({
      projectId: null, kind: 'world-pano', key: 'presets/x/pano.png', filename: 'pano.png', mime: 'image/png', bytes: 1, meta: {},
    })
    const res = await patchScene({ ...track(), assetId: notAudio.id })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toContain('Library audio asset')
  })

  type Case = [string, (t: any) => void, string]
  const cases: Case[] = [
    ['volume > 1', (t) => (t.volume = 1.2), '"scene.audio.volume" must be between 0 and 1'],
    ['volume < 0', (t) => (t.volume = -0.1), '"scene.audio.volume" must be between 0 and 1'],
    ['negative offset', (t) => (t.offsetSeconds = -1), '"scene.audio.offsetSeconds" must be >= 0'],
    ['fade in > 5', (t) => (t.fadeInSeconds = 6), '"scene.audio.fadeInSeconds" must be between 0 and 5'],
    ['fade out < 0', (t) => (t.fadeOutSeconds = -1), '"scene.audio.fadeOutSeconds" must be between 0 and 5'],
    ['loop not boolean', (t) => (t.loop = 1), '"scene.audio.loop" must be a boolean'],
    ['assetId empty', (t) => (t.assetId = ''), '"scene.audio.assetId" must be a non-empty string'],
    ['volume NaN-ish', (t) => (t.volume = 'loud'), '"scene.audio.volume" must be a finite number'],
    ['missing field', (t) => delete t.fadeInSeconds, 'Missing field "scene.audio.fadeInSeconds"'],
    ['unknown field', (t) => (t.pan = 0), 'Unknown field "scene.audio.pan"'],
  ]
  it.each(cases)('rejects %s with 400 and keeps the stored track', async (_name, mutate, message) => {
    await patchScene(track())
    const t = track()
    mutate(t)
    const res = await patchScene(t)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain(message)
    const reread = (await (await app.request(`/api/projects/${projectId}`)).json()) as Project
    expect(reread.scene.audio).toEqual(track())
  })
})
