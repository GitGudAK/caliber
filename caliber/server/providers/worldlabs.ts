// World Labs Marble client. Ported from image-blaster .claude/scripts/world/generate-world.mjs
// (buildRequest / imagePrompt / submitWorld / operationId / pollOperation / downloadWorldAssets).
//
// Deviations from image-blaster:
// - Request building is pure and takes already-read image bytes (base64) or a URI;
//   no fs reads, no fallback to worlds/<world>/image.json.
// - API key and fetch are injected. Errors include the provider's body message.
// - pollOperation throws on `error` itself (image-blaster checks after polling), and
//   stringifies non-string errors instead of dropping them.
// - Polls immediately at the same cadence as image-blaster (sleep before each GET).

import { type FetchLike, ProviderError, providerHttpError, readBody, sleep } from './http.ts'

export const WORLDLABS_BASE = 'https://api.worldlabs.ai/marble/v1'
export const WORLDLABS_MODEL = 'marble-1.1'
export const WORLDLABS_DEFAULT_POLL_MS = 15000

export type WorldImageInput =
  | { base64: string; extension: string; mimeType: string }
  | { uri: string }

export interface WorldRequest {
  display_name: string
  model: string
  world_prompt:
    | { type: 'text'; text_prompt: string }
    | {
        type: 'image'
        image_prompt:
          | { source: 'uri'; uri: string }
          | { source: 'data_base64'; data_base64: string; extension: string; mime_type: string }
        text_prompt?: string
      }
}

/** Pure: exact body for POST /worlds:generate. */
export function buildWorldRequest(options: {
  displayName: string
  textPrompt?: string
  image?: WorldImageInput
}): WorldRequest {
  const { displayName, textPrompt, image } = options
  if (!displayName) throw new Error('displayName is required.')

  if (image) {
    const imagePrompt =
      'uri' in image
        ? { source: 'uri' as const, uri: image.uri }
        : {
            source: 'data_base64' as const,
            data_base64: image.base64,
            // image-blaster: path.extname(image).replace(/^\./, "") || "png"
            extension: image.extension.replace(/^\./, '') || 'png',
            mime_type: image.mimeType,
          }
    if ('uri' in image && !image.uri) throw new Error('image.uri is empty.')
    if (!('uri' in image) && !image.base64) throw new Error('image.base64 is empty.')
    return {
      display_name: displayName,
      model: WORLDLABS_MODEL,
      world_prompt: {
        type: 'image',
        image_prompt: imagePrompt,
        ...(textPrompt ? { text_prompt: textPrompt } : {}),
      },
    }
  }

  if (!textPrompt) throw new Error('World generation requires a source image or a text prompt.')
  return {
    display_name: displayName,
    model: WORLDLABS_MODEL,
    world_prompt: { type: 'text', text_prompt: textPrompt },
  }
}

/** Pure: the exact HTTP request a submit will make (minus the key), for approval UI. */
export function buildWorldSubmitRequest(request: WorldRequest) {
  return {
    method: 'POST' as const,
    url: `${WORLDLABS_BASE}/worlds:generate`,
    headers: { 'Content-Type': 'application/json', 'WLT-Api-Key': '<WORLDLABS_API_KEY>' },
    body: request,
  }
}

export interface WorldAuth {
  apiKey: string
  fetch: FetchLike
  signal?: AbortSignal
}

export interface WorldOperation {
  operation_id?: string
  id?: string
  name?: string
  done?: boolean
  error?: unknown
  response?: WorldResponse
  metadata?: unknown
  [key: string]: unknown
}

export async function submitWorld(request: WorldRequest, auth: WorldAuth): Promise<WorldOperation> {
  const response = await auth.fetch(`${WORLDLABS_BASE}/worlds:generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'WLT-Api-Key': auth.apiKey },
    body: JSON.stringify(request),
    signal: auth.signal,
  })
  const body = await readBody(response)
  if (!response.ok) throw providerHttpError('World Labs', 'submit', response.status, body, [auth.apiKey])
  return (body ?? {}) as WorldOperation
}

export function operationId(operation: WorldOperation): string {
  const id = operation?.operation_id || operation?.id || operation?.name
  if (!id) throw new Error('World Labs operation did not include operation_id.')
  return String(id).split('/').at(-1)!
}

export function operationStatus(operation: WorldOperation): 'failed' | 'completed' | 'running' {
  if (operation?.error) return 'failed'
  return operation?.done ? 'completed' : 'running'
}

export interface WorldPollOptions extends WorldAuth {
  intervalMs?: number
  onStatus?: (update: { operationId: string; status: string; operation: WorldOperation }) => void | Promise<void>
}

/** Poll GET /operations/{id} until done. Throws on operation error or missing response. */
export async function pollOperation(operation: WorldOperation, options: WorldPollOptions): Promise<WorldOperation> {
  const { intervalMs = WORLDLABS_DEFAULT_POLL_MS, onStatus } = options
  let current = operation
  const id = operationId(current)

  while (!current.done) {
    await sleep(intervalMs, options.signal)
    const response = await options.fetch(`${WORLDLABS_BASE}/operations/${id}`, {
      headers: { 'WLT-Api-Key': options.apiKey },
      signal: options.signal,
    })
    const body = await readBody(response)
    if (!response.ok) throw providerHttpError('World Labs', 'poll', response.status, body, [options.apiKey])
    current = (body ?? {}) as WorldOperation
    if (onStatus) await onStatus({ operationId: id, status: operationStatus(current), operation: current })
  }

  if (current.error) {
    const detail = typeof current.error === 'string' ? current.error : JSON.stringify(current.error)
    throw new ProviderError('World Labs', `World Labs generation failed: ${detail}`, undefined, current)
  }
  if (!current.response) throw new ProviderError('World Labs', 'World Labs operation completed without response.')
  return current
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export interface SemanticsMetadata {
  ground_plane_offset?: number
  flip_y?: boolean
  metric_scale_factor?: number
  [key: string]: unknown
}

export interface WorldResponse {
  assets?: {
    splats?: { spz_urls?: Record<string, string | null | undefined>; semantics_metadata?: SemanticsMetadata }
    mesh?: { collider_mesh_url?: string | null }
    imagery?: { pano_url?: string | null }
    thumbnail_url?: string | null
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface WorldAssetUrls {
  /** Every spz_urls entry with a URL, keyed as returned (e.g. "100k", "500k", "full_res"). */
  spz: Record<string, string>
  colliderMeshUrl?: string
  panoUrl?: string
  thumbnailUrl?: string
  semanticsMetadata?: SemanticsMetadata
}

/** Extract the downloadable asset URLs exactly as image-blaster's downloadWorldAssets reads them. */
export function worldAssetUrls(response: WorldResponse): WorldAssetUrls {
  const assets = response?.assets ?? {}
  const spz: Record<string, string> = {}
  for (const [key, url] of Object.entries(assets.splats?.spz_urls ?? {})) {
    if (url) spz[key] = url
  }
  return {
    spz,
    ...(assets.mesh?.collider_mesh_url ? { colliderMeshUrl: assets.mesh.collider_mesh_url } : {}),
    ...(assets.imagery?.pano_url ? { panoUrl: assets.imagery.pano_url } : {}),
    ...(assets.thumbnail_url ? { thumbnailUrl: assets.thumbnail_url } : {}),
    ...(assets.splats?.semantics_metadata ? { semanticsMetadata: assets.splats.semantics_metadata } : {}),
  }
}

/** image-blaster's filename-safe spz key: replace(/[^a-z0-9_-]/gi, "_"). */
export function assetKeyForFilename(key: string): string {
  return String(key).replace(/[^a-z0-9_-]/gi, '_')
}

/** image-blaster's extensionFromUrl: URL pathname extension or fallback (.png pano, .webp thumbnail). */
export function extensionFromUrl(url: string, fallback: string): string {
  try {
    const m = /(\.[^./]+)$/.exec(new URL(url).pathname)
    return m ? m[1] : fallback
  } catch {
    return fallback
  }
}
