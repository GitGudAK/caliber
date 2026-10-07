// Shared HTTP helpers for provider clients.
// Every network call in server/providers goes through an injected FetchLike so
// tests never touch the network and nothing spends money without approval.

export type FetchLike = typeof fetch

const MAX_ERROR_BODY_CHARS = 600

export class ProviderError extends Error {
  readonly provider: string
  readonly status: number | undefined
  readonly body: unknown

  constructor(provider: string, message: string, status?: number, body?: unknown) {
    super(message)
    this.name = 'ProviderError'
    this.provider = provider
    this.status = status
    this.body = body
  }
}

/** Remove secrets from any text before it is surfaced (logs, UI, thrown errors). */
export function scrubSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]')
  }
  // Belt and braces: auth header shapes that might be echoed back by a provider.
  out = out.replace(/(Key|Bearer)\s+[A-Za-z0-9._:\-]{12,}/g, '$1 [redacted]')
  return out
}

export function truncate(text: string, max = MAX_ERROR_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text
}

/**
 * Pull a human readable message out of a provider error body.
 * FAL: `{detail: "..."}` or `{detail: [{loc, msg, type}]}` (422 validation).
 * World Labs / generic: `{error}`, `{message}`, `{error: {message}}`.
 */
export function extractErrorMessage(body: unknown): string {
  if (body === undefined || body === null || body === '') return ''
  if (typeof body === 'string') return body
  if (typeof body !== 'object') return String(body)
  const b = body as Record<string, unknown>

  const detail = b.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (d && typeof d === 'object') {
          const item = d as Record<string, unknown>
          const loc = Array.isArray(item.loc) ? item.loc.join('.') : undefined
          const msg = typeof item.msg === 'string' ? item.msg : JSON.stringify(item)
          return loc ? `${loc}: ${msg}` : msg
        }
        return String(d)
      })
      .join('; ')
  }

  const err = b.error
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const m = (err as Record<string, unknown>).message
    if (typeof m === 'string') return m
    return JSON.stringify(err)
  }
  if (typeof b.message === 'string') return b.message

  return JSON.stringify(body)
}

/** Read a response body as JSON when possible, else as text. Never throws. */
export async function readBody(response: Response): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return undefined
  }
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Build the error thrown for a non-2xx provider response. Unlike image-blaster,
 * which throws only `FAL submit failed (422).`, the provider's own message is
 * included (truncated, with secrets scrubbed).
 */
export function providerHttpError(
  provider: string,
  action: string,
  status: number,
  body: unknown,
  secrets: Array<string | undefined> = [],
): ProviderError {
  const raw = extractErrorMessage(body)
  const detail = raw ? `: ${truncate(scrubSecrets(raw, secrets))}` : ''
  return new ProviderError(provider, `${provider} ${action} failed (${status})${detail}`, status, body)
}

/** Abortable sleep. Rejects with the signal's reason when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const err = new Error(typeof reason === 'string' ? reason : 'The operation was aborted.')
  err.name = 'AbortError'
  return err
}

/** Download a provider-hosted file (FAL / World Labs CDN URLs are unauthenticated). */
export async function fetchBytes(
  url: string,
  options: { fetch: FetchLike; signal?: AbortSignal; provider?: string },
): Promise<Uint8Array> {
  const response = await options.fetch(url, { signal: options.signal })
  if (!response.ok) {
    const body = await readBody(response)
    throw providerHttpError(options.provider ?? 'Download', `download of ${url}`, response.status, body)
  }
  return new Uint8Array(await response.arrayBuffer())
}

// ---------------------------------------------------------------------------
// Display redaction
// ---------------------------------------------------------------------------

const DATA_URI_RE = /^data:([^;,]*)(;base64)?,(.*)$/s

function base64ByteLength(b64: string): number {
  const clean = b64.replace(/\s+/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

function isBase64Key(key: string): boolean {
  return /base64|b64/i.test(key)
}

/**
 * Replace base64 payloads with `[base64 N bytes]` so a request body can be shown
 * to the user for approval. Mirrors image-blaster's stripBase64 rules (data URIs,
 * and any string under a key containing "base64"/"b64") but keeps the size.
 */
export function redactForDisplay<T>(body: T, key = ''): T {
  if (typeof body === 'string') {
    const m = DATA_URI_RE.exec(body)
    if (m) {
      const bytes = m[2] ? base64ByteLength(m[3]) : decodeURIComponent(m[3]).length
      const mime = m[1] ? `${m[1]} ` : ''
      return `[${m[2] ? 'base64' : 'data'} ${mime}${bytes} bytes]` as T
    }
    if (isBase64Key(key)) return `[base64 ${base64ByteLength(body)} bytes]` as T
    return body
  }
  if (Array.isArray(body)) return body.map((item) => redactForDisplay(item, key)) as T
  if (body && typeof body === 'object') {
    return Object.fromEntries(
      Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, redactForDisplay(v, k)]),
    ) as T
  }
  return body
}
