import { serve } from '@hono/node-server'
import { createApp, createServices } from './app.ts'
import { env } from './env.ts'

const HOST = '127.0.0.1'
const app = createApp(createServices())

const server = serve({ fetch: app.fetch, port: env.port, hostname: HOST }, (info) => {
  console.log(`[caliber] server listening on http://${HOST}:${info.port}`)
})

server.on('error', (error) => {
  console.error('[caliber] server failed to start:', error)
  process.exit(1)
})

const shutdown = () => {
  server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
