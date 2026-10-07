// Import the paid macro-desk spike (data/spikes/macro-desk) into the preset library.
// Local only: copies files into storage, writes asset/preset rows, and records both
// paid requests as 'completed' in the ledger so they can never be re-sent.
//
//   npx tsx server/scripts/import-preset.ts
//
// Idempotent: if a preset with this World Labs operation id exists, it is printed
// (and any missing ledger records are filled in) and nothing else happens.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AssetKind, Placement } from '../../shared/types.ts'
import { createSqliteRepository } from '../db/repository.ts'
import { openDatabase } from '../db/sqlite.ts'
import { env } from '../env.ts'
import { newId } from '../ids.ts'
import { requestHash } from '../providers/requestHash.ts'
import { createLocalStorage } from '../storage/storage.ts'
import { mimeFor } from '../storage/mime.ts'
import { macroImageRequest, macroWorldRequest } from './macroDeskRequests.ts'

const SOURCE_REL = 'data/spikes/macro-desk'
const SOURCE = path.join(env.dataDir, 'spikes', 'macro-desk')
const FAL_REQUEST_ID = '01a11335-851f-7b52-a0c4-d712f52db30b'
const WORLDLABS_OPERATION_ID = 'd335f052-1052-4756-9006-a3b2ff825a2c'
const SCENE_PNG = path.join(SOURCE, `scene-${FAL_REQUEST_ID}.png`)
const SCENE_JSON = path.join(SOURCE, `scene-${FAL_REQUEST_ID}.json`)
const WORLD_DIR = path.join(SOURCE, `world-${WORLDLABS_OPERATION_ID}`)

// Hand-tuned by the lead in the viewer.
const DEFAULT_PLACEMENT: Placement = {
  worldScale: 0.06,
  worldOffset: [0, 0.0294, 0],
  worldRotationY: 0,
  flipY: true,
  watch: { position: [0, 0.0265, -0.05], rotation: [0, 3.14159265, 0], size: 0.065 },
  camera: { position: [0.04, 0.0994, 0.04], target: [0, 0.0265, -0.05], fov: 35 },
}

const storage = createLocalStorage(path.join(env.dataDir, 'assets'), '/assets')
const db = openDatabase(path.join(env.dataDir, 'caliber.db'))
const repo = createSqliteRepository(db, (key) => storage.url(key))

// --- Rebuild both paid bodies with the shared builders and check they match ---
const scene = JSON.parse(await readFile(SCENE_JSON, 'utf8')) as { request: Record<string, unknown>; response: unknown }
const worldResponse = JSON.parse(await readFile(path.join(WORLD_DIR, 'world.json'), 'utf8')) as {
  assets?: { splats?: { spz_urls?: Record<string, string>; semantics_metadata?: Record<string, unknown> } }
}

const falReq = macroImageRequest()
const falHash = requestHash(falReq.provider, falReq.endpoint, scene.request)
if (falHash !== requestHash(falReq.provider, falReq.endpoint, falReq.body)) {
  throw new Error('The stored FAL request differs from macroImageRequest(); the ledger hash would not match macro-spike.ts. Not importing.')
}
const worldReq = macroWorldRequest(await readFile(SCENE_PNG), path.extname(SCENE_PNG))
const worldHash = requestHash(worldReq.provider, worldReq.endpoint, worldReq.body)

const ensureLedger = (presetId: string, assetIds: { fal: string[]; world: string[] }) => {
  const records = [
    { hash: falHash, provider: falReq.provider, endpoint: falReq.endpoint, request: falReq.displayBody, providerRef: FAL_REQUEST_ID, response: scene.response, outputs: { assetIds: assetIds.fal, presetId } },
    { hash: worldHash, provider: worldReq.provider, endpoint: worldReq.endpoint, request: worldReq.displayBody, providerRef: WORLDLABS_OPERATION_ID, response: worldResponse, outputs: { assetIds: assetIds.world, presetId } },
  ]
  for (const record of records) {
    const existing = repo.providerRequests.get(record.hash)
    if (existing?.status === 'completed') {
      console.log(`ledger ${record.provider} ${record.hash} already completed`)
      continue
    }
    repo.providerRequests.put({ ...record, status: 'completed', error: null })
    console.log(`ledger ${record.provider} ${record.hash} recorded completed`)
  }
}

const existing = repo.presets.list().find((p) => p.provenance.worldlabsOperationId === WORLDLABS_OPERATION_ID)
if (existing) {
  console.log(`Already imported as preset ${existing.id} ("${existing.name}"). Nothing copied.`)
  const f = existing.files
  ensureLedger(existing.id, {
    fal: f.sceneImage ? [f.sceneImage.id] : [],
    world: [...Object.values(f.spz), f.collider, f.pano, f.thumbnail, f.worldJson].filter((a) => !!a).map((a) => a!.id),
  })
  console.log(JSON.stringify(existing, null, 2))
  process.exit(0)
}

// --- Copy files into storage under presets/<presetId>/ ---
// The id is chosen up front so storage keys can use it before the row exists.
const presetId = newId()
const spzUrls = worldResponse.assets?.splats?.spz_urls ?? {}
const files: Array<{ source: string; filename: string; kind: AssetKind; meta: Record<string, unknown> }> = [
  { source: SCENE_PNG, filename: 'scene.png', kind: 'scene-image', meta: { falRequestId: FAL_REQUEST_ID } },
  ...Object.keys(spzUrls).map((resolution) => ({
    source: path.join(WORLD_DIR, `world-${resolution.replace(/[^a-z0-9_-]/gi, '_')}.spz`),
    filename: `world-${resolution.replace(/[^a-z0-9_-]/gi, '_')}.spz`,
    kind: 'world-spz' as const,
    meta: { resolution },
  })),
  { source: path.join(WORLD_DIR, 'collider.glb'), filename: 'collider.glb', kind: 'world-collider', meta: {} },
  { source: path.join(WORLD_DIR, 'pano.png'), filename: 'pano.png', kind: 'world-pano', meta: {} },
  { source: path.join(WORLD_DIR, 'thumbnail.webp'), filename: 'thumbnail.webp', kind: 'world-thumbnail', meta: {} },
  { source: path.join(WORLD_DIR, 'world.json'), filename: 'world.json', kind: 'world-json', meta: {} },
]
if (!Object.keys(spzUrls).length) throw new Error('world.json has no assets.splats.spz_urls; nothing to import.')

const copied: Array<(typeof files)[number] & { key: string; bytes: number }> = []
for (const file of files) {
  const key = `presets/${presetId}/${file.filename}`
  const { bytes } = await storage.saveFromFile(key, file.source)
  copied.push({ ...file, key, bytes })
  console.log(`copied ${path.relative(env.dataDir, file.source)} -> ${key} (${bytes} bytes)`)
}

// --- Rows, in one transaction ---
db.exec('BEGIN')
try {
  const assets = copied.map((f) => ({
    file: f,
    asset: repo.assets.create({ projectId: null, kind: f.kind, key: f.key, filename: f.filename, mime: mimeFor(f.filename), bytes: f.bytes, meta: f.meta }),
  }))
  const idOf = (kind: AssetKind) => assets.find((a) => a.file.kind === kind)?.asset.id
  const spz: Record<string, string> = {}
  for (const { file, asset } of assets) if (file.kind === 'world-spz') spz[String(file.meta.resolution)] = asset.id

  repo.presets.create({
    id: presetId,
    name: 'Morning Desk — macro oak',
    templateId: 'morning-desk',
    files: {
      sceneImage: idOf('scene-image'),
      spz,
      collider: idOf('world-collider'),
      pano: idOf('world-pano'),
      thumbnail: idOf('world-thumbnail'),
      worldJson: idOf('world-json'),
    },
    semantics: worldResponse.assets?.splats?.semantics_metadata ?? {},
    defaultPlacement: DEFAULT_PLACEMENT,
    prompts: { sceneImage: String(scene.request.prompt), world: worldReq.body.world_prompt.type === 'image' ? worldReq.body.world_prompt.text_prompt : undefined },
    provenance: { falRequestId: FAL_REQUEST_ID, worldlabsOperationId: WORLDLABS_OPERATION_ID, importedFrom: SOURCE_REL },
  })

  ensureLedger(presetId, {
    fal: assets.filter((a) => a.file.kind === 'scene-image').map((a) => a.asset.id),
    world: assets.filter((a) => a.file.kind !== 'scene-image').map((a) => a.asset.id),
  })
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  for (const f of copied) await storage.delete(f.key)
  throw error
}

console.log(`\nImported preset ${presetId}`)
console.log(`FAL hash        ${falHash}`)
console.log(`World Labs hash ${worldHash}`)
console.log(JSON.stringify(repo.presets.get(presetId), null, 2))
