import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { Hono } from 'hono'
import type { Asset } from '../../shared/types.ts'
import type { Services } from '../app.ts'
import type { AssetStorage } from '../storage/storage.ts'
import { mimeFor } from '../storage/mime.ts'
import { parseRange } from './assets.ts'
import { HttpError, badRequest, notFound } from './errors.ts'

/** Hard cap on one uploaded export. A 60 s 1080p60 export at 22 Mbps is ~165 MB. */
export const MAX_EXPORT_BYTES = 2 * 1024 * 1024 * 1024

/** Asset keys for exports carry this prefix; app.ts maps it to the exports storage URL. */
export const EXPORT_KEY_PREFIX = 'exports/'

const tooLarge = (limit: number) =>
  new HttpError(413, `Export is larger than the ${Math.round(limit / (1024 * 1024))} MB limit`)

/** ISO-BMFF files start with a box whose type (bytes 4–8) is 'ftyp'. */
export function hasFtypBox(head: Uint8Array): boolean {
  return head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
}

export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return slug || 'export'
}

/** 2026-10-06T12:30:45.123Z -> 2026-10-06T12-30-45-123Z (safe in filenames everywhere). */
export const fileTimestamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-')

function optionalNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw badRequest(`"${name}" must be a positive number, got ${value}`)
  return n
}

/**
 * Streams the request body to `filePath`, never holding more than one chunk in memory.
 * Rejects (and leaves cleanup to the caller) on a non-MP4 head or once `limit` is passed.
 */
async function streamBodyToFile(body: ReadableStream<Uint8Array>, filePath: string, limit: number): Promise<number> {
  const out = createWriteStream(filePath)
  const reader = body.getReader()
  let bytes = 0
  let head = new Uint8Array(0)
  let checked = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) throw tooLarge(limit)
      if (!checked) {
        const joined = new Uint8Array(head.length + value.length)
        joined.set(head)
        joined.set(value, head.length)
        head = joined.subarray(0, 8)
        if (head.length >= 8) {
          if (!hasFtypBox(head)) throw badRequest("Body is not an MP4: missing the ISO-BMFF 'ftyp' box at bytes 4–8")
          checked = true
        }
      }
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', resolve))
    }
    if (!checked) throw badRequest(`Body is not an MP4: only ${bytes} byte(s) received`)
    out.end()
    await finished(out)
    return bytes
  } catch (error) {
    await reader.cancel().catch(() => {})
    out.destroy()
    throw error
  }
}

/** POST/GET /api/projects/:id/exports. */
export function exportApiRoutes(services: Services, limit = MAX_EXPORT_BYTES) {
  const { repo, exportStorage } = services

  const requireProject = (id: string) => {
    if (!repo.projects.get(id)) throw notFound(`Project ${id} not found`)
  }

  return new Hono()
    .get('/:id/exports', (c) => {
      const projectId = c.req.param('id')
      requireProject(projectId)
      const list = repo.assets
        .listByProject(projectId, 'export')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.key.localeCompare(a.key))
      return c.json(list)
    })
    .post('/:id/exports', async (c) => {
      const projectId = c.req.param('id')
      requireProject(projectId)

      const label = (c.req.query('label') ?? '').trim()
      if (!label) throw badRequest('"label" query parameter is required')
      if (label.length > 200) throw badRequest('"label" must be at most 200 characters')
      const durationSeconds = optionalNumber(c.req.query('durationSeconds'), 'durationSeconds')
      const preset = c.req.query('preset')?.trim() || undefined

      const declared = c.req.header('content-length')
      if (declared !== undefined && Number(declared) > limit) throw tooLarge(limit)
      const body = c.req.raw.body
      if (!body) throw badRequest('Request body is empty; expected MP4 bytes')

      const tempDir = await mkdtemp(path.join(tmpdir(), 'caliber-export-'))
      const tempFile = path.join(tempDir, 'upload.mp4')
      try {
        const bytes = await streamBodyToFile(body, tempFile, limit)
        const filename = `${fileTimestamp(new Date())}-${slugify(label)}.mp4`
        const storageKey = `${projectId}/${filename}`
        await exportStorage.saveFromFile(storageKey, tempFile)
        const meta: Record<string, unknown> = { label, bytes }
        if (durationSeconds !== undefined) meta.durationSeconds = durationSeconds
        if (preset !== undefined) meta.preset = preset
        const asset: Asset = repo.assets.create({
          projectId,
          kind: 'export',
          key: `${EXPORT_KEY_PREFIX}${storageKey}`,
          filename,
          mime: mimeFor(filename),
          bytes,
          meta,
        })
        return c.json(asset, 201)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
}

/** GET/HEAD /exports/<key> with MIME, Content-Length and byte ranges (same behavior as /assets). */
export function exportFileRoutes(services: Services) {
  return storageFileRoutes(services.exportStorage, '/exports/')
}

function storageFileRoutes(storage: AssetStorage, prefix: string) {
  return new Hono().on(['GET', 'HEAD'], '/*', async (c) => {
    const rawKey = c.req.path.slice(c.req.path.indexOf(prefix) + prefix.length)
    let key: string
    try {
      key = decodeURIComponent(rawKey)
    } catch {
      throw badRequest(`Invalid export path: ${rawKey}`)
    }
    if (
      !key ||
      key.includes('\0') ||
      key.includes('\\') ||
      key.startsWith('/') ||
      key.split('/').some((part) => part === '..' || part === '.' || part === '')
    ) {
      throw badRequest(`Invalid export path: ${rawKey}`)
    }

    const info = await storage.stat(key)
    if (!info) throw notFound(`Export not found: ${key}`)

    const size = info.size
    const headers = new Headers({
      'Content-Type': mimeFor(key),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    })

    const range = parseRange(c.req.header('range'), size)
    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${size}`)
      headers.set('Content-Type', 'application/json')
      return new Response(JSON.stringify({ error: `Range not satisfiable for ${key} (size ${size})` }), {
        status: 416,
        headers,
      })
    }

    const status = range ? 206 : 200
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    const length = size === 0 ? 0 : end - start + 1
    headers.set('Content-Length', String(length))
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)

    if (c.req.method === 'HEAD' || length === 0) return new Response(null, { status, headers })
    let nodeStream: Readable
    try {
      nodeStream = storage.read(key, { start, end }) as Readable
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error))
    }
    return new Response(Readable.toWeb(nodeStream) as ReadableStream, { status, headers })
  })
}
