import { Readable } from 'node:stream'
import { Hono } from 'hono'
import type { Services } from '../app.ts'
import { mimeFor } from '../storage/mime.ts'
import { badRequest, notFound } from './errors.ts'

/** Serves /assets/<key> from storage with MIME, Content-Length and byte ranges. */
export function assetRoutes(services: Services) {
  const { storage } = services

  return new Hono().on(['GET', 'HEAD'], '/*', async (c) => {
    const rawKey = c.req.path.replace(/^\/assets\//, '')
    let key: string
    try {
      key = decodeURIComponent(rawKey)
    } catch {
      throw badRequest(`Invalid asset path: ${rawKey}`)
    }
    // Decode first, then check, so encoded separators (%2F, %2e%2e) can't sneak past.
    if (
      !key ||
      key.includes('\0') ||
      key.includes('\\') ||
      key.startsWith('/') ||
      key.split('/').some((part) => part === '..' || part === '.' || part === '')
    ) {
      throw badRequest(`Invalid asset path: ${rawKey}`)
    }

    const info = await storage.stat(key)
    if (!info) throw notFound(`Asset not found: ${key}`)

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
      // storage rejects keys that resolve outside its root
      throw badRequest(error instanceof Error ? error.message : String(error))
    }
    return new Response(Readable.toWeb(nodeStream) as ReadableStream, { status, headers })
  })
}

/**
 * Parses a single "bytes=" range. Returns undefined when absent or not a
 * byte range we handle (multi-range) — the full file is served then.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined
  const [, startText, endText] = match
  if (!startText && !endText) return undefined
  let start: number
  let end: number
  if (!startText) {
    const suffix = Number(endText)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText ? Math.min(Number(endText), size - 1) : size - 1
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}
