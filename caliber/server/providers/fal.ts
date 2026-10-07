// FAL queue client. Ported from image-blaster .claude/scripts/asset-pipeline/fal-queue.mjs
// (submitFalQueue / pollFalQueue / getFalQueueResult / collectRemoteFiles).
//
// Deviations from image-blaster:
// - API key and fetch are injected (no .env reading here); keeps tests key-free.
// - Errors include the provider's response body message (image-blaster drops it).
// - Abortable via AbortSignal; poll interval and onStatus are per call.
// - No metadata file writes; the job runner owns persistence.
// - A FAILED-style status is not part of FAL's QueueStatus enum (IN_QUEUE |
//   IN_PROGRESS | COMPLETED per the public OpenAPI), so like image-blaster we only
//   treat `COMPLETED` + `error` as failure. Result fetch will also surface errors.

import { type FetchLike, ProviderError, providerHttpError, readBody, sleep } from './http.ts'

export const FAL_QUEUE_BASE = 'https://queue.fal.run'
export const FAL_DEFAULT_POLL_MS = 5000

export interface FalAuth {
  apiKey: string
  fetch: FetchLike
  signal?: AbortSignal
}

export interface FalSubmitted {
  endpoint: string
  requestId: string
  statusUrl: string
  responseUrl: string
  cancelUrl?: string
}

export interface FalStatusUpdate {
  endpoint: string
  requestId: string
  status: string
  queuePosition?: number
  logs: Array<{ message: string; timestamp?: string; level?: string }>
  raw: Record<string, unknown>
}

/** Pure: the exact HTTP request a FAL submit will make (minus the key), for approval UI. */
export function buildFalSubmitRequest(endpoint: string, input: unknown) {
  return {
    method: 'POST' as const,
    url: `${FAL_QUEUE_BASE}/${endpoint}`,
    headers: { Authorization: 'Key <FAL_KEY>', 'Content-Type': 'application/json' },
    body: input,
  }
}

export async function submitFal(endpoint: string, input: unknown, auth: FalAuth): Promise<FalSubmitted> {
  const response = await auth.fetch(`${FAL_QUEUE_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Key ${auth.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: auth.signal,
  })
  const body = (await readBody(response)) as Record<string, unknown> | undefined
  if (!response.ok) throw providerHttpError('FAL', 'submit', response.status, body, [auth.apiKey])

  const requestId = body?.request_id
  if (typeof requestId !== 'string' || !requestId) {
    throw new ProviderError('FAL', 'FAL submit response did not include request_id.', response.status, body)
  }
  return {
    endpoint,
    requestId,
    statusUrl:
      typeof body?.status_url === 'string'
        ? body.status_url
        : `${FAL_QUEUE_BASE}/${endpoint}/requests/${requestId}/status`,
    responseUrl:
      typeof body?.response_url === 'string' ? body.response_url : `${FAL_QUEUE_BASE}/${endpoint}/requests/${requestId}`,
    cancelUrl: typeof body?.cancel_url === 'string' ? body.cancel_url : undefined,
  }
}

export interface FalPollOptions extends FalAuth {
  intervalMs?: number
  logs?: boolean
  onStatus?: (update: FalStatusUpdate) => void | Promise<void>
}

/** Poll status_url (with logs=1) until COMPLETED. Returns the final status body. */
export async function pollFal(submitted: FalSubmitted, options: FalPollOptions): Promise<Record<string, unknown>> {
  const { intervalMs = FAL_DEFAULT_POLL_MS, logs = true, onStatus } = options
  while (true) {
    const url = new URL(submitted.statusUrl)
    if (logs) url.searchParams.set('logs', '1')
    const response = await options.fetch(url, {
      headers: { Authorization: `Key ${options.apiKey}` },
      signal: options.signal,
    })
    const body = ((await readBody(response)) ?? {}) as Record<string, unknown>
    if (!response.ok) throw providerHttpError('FAL', 'status', response.status, body, [options.apiKey])

    const status = typeof body.status === 'string' ? body.status : 'UNKNOWN'
    if (onStatus) {
      await onStatus({
        endpoint: submitted.endpoint,
        requestId: submitted.requestId,
        status,
        queuePosition: typeof body.queue_position === 'number' ? body.queue_position : undefined,
        logs: Array.isArray(body.logs) ? (body.logs as FalStatusUpdate['logs']) : [],
        raw: body,
      })
    }

    if (status === 'COMPLETED') {
      if (body.error) {
        const detail = typeof body.error === 'string' ? body.error : JSON.stringify(body.error)
        throw new ProviderError('FAL', `FAL request failed: ${detail}`, response.status, body)
      }
      return body
    }
    await sleep(intervalMs, options.signal)
  }
}

export async function getFalResult<T = Record<string, unknown>>(submitted: FalSubmitted, auth: FalAuth): Promise<T> {
  const response = await auth.fetch(submitted.responseUrl, {
    headers: { Authorization: `Key ${auth.apiKey}` },
    signal: auth.signal,
  })
  const body = await readBody(response)
  if (!response.ok) throw providerHttpError('FAL', 'result', response.status, body, [auth.apiKey])
  return (body ?? {}) as T
}

export interface FalRunOptions extends FalPollOptions {
  onSubmit?: (submitted: FalSubmitted) => void | Promise<void>
}

/** submit → poll → result. Only call after the user approved the exact input. */
export async function runFal<T = Record<string, unknown>>(
  endpoint: string,
  input: unknown,
  options: FalRunOptions,
): Promise<{ submitted: FalSubmitted; status: Record<string, unknown>; data: T }> {
  const submitted = await submitFal(endpoint, input, options)
  if (options.onSubmit) await options.onSubmit(submitted)
  const status = await pollFal(submitted, options)
  const data = await getFalResult<T>(submitted, options)
  return { submitted, status, data }
}

// ---------------------------------------------------------------------------
// Output helpers (ported from fal-queue.mjs collectRemoteFiles / extensionForFile)
// ---------------------------------------------------------------------------

export interface FalFile {
  url: string
  content_type?: string | null
  file_name?: string | null
  file_size?: number | null
}

/**
 * Recursively collect every `{url: string}` object in a FAL result, labelled by
 * its key path tail, de-duplicated by URL. This is how image-blaster decides what
 * to download for nano-banana and Hunyuan results.
 */
export function collectRemoteFiles(
  value: unknown,
  label = 'file',
  collected: Array<{ label: string; file: FalFile }> = [],
  seen: Set<string> = new Set(),
): Array<{ label: string; file: FalFile }> {
  if (!value) return collected
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRemoteFiles(item, `${label}-${index + 1}`, collected, seen))
    return collected
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.url === 'string') {
      if (!seen.has(obj.url)) {
        seen.add(obj.url)
        collected.push({ label, file: obj as unknown as FalFile })
      }
      return collected
    }
    for (const [key, child] of Object.entries(obj)) collectRemoteFiles(child, key, collected, seen)
  }
  return collected
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'model/gltf-binary': '.glb',
  'model/obj': '.obj',
  'model/mtl': '.mtl',
}

export function extensionForFile(file: FalFile, fallback = '.bin'): string {
  if (file.file_name) {
    const m = /(\.[^./\\]+)$/.exec(file.file_name)
    if (m) return m[1]
  }
  return (file.content_type && MIME_EXTENSIONS[file.content_type]) || fallback
}

/** Pure: encode bytes as a data URI (image-blaster's fileToDataUri, minus the fs read). */
export function bytesToDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}
