// /api/projects/:id/exports and /exports/<key>, against a temp data dir. No network.
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, Project } from '../../shared/types.ts'
import { createApp, createServices } from '../app.ts'
import { HttpError } from './errors.ts'
import { exportApiRoutes, hasFtypBox, slugify } from './exports.ts'

vi.mock('node:sqlite', () => createRequire(import.meta.url)('node:sqlite'))

let dir: string
let app: ReturnType<typeof createApp>
let services: ReturnType<typeof createServices>
let projectId: string

/** Smallest thing the route accepts: an 'ftyp' box header plus a few bytes. */
function tinyMp4(extra = 32): Uint8Array {
  const bytes = new Uint8Array(16 + extra)
  bytes.set([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])
  for (let i = 16; i < bytes.length; i++) bytes[i] = i % 251
  return bytes
}

const post = (body: Uint8Array, query = 'label=Push%20in') =>
  app.request(`/api/projects/${projectId}/exports?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4' },
    body,
  })

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'caliber-exports-'))
  services = createServices(dir)
  app = createApp(services)
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Export test' }),
  })
  projectId = ((await res.json()) as Project).id
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('helpers', () => {
  it('detects the ftyp box', () => {
    expect(hasFtypBox(tinyMp4())).toBe(true)
    expect(hasFtypBox(new TextEncoder().encode('hello world!'))).toBe(false)
    expect(hasFtypBox(new Uint8Array(4))).toBe(false)
  })
  it('slugifies labels', () => {
    expect(slugify('Push in — 4s!')).toBe('push-in-4s')
    expect(slugify('***')).toBe('export')
  })
})

describe('POST /api/projects/:id/exports', () => {
  it('rejects a non-MP4 body with 400 and saves nothing', async () => {
    const res = await post(new TextEncoder().encode('this is definitely not an mp4 file'))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/ftyp/)
    expect(existsSync(path.join(dir, 'exports', projectId))).toBe(false)
    expect(services.repo.assets.listByProject(projectId, 'export')).toEqual([])
  })

  it('rejects a body shorter than the box header', async () => {
    const res = await post(new Uint8Array([0, 0, 0]))
    expect(res.status).toBe(400)
  })

  it('requires a label', async () => {
    const res = await post(tinyMp4(), '')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/label/)
  })

  it('404s for an unknown project', async () => {
    const res = await app.request('/api/projects/nope/exports?label=x', { method: 'POST', body: tinyMp4() })
    expect(res.status).toBe(404)
  })

  it('accepts a tiny valid file, writes it under data/exports/<projectId>/ and records an export asset', async () => {
    const bytes = tinyMp4()
    const res = await post(bytes, 'label=Push%20in&durationSeconds=4&preset=vertical-1080x1920-30')
    expect(res.status).toBe(201)
    const asset = (await res.json()) as Asset
    expect(asset.kind).toBe('export')
    expect(asset.projectId).toBe(projectId)
    expect(asset.mime).toBe('video/mp4')
    expect(asset.bytes).toBe(bytes.length)
    expect(asset.filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-push-in\.mp4$/)
    expect(asset.key).toBe(`exports/${projectId}/${asset.filename}`)
    expect(asset.url).toBe(`/exports/${projectId}/${asset.filename}`)
    expect(asset.meta).toEqual({ label: 'Push in', bytes: bytes.length, durationSeconds: 4, preset: 'vertical-1080x1920-30' })
    const onDisk = readFileSync(path.join(dir, 'exports', projectId, asset.filename))
    expect(new Uint8Array(onDisk)).toEqual(bytes)
  })

  it('returns 413 past the size cap and keeps no file', async () => {
    // Same services and storage, but a route with a 40-byte cap.
    const capped = new Hono().route('/api/projects', exportApiRoutes(services, 40))
    capped.onError((e, c) => c.json({ error: e.message }, e instanceof HttpError ? e.status : 500))
    const res = await capped.request(`/api/projects/${projectId}/exports?label=big`, { method: 'POST', body: tinyMp4(64) })
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toMatch(/limit/)
    expect(existsSync(path.join(dir, 'exports', projectId))).toBe(false)
  })

  it('rejects bad durationSeconds', async () => {
    const res = await post(tinyMp4(), 'label=x&durationSeconds=abc')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/projects/:id/exports', () => {
  it('lists exports newest first, only kind export', async () => {
    const a = (await (await post(tinyMp4(), 'label=first')).json()) as Asset
    await new Promise((r) => setTimeout(r, 5))
    const b = (await (await post(tinyMp4(), 'label=second')).json()) as Asset
    const res = await app.request(`/api/projects/${projectId}/exports`)
    expect(res.status).toBe(200)
    const list = (await res.json()) as Asset[]
    expect(list.map((x) => x.id)).toEqual([b.id, a.id])
  })
})

describe('GET /exports/<key>', () => {
  it('serves the file with video/mp4 and honors Range', async () => {
    const bytes = tinyMp4(100)
    const asset = (await (await post(bytes)).json()) as Asset

    const full = await app.request(asset.url)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('video/mp4')
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes)

    const part = await app.request(asset.url, { headers: { range: 'bytes=4-7' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 4-7/${bytes.length}`)
    expect(new TextDecoder().decode(await part.arrayBuffer())).toBe('ftyp')

    const bad = await app.request(asset.url, { headers: { range: `bytes=${bytes.length + 10}-` } })
    expect(bad.status).toBe(416)
  })

  it('404s for missing files and 400s for traversal', async () => {
    expect((await app.request('/exports/nope/missing.mp4')).status).toBe(404)
    expect((await app.request('/exports/x%2F..%2F..%2Fcaliber.db')).status).toBe(400)
  })
})
