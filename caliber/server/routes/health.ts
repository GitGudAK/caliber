import { existsSync } from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import type { Health } from '../../shared/types.ts'
import type { Services } from '../app.ts'

export function healthRoutes(services: Services) {
  return new Hono().get('/', (c) => {
    // Key presence only, never values.
    const health: Health = {
      ok: true,
      keys: { worldlabs: Boolean(services.env.worldlabsKey), fal: Boolean(services.env.falKey) },
      sampleWatchAvailable: existsSync(path.join(services.env.samplesDir, 'casio_watch.glb')),
    }
    return c.json(health)
  })
}
