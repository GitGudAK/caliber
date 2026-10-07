import path from 'node:path'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { openDatabase } from './db/sqlite.ts'
import { createSqliteRepository, type Repository } from './db/repository.ts'
import type { Asset } from '../shared/types.ts'
import { env } from './env.ts'
import { createInProcessJobRunner, errorMessage, type JobRunner } from './jobs/runner.ts'
import { registerSelftest } from './jobs/selftest.ts'
import { createFalSfxNetwork, registerSfx, type SfxNetwork } from './jobs/sfx.ts'
import { audioRoutes } from './routes/audio.ts'
import { assetRoutes } from './routes/assets.ts'
import { EXPORT_KEY_PREFIX, exportApiRoutes, exportFileRoutes } from './routes/exports.ts'
import { HttpError } from './routes/errors.ts'
import { healthRoutes } from './routes/health.ts'
import { jobRoutes } from './routes/jobs.ts'
import { presetRoutes } from './routes/presets.ts'
import { projectRoutes } from './routes/projects.ts'
import { providerRequestRoutes } from './routes/providerRequests.ts'
import { createLocalStorage, type AssetStorage } from './storage/storage.ts'

export interface Services {
  env: Pick<typeof env, 'samplesDir' | 'worldlabsKey' | 'falKey'>
  repo: Repository
  storage: AssetStorage
  /** data/exports, served at /exports. Export asset keys are stored with an "exports/" prefix. */
  exportStorage: AssetStorage
  runner: JobRunner
  /** Library (project-less) assets. TODO(lead): move into Repository as assets.listLibrary(kind). */
  library: { listAudio(): Asset[] }
}

export interface ServiceOptions {
  /** Network layer for the paid 'sfx' job. Tests pass a fake; default is real FAL. */
  sfxNetwork?: SfxNetwork
}

/** All infrastructure wiring in one place, so tests can build alternatives. */
export function createServices(dataDir: string = env.dataDir, options: ServiceOptions = {}): Services {
  const storage = createLocalStorage(path.join(dataDir, 'assets'), '/assets')
  const exportStorage = createLocalStorage(path.join(dataDir, 'exports'), '/exports')
  const db = openDatabase(path.join(dataDir, 'caliber.db'))
  const repo = createSqliteRepository(db, (key) =>
    key.startsWith(EXPORT_KEY_PREFIX) ? exportStorage.url(key.slice(EXPORT_KEY_PREFIX.length)) : storage.url(key),
  )
  const runner = createInProcessJobRunner(repo)
  registerSelftest(runner)
  registerSfx(runner, { repo, storage, network: options.sfxNetwork ?? createFalSfxNetwork() })
  const library = {
    listAudio: () =>
      (db.prepare("SELECT id FROM assets WHERE project_id IS NULL AND kind = 'audio' ORDER BY created_at DESC, id").all() as { id: string }[])
        .map((row) => repo.assets.get(row.id))
        .filter((asset): asset is Asset => !!asset),
  }
  return { env, repo, storage, exportStorage, runner, library }
}

export function createApp(services: Services) {
  const app = new Hono()

  app.route('/api/health', healthRoutes(services))
  app.route('/api/projects', exportApiRoutes(services))
  app.route('/api/projects', projectRoutes(services))
  app.route('/api/jobs', jobRoutes(services))
  app.route('/api/presets', presetRoutes(services))
  app.route('/api/provider-requests', providerRequestRoutes(services))
  app.route('/api/audio', audioRoutes(services))
  app.route('/assets', assetRoutes(services))
  app.route('/exports', exportFileRoutes(services))

  app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${c.req.path}` }, 404))

  app.onError((error, c) => {
    const status: ContentfulStatusCode = error instanceof HttpError ? error.status : 500
    if (status >= 500) console.error(`[${c.req.method} ${c.req.path}]`, error)
    return c.json({ error: errorMessage(error) }, status)
  })

  return app
}
