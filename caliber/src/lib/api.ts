import { API } from '../../shared/api'
import type {
  Asset,
  Health,
  Job,
  Placement,
  Project,
  ProjectScene,
  ProviderRequestRecord,
  SfxPreview,
  SfxRequestInput,
  WorldPreset,
} from '../../shared/types'

// Typed client for every route in shared/api.ts. The browser only talks to
// Vite's origin; /api is proxied to the local server.

export class ApiError extends Error {
  status: number
  url: string
  constructor(message: string, status: number, url: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.url = url
  }
}

export class ServerUnreachableError extends Error {
  url: string
  constructor(url: string, cause?: unknown) {
    const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : ''
    super(`Local server unreachable at ${url}${detail}. Is \`npm run dev\` running?`)
    this.name = 'ServerUnreachableError'
    this.url = url
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function absolute(path: string) {
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = absolute(path)
  let res: Response
  try {
    res = await fetch(path, init)
  } catch (cause) {
    throw new ServerUnreachableError(url, cause)
  }

  const text = await res.text()
  let body: unknown = undefined
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
  }

  if (!res.ok) {
    const serverMessage =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : null
    if (serverMessage) throw new ApiError(serverMessage, res.status, url)
    // The Vite proxy answers with an empty 5xx when the local server is down.
    if (!text && res.status >= 500) {
      throw new ApiError(
        `Local server unreachable behind the Vite proxy: ${init?.method ?? 'GET'} ${url} returned HTTP ${res.status} with an empty body.`,
        res.status,
        url,
      )
    }
    const snippet = text ? `: ${text.slice(0, 200)}` : ''
    throw new ApiError(`HTTP ${res.status} ${res.statusText} from ${url}${snippet}`, res.status, url)
  }

  if (body === undefined) {
    throw new ApiError(`Expected JSON from ${url} but got ${text ? 'non-JSON text' : 'an empty body'}`, res.status, url)
  }
  return body as T
}

function json(method: string, data: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }
}

export const api = {
  health: () => request<Health>(API.health),
  listProjects: () => request<Project[]>(API.projects),
  createProject: (name: string) => request<Project>(API.projects, json('POST', { name })),
  getProject: (id: string) => request<Project>(API.project(id)),
  updateProject: (id: string, patch: { name?: string; scene?: ProjectScene }) =>
    request<Project>(API.project(id), json('PATCH', patch)),
  deleteProject: (id: string) => request<{ ok: true }>(API.project(id), { method: 'DELETE' }),
  uploadWatch: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<Project>(API.projectWatch(id), { method: 'POST', body: form })
  },
  useSampleWatch: (id: string) => request<Project>(API.projectWatchSample(id), { method: 'POST' }),
  listProjectJobs: (id: string) => request<Job[]>(API.projectJobs(id)),
  getJob: (id: string) => request<Job>(API.job(id)),
  startSelftest: (projectId?: string) => request<Job>(API.selftest, json('POST', projectId ? { projectId } : {})),
  listPresets: () => request<WorldPreset[]>(API.presets),
  getPreset: (id: string) => request<WorldPreset>(API.preset(id)),
  updatePreset: (id: string, patch: { name?: string; defaultPlacement?: Placement }) =>
    request<WorldPreset>(API.preset(id), json('PATCH', patch)),
  getProviderRequest: (hash: string) => request<ProviderRequestRecord>(API.providerRequest(hash)),
  /** Saves an exported MP4 under data/exports/<projectId>/. Pass `signal` to abort the upload. */
  uploadExport: (
    projectId: string,
    blob: Blob,
    meta: { label: string; durationSeconds?: number; preset?: string },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ label: meta.label })
    if (meta.durationSeconds !== undefined) query.set('durationSeconds', String(meta.durationSeconds))
    if (meta.preset !== undefined) query.set('preset', meta.preset)
    return request<Asset>(`${API.projectExports(projectId)}?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: blob,
      signal,
    })
  },
  listExports: (projectId: string) => request<Asset[]>(API.projectExports(projectId)),
  /** Library audio (kind 'audio'), newest first. */
  listAudio: () => request<Asset[]>(API.audio),
  /** Builds and fingerprints the exact SFX request. Free: no provider call. */
  previewSfx: (input: SfxRequestInput) => request<SfxPreview>(API.audioPreview, json('POST', input)),
  /**
   * PAID unless the ledger already has it. Only call with the hash the user approved from
   * previewSfx(input) for this exact input; the server answers 409 if it differs.
   */
  generateSfx: (input: SfxRequestInput, approvedHash: string) =>
    request<SfxGenerateResult>(API.audio, json('POST', { ...input, approvedHash })),
}

export type SfxGenerateResult = { cached: true; assets: Asset[] } | Job

export function isCachedSfx(result: SfxGenerateResult): result is { cached: true; assets: Asset[] } {
  return (result as { cached?: unknown }).cached === true
}
