import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import type { Project, ProjectScene } from '../../shared/types.ts'
import type { Services } from '../app.ts'
import { mimeFor } from '../storage/mime.ts'
import { parseName, readJsonObject } from './body.ts'
import { badRequest, notFound } from './errors.ts'
import { parseScene } from './placement.ts'

const GLB_MAGIC = 'glTF'

export function projectRoutes(services: Services) {
  const { repo, storage } = services

  const requireProject = (id: string): Project => {
    const project = repo.projects.get(id)
    if (!project) throw notFound(`Project ${id} not found`)
    return project
  }

  // presetId must exist; a preset with no placement starts from the preset's default.
  // Shot: omitted (undefined) keeps the stored shot, null clears it. Changing presetId
  // deliberately does NOT clear the shot, so the user can reuse a framing/move across worlds.
  // Audio: same rule as shot (omitted keeps, null clears); a new track must point at a
  // library audio asset (kind 'audio', no project).
  const resolveScene = (scene: ProjectScene, current: ProjectScene): ProjectScene => {
    const shot = scene.shot === undefined ? (current.shot ?? null) : scene.shot
    const audio = scene.audio === undefined ? (current.audio ?? null) : scene.audio
    const look = scene.look === undefined ? (current.look ?? null) : scene.look
    if (scene.audio) {
      const asset = repo.assets.get(scene.audio.assetId)
      if (!asset || asset.kind !== 'audio' || asset.projectId !== null) {
        throw notFound(`Library audio asset ${scene.audio.assetId} not found`)
      }
    }
    if (scene.presetId === null) return { presetId: null, placement: scene.placement, shot, audio, look }
    const preset = repo.presets.get(scene.presetId)
    if (!preset) throw notFound(`Preset ${scene.presetId} not found`)
    return { presetId: preset.id, placement: scene.placement ?? preset.defaultPlacement, shot, audio, look }
  }

  // Remove every existing watch model (row + file) so a new one can take its key.
  const clearWatchAssets = async (projectId: string) => {
    for (const asset of repo.assets.listByProject(projectId, 'watch-model')) {
      await storage.delete(asset.key)
      repo.assets.delete(asset.id)
    }
  }

  const attachWatch = async (
    projectId: string,
    filename: string,
    write: (key: string) => Promise<{ bytes: number }>,
    meta: Record<string, unknown>,
  ): Promise<Project> => {
    const key = `projects/${projectId}/watch/${filename}`
    await clearWatchAssets(projectId)
    const { bytes } = await write(key)
    const asset = repo.assets.create({
      projectId,
      kind: 'watch-model',
      key,
      filename,
      mime: mimeFor(filename),
      bytes,
      meta,
    })
    return repo.projects.update(projectId, { watchAssetId: asset.id })
  }

  return new Hono()
    .get('/', (c) => c.json(repo.projects.list()))
    .post('/', async (c) => {
      const body = await readJsonObject(c.req.raw)
      return c.json(repo.projects.create({ name: parseName(body.name) }), 201)
    })
    .get('/:id', (c) => c.json(requireProject(c.req.param('id'))))
    .patch('/:id', async (c) => {
      const id = c.req.param('id')
      const current = requireProject(id)
      const body = await readJsonObject(c.req.raw)
      const patch: { name?: string; scene?: ProjectScene } = {}
      if (body.name !== undefined) patch.name = parseName(body.name)
      if (body.scene !== undefined) patch.scene = resolveScene(parseScene(body.scene), current.scene)
      return c.json(repo.projects.update(id, patch))
    })
    .delete('/:id', async (c) => {
      const id = c.req.param('id')
      requireProject(id)
      // Rows cascade in SQLite; files must be removed explicitly. Exported MP4s are the
      // user's finished deliverables, so they deliberately stay in data/exports/.
      for (const asset of repo.assets.listByProject(id)) {
        if (asset.kind === 'export') continue
        await storage.delete(asset.key)
      }
      repo.projects.delete(id)
      return c.json({ ok: true as const })
    })
    .post('/:id/watch', async (c) => {
      const id = c.req.param('id')
      requireProject(id)
      let form: FormData
      try {
        form = await c.req.raw.formData()
      } catch {
        throw badRequest('Expected multipart/form-data with a "file" field')
      }
      const file = form.get('file')
      if (!(file instanceof File)) throw badRequest('Missing "file" field in multipart form data')
      const filename = sanitizeFilename(file.name)
      if (path.extname(filename).toLowerCase() !== '.glb') {
        throw badRequest(`Only .glb files are accepted (got "${file.name || 'unnamed file'}")`)
      }
      const data = new Uint8Array(await file.arrayBuffer())
      if (!hasGlbMagic(data)) {
        throw badRequest(`"${file.name}" is not a valid binary glTF (.glb) file: missing "glTF" header`)
      }
      const project = await attachWatch(id, filename, (key) => storage.save(key, data), { originalName: file.name })
      return c.json(project)
    })
    .post('/:id/watch/sample', async (c) => {
      const id = c.req.param('id')
      requireProject(id)
      const samplePath = path.join(services.env.samplesDir, 'casio_watch.glb')
      if (!existsSync(samplePath)) throw notFound(`Sample watch not found at ${samplePath}`)
      const header = new Uint8Array(4)
      const handle = await open(samplePath, 'r')
      try {
        await handle.read(header, 0, 4, 0)
      } finally {
        await handle.close()
      }
      if (!hasGlbMagic(header)) throw new Error(`Sample file ${samplePath} is not a valid .glb (missing "glTF" header)`)
      const project = await attachWatch(id, 'casio_watch.glb', (key) => storage.saveFromFile(key, samplePath), {
        sample: true,
      })
      return c.json(project)
    })
    .get('/:id/jobs', (c) => {
      const id = c.req.param('id')
      requireProject(id)
      return c.json(repo.jobs.listByProject(id))
    })
}

function hasGlbMagic(data: Uint8Array): boolean {
  return data.byteLength >= 4 && new TextDecoder().decode(data.subarray(0, 4)) === GLB_MAGIC
}

/** Keep only a safe basename: letters, digits, dot, dash, underscore. */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'))
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-120)
  return cleaned || 'unnamed'
}
