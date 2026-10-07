import { existsSync } from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve(import.meta.dirname, '..')

const envPath = path.join(ROOT, '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

export const env = {
  port: Number(process.env.CALIBER_API_PORT ?? 8787),
  dataDir: path.join(ROOT, 'data'),
  samplesDir: path.join(ROOT, 'samples'),
  worldlabsKey: process.env.WORLDLABS_API_KEY || undefined,
  falKey: process.env.FAL_KEY || undefined,
}

export function requireKey(name: 'WORLDLABS_API_KEY' | 'FAL_KEY'): string {
  const value = name === 'WORLDLABS_API_KEY' ? env.worldlabsKey : env.falKey
  if (!value) throw new Error(`${name} is not set. Add it to caliber/.env and restart the server.`)
  return value
}
