import type { DatabaseSync } from 'node:sqlite'
import type {
  Asset,
  AssetKind,
  Job,
  JobStatus,
  JobStep,
  Placement,
  Project,
  ProjectScene,
  ProviderRequestRecord,
  WorldPreset,
} from '../../shared/types.ts'
import { newId, now } from '../ids.ts'

// The app only depends on this interface; SQLite is one implementation.
export interface Repository {
  projects: {
    list(): Project[]
    get(id: string): Project | undefined
    create(input: { name: string }): Project
    update(id: string, patch: { name?: string; watchAssetId?: string | null; scene?: ProjectScene }): Project
    delete(id: string): void
  }
  assets: {
    get(id: string): Asset | undefined
    listByProject(projectId: string, kind?: AssetKind): Asset[]
    create(input: Omit<Asset, 'id' | 'url' | 'createdAt'>): Asset
    delete(id: string): void
  }
  presets: {
    list(): WorldPreset[]
    get(id: string): WorldPreset | undefined
    create(input: {
      /** Optional caller-chosen id (so storage keys can use it before the row exists). */
      id?: string
      name: string
      templateId: string | null
      /** Asset ids; spz keyed by World Labs resolution key. */
      files: { sceneImage?: string; spz: Record<string, string>; collider?: string; pano?: string; thumbnail?: string; worldJson?: string }
      semantics: Record<string, unknown>
      defaultPlacement: Placement
      prompts: WorldPreset['prompts']
      provenance: Record<string, unknown>
    }): WorldPreset
    update(id: string, patch: { name?: string; defaultPlacement?: Placement }): WorldPreset
  }
  providerRequests: {
    get(hash: string): ProviderRequestRecord | undefined
    /** Insert or replace the record for this hash. */
    put(record: Omit<ProviderRequestRecord, 'createdAt' | 'updatedAt'>): ProviderRequestRecord
  }
  jobs: {
    get(id: string): Job | undefined
    listByProject(projectId: string): Job[]
    listByStatus(statuses: JobStatus[]): Job[]
    create(input: { kind: string; projectId: string | null; steps: JobStep[]; input: unknown }): Job
    update(id: string, patch: Partial<Pick<Job, 'status' | 'progress' | 'steps' | 'result' | 'error'>>): Job
  }
}

type Row = Record<string, unknown>
const json = (value: unknown) => JSON.stringify(value ?? null)
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T

export function createSqliteRepository(db: DatabaseSync, assetUrl: (key: string) => string): Repository {
  const toAsset = (row: Row): Asset => ({
    id: String(row.id),
    projectId: (row.project_id as string | null) ?? null,
    kind: row.kind as AssetKind,
    key: String(row.key),
    url: assetUrl(String(row.key)),
    filename: String(row.filename),
    mime: String(row.mime),
    bytes: Number(row.bytes),
    meta: parse(row.meta),
    createdAt: String(row.created_at),
  })

  const getAsset = (id: string) => {
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row | undefined
    return row ? toAsset(row) : undefined
  }

  const toProject = (row: Row): Project => {
    const watchAssetId = (row.watch_asset_id as string | null) ?? null
    return {
      id: String(row.id),
      name: String(row.name),
      watchAssetId,
      watchAsset: watchAssetId ? getAsset(watchAssetId) ?? null : null,
      scene: parse<ProjectScene>(row.scene),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  const toJob = (row: Row): Job => ({
    id: String(row.id),
    kind: String(row.kind),
    projectId: (row.project_id as string | null) ?? null,
    status: row.status as JobStatus,
    progress: Number(row.progress),
    steps: parse(row.steps),
    input: parse(row.input),
    result: parse(row.result),
    error: (row.error as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  })

  const getProject = (id: string) => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return row ? toProject(row) : undefined
  }

  type PresetFileIds = { sceneImage?: string; spz: Record<string, string>; collider?: string; pano?: string; thumbnail?: string; worldJson?: string }
  const assetOrNull = (id?: string) => (id ? getAsset(id) ?? null : null)
  const toPreset = (row: Row): WorldPreset => {
    const ids = parse<PresetFileIds>(row.files)
    const spz: Record<string, Asset> = {}
    for (const [key, assetId] of Object.entries(ids.spz ?? {})) {
      const asset = getAsset(assetId)
      if (asset) spz[key] = asset
    }
    return {
      id: String(row.id),
      name: String(row.name),
      templateId: (row.template_id as string | null) ?? null,
      files: {
        sceneImage: assetOrNull(ids.sceneImage),
        spz,
        collider: assetOrNull(ids.collider),
        pano: assetOrNull(ids.pano),
        thumbnail: assetOrNull(ids.thumbnail),
        worldJson: assetOrNull(ids.worldJson),
      },
      semantics: parse(row.semantics),
      defaultPlacement: parse(row.default_placement),
      prompts: parse(row.prompts),
      provenance: parse(row.provenance),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
  const getPreset = (id: string) => {
    const row = db.prepare('SELECT * FROM world_presets WHERE id = ?').get(id) as Row | undefined
    return row ? toPreset(row) : undefined
  }
  const toProviderRequest = (row: Row): ProviderRequestRecord => ({
    hash: String(row.hash),
    provider: row.provider as ProviderRequestRecord['provider'],
    endpoint: String(row.endpoint),
    request: parse(row.request),
    status: row.status as ProviderRequestRecord['status'],
    providerRef: (row.provider_ref as string | null) ?? null,
    response: parse(row.response),
    outputs: parse(row.outputs),
    error: (row.error as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  })
  const getProviderRequest = (hash: string) => {
    const row = db.prepare('SELECT * FROM provider_requests WHERE hash = ?').get(hash) as Row | undefined
    return row ? toProviderRequest(row) : undefined
  }

  const getJob = (id: string) => {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined
    return row ? toJob(row) : undefined
  }

  return {
    projects: {
      list: () => (db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Row[]).map(toProject),
      get: getProject,
      create({ name }) {
        const id = newId()
        const ts = now()
        db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, ts, ts)
        return getProject(id)!
      },
      update(id, patch) {
        const current = getProject(id)
        if (!current) throw new Error(`Project ${id} not found`)
        db.prepare('UPDATE projects SET name = ?, watch_asset_id = ?, scene = ?, updated_at = ? WHERE id = ?').run(
          patch.name ?? current.name,
          patch.watchAssetId === undefined ? current.watchAssetId : patch.watchAssetId,
          json(patch.scene ?? current.scene),
          now(),
          id,
        )
        return getProject(id)!
      },
      delete(id) {
        db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      },
    },
    assets: {
      get: getAsset,
      listByProject(projectId, kind) {
        const rows = kind
          ? db.prepare('SELECT * FROM assets WHERE project_id = ? AND kind = ? ORDER BY created_at DESC').all(projectId, kind)
          : db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
        return (rows as Row[]).map(toAsset)
      },
      create(input) {
        const id = newId()
        db.prepare(
          'INSERT INTO assets (id, project_id, kind, key, filename, mime, bytes, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, input.projectId, input.kind, input.key, input.filename, input.mime, input.bytes, json(input.meta), now())
        return getAsset(id)!
      },
      delete(id) {
        db.prepare('DELETE FROM assets WHERE id = ?').run(id)
      },
    },
    presets: {
      list: () => (db.prepare('SELECT * FROM world_presets ORDER BY created_at DESC').all() as Row[]).map(toPreset),
      get: getPreset,
      create(input) {
        const id = input.id ?? newId()
        const ts = now()
        db.prepare(
          'INSERT INTO world_presets (id, name, template_id, files, semantics, default_placement, prompts, provenance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, input.name, input.templateId, json(input.files), json(input.semantics), json(input.defaultPlacement), json(input.prompts), json(input.provenance), ts, ts)
        return getPreset(id)!
      },
      update(id, patch) {
        const current = getPreset(id)
        if (!current) throw new Error(`Preset ${id} not found`)
        db.prepare('UPDATE world_presets SET name = ?, default_placement = ?, updated_at = ? WHERE id = ?').run(
          patch.name ?? current.name,
          json(patch.defaultPlacement ?? current.defaultPlacement),
          now(),
          id,
        )
        return getPreset(id)!
      },
    },
    providerRequests: {
      get: getProviderRequest,
      put(record) {
        const existing = getProviderRequest(record.hash)
        const ts = now()
        db.prepare(
          `INSERT INTO provider_requests (hash, provider, endpoint, request, status, provider_ref, response, outputs, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hash) DO UPDATE SET status = excluded.status, provider_ref = excluded.provider_ref,
             response = excluded.response, outputs = excluded.outputs, error = excluded.error, updated_at = excluded.updated_at`,
        ).run(
          record.hash, record.provider, record.endpoint, json(record.request), record.status, record.providerRef,
          json(record.response), json(record.outputs), record.error, existing?.createdAt ?? ts, ts,
        )
        return getProviderRequest(record.hash)!
      },
    },
    jobs: {
      get: getJob,
      listByProject: (projectId) =>
        (db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Row[]).map(toJob),
      listByStatus(statuses) {
        const placeholders = statuses.map(() => '?').join(', ')
        return (db.prepare(`SELECT * FROM jobs WHERE status IN (${placeholders})`).all(...statuses) as Row[]).map(toJob)
      },
      create({ kind, projectId, steps, input }) {
        const id = newId()
        const ts = now()
        db.prepare(
          'INSERT INTO jobs (id, kind, project_id, status, progress, steps, input, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
        ).run(id, kind, projectId, 'queued', json(steps), json(input), ts, ts)
        return getJob(id)!
      },
      update(id, patch) {
        const current = getJob(id)
        if (!current) throw new Error(`Job ${id} not found`)
        const next = { ...current, ...patch }
        db.prepare(
          'UPDATE jobs SET status = ?, progress = ?, steps = ?, result = ?, error = ?, updated_at = ? WHERE id = ?',
        ).run(next.status, next.progress, json(next.steps), json(next.result), next.error, now(), id)
        return getJob(id)!
      },
    },
  }
}
