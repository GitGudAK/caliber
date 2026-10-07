import { Hono } from 'hono'
import type { Services } from '../app.ts'
import { badRequest, notFound } from './errors.ts'

export function providerRequestRoutes(services: Services) {
  return new Hono().get('/:hash', (c) => {
    const hash = c.req.param('hash')
    if (!/^[0-9a-f]{64}$/.test(hash)) throw badRequest(`Invalid request hash "${hash}" (expected 64 lowercase hex characters)`)
    const record = services.repo.providerRequests.get(hash)
    if (!record) throw notFound(`No provider request recorded for hash ${hash}`)
    return c.json(record)
  })
}
