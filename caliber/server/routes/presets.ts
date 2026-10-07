import { Hono } from 'hono'
import type { Placement, WorldPreset } from '../../shared/types.ts'
import type { Services } from '../app.ts'
import { parseName, readJsonObject } from './body.ts'
import { badRequest, notFound } from './errors.ts'
import { parsePlacement } from './placement.ts'

// No DELETE: presets are paid outputs; removing one is a manual, deliberate act.
export function presetRoutes(services: Services) {
  const { repo } = services

  const requirePreset = (id: string): WorldPreset => {
    const preset = repo.presets.get(id)
    if (!preset) throw notFound(`Preset ${id} not found`)
    return preset
  }

  return new Hono()
    .get('/', (c) => c.json(repo.presets.list()))
    .get('/:id', (c) => c.json(requirePreset(c.req.param('id'))))
    .patch('/:id', async (c) => {
      const id = c.req.param('id')
      requirePreset(id)
      const body = await readJsonObject(c.req.raw)
      for (const key of Object.keys(body)) {
        if (key !== 'name' && key !== 'defaultPlacement') throw badRequest(`Unknown field "${key}" (expected name, defaultPlacement)`)
      }
      const patch: { name?: string; defaultPlacement?: Placement } = {}
      if (body.name !== undefined) patch.name = parseName(body.name)
      if (body.defaultPlacement !== undefined) patch.defaultPlacement = parsePlacement(body.defaultPlacement, 'defaultPlacement')
      return c.json(repo.presets.update(id, patch))
    })
}
