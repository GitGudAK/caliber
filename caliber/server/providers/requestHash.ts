import { createHash } from 'node:crypto'

/**
 * Stable fingerprint of a paid request: provider + endpoint + body with object keys
 * sorted. Base64 image bytes are included, so the same prompt with a different image
 * is a different request. Used to refuse re-sending a request whose outputs exist.
 */
export function requestHash(provider: string, endpoint: string, body: unknown): string {
  return createHash('sha256').update(`${provider}\n${endpoint}\n${canonicalJson(body)}`).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
