// Theme-driven preset world pipeline (generalizes macro-spike.ts + import-preset.ts).
//
//   npx tsx server/scripts/theme-world.ts image <themeId>                  # print exact FAL request + hash (no call)
//   npx tsx server/scripts/theme-world.ts image <themeId> --confirm        # PAID: generate the scene still
//   npx tsx server/scripts/theme-world.ts world <themeId> <png>            # print exact World Labs request + hash (no call)
//   npx tsx server/scripts/theme-world.ts world <themeId> <png> --confirm  # PAID: generate the world
//   npx tsx server/scripts/theme-world.ts import <themeId>                 # local only: copy into the preset library
//
// Themes live in themes.ts. Outputs go to data/spikes/<themeId>/ with the same layout as
// the desk (scene-<falId>.png/.json, world-<operationId>/...). Dry run and paid run build
// the request with the same function, so what is shown is what is sent. Every --confirm
// goes through runPaidRequest: if this exact body already completed, nothing is sent.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AssetKind, Placement, ProviderRequestRecord } from '../../shared/types.ts'
import { createSqliteRepository, type Repository } from '../db/repository.ts'
import { openDatabase } from '../db/sqlite.ts'
import { env, requireKey } from '../env.ts'
import { newId } from '../ids.ts'
import { runPaidRequest } from '../jobs/paidRequest.ts'
import { buildFalSubmitRequest, runFal } from '../providers/fal.ts'
import { fetchBytes, redactForDisplay } from '../providers/http.ts'
import { nanoBananaImages } from '../providers/nanoBanana.ts'
import { requestHash } from '../providers/requestHash.ts'
import {
  assetKeyForFilename,
  buildWorldSubmitRequest,
  extensionFromUrl,
  operationId,
  pollOperation,
  submitWorld,
  worldAssetUrls,
} from '../providers/worldlabs.ts'
import { mimeFor } from '../storage/mime.ts'
import { createLocalStorage } from '../storage/storage.ts'
import { colliderSurfaceHeight } from './colliderHeight.ts'
import { getTheme, type Theme, themeImageRequest, themeWorldRequest } from './themes.ts'

const outDir = (theme: Theme) => path.join(env.dataDir, 'spikes', theme.id)

function openDb() {
  const db = openDatabase(path.join(env.dataDir, 'caliber.db'))
  const storage = createLocalStorage(path.join(env.dataDir, 'assets'), '/assets')
  return { db, storage, repo: createSqliteRepository(db, (key) => storage.url(key)) }
}

function describeLedger(repo: Repository, req: { provider: string; endpoint: string; body: unknown }) {
  const hash = requestHash(req.provider, req.endpoint, req.body)
  const existing = repo.providerRequests.get(hash)
  console.log(`\nrequest hash ${hash}`)
  console.log(
    existing
      ? `ledger: ${existing.status}${existing.status === 'completed' ? ' (already generated; --confirm would send nothing)' : ''}` +
          `${existing.providerRef ? `, provider ref ${existing.providerRef}` : ''}`
      : 'ledger: not yet sent',
  )
}

function printCached(record: ProviderRequestRecord) {
  console.log(`\nAlready generated (hash ${record.hash}) — reusing outputs, nothing sent`)
  console.log(JSON.stringify({ providerRef: record.providerRef, outputs: record.outputs, completedAt: record.updatedAt }, null, 2))
}

async function image(theme: Theme, confirm: boolean) {
  const req = themeImageRequest(theme)
  console.log(`theme ${theme.id} ("${theme.name}")`)
  console.log(JSON.stringify(redactForDisplay(buildFalSubmitRequest(req.endpoint, req.body)), null, 2))
  const { repo } = openDb()
  describeLedger(repo, req)
  if (!confirm) return console.log('\nDry run only. Re-run with --confirm to send this (paid).')

  const OUT = outDir(theme)
  // runPaidRequest checks the ledger first; send() (key + network) only runs on a miss.
  const result = await runPaidRequest({
    repo,
    ...req,
    send: async ({ onProviderRef }) => {
      const apiKey = requireKey('FAL_KEY')
      await mkdir(OUT, { recursive: true })
      const { submitted, data } = await runFal(req.endpoint, req.body, {
        apiKey,
        fetch,
        onSubmit: (s) => {
          onProviderRef(s.requestId)
          console.log(`submitted ${s.requestId}`)
        },
        onStatus: (s) => console.log(`status ${s.status}${s.queuePosition != null ? ` (queue ${s.queuePosition})` : ''}`),
      })
      const [file] = nanoBananaImages(data)
      const target = path.join(OUT, `scene-${submitted.requestId}.png`)
      await writeFile(target, await fetchBytes(file.url, { fetch, provider: 'FAL' }))
      await writeFile(path.join(OUT, `scene-${submitted.requestId}.json`), JSON.stringify({ request: req.body, response: data }, null, 2))
      console.log(`saved ${target}`)
      return { providerRef: submitted.requestId, response: data, outputs: {} }
    },
  })
  if (result.cached) printCached(result.record)
}

async function world(theme: Theme, imagePath: string | undefined, confirm: boolean) {
  if (!imagePath) throw new Error('Pass the scene image path: world <themeId> <png>')
  const req = themeWorldRequest(theme, await readFile(imagePath), path.extname(imagePath))
  console.log(`theme ${theme.id} ("${theme.name}")`)
  console.log(JSON.stringify(redactForDisplay(buildWorldSubmitRequest(req.body)), null, 2))
  const { repo } = openDb()
  describeLedger(repo, req)
  if (!confirm) return console.log('\nDry run only. Re-run with --confirm to send this (paid).')

  const OUT = outDir(theme)
  const result = await runPaidRequest({
    repo,
    ...req,
    send: async ({ onProviderRef }) => {
      const apiKey = requireKey('WORLDLABS_API_KEY')
      const operation = await submitWorld(req.body, { apiKey, fetch })
      const id = operationId(operation)
      onProviderRef(id)
      console.log(`submitted operation ${id}`)
      const done = await pollOperation(operation, {
        apiKey,
        fetch,
        onStatus: (s) => console.log(`${new Date().toLocaleTimeString()} ${s.status}`),
      })
      const dir = path.join(OUT, `world-${id}`)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'world.json'), JSON.stringify(done.response, null, 2))
      const urls = worldAssetUrls(done.response!)
      const downloads: [string, string][] = [
        ...Object.entries(urls.spz).map(([k, u]): [string, string] => [u, `world-${assetKeyForFilename(k)}.spz`]),
        ...(urls.colliderMeshUrl ? [[urls.colliderMeshUrl, 'collider.glb'] as [string, string]] : []),
        ...(urls.panoUrl ? [[urls.panoUrl, `pano${extensionFromUrl(urls.panoUrl, '.png')}`] as [string, string]] : []),
        ...(urls.thumbnailUrl ? [[urls.thumbnailUrl, `thumbnail${extensionFromUrl(urls.thumbnailUrl, '.webp')}`] as [string, string]] : []),
      ]
      for (const [url, name] of downloads) {
        await writeFile(path.join(dir, name), await fetchBytes(url, { fetch, provider: 'World Labs' }))
        console.log(`saved ${path.join(dir, name)}`)
      }
      console.log('semantics', JSON.stringify(urls.semanticsMetadata))
      return { providerRef: id, response: done.response, outputs: {} }
    },
  })
  if (result.cached) printCached(result.record)
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/** Find this theme's paid outputs on disk, cross-checked against the request hashes. */
async function locateOutputs(theme: Theme, repo: Repository) {
  const SOURCE = outDir(theme)
  const entries = await readdir(SOURCE).catch(() => {
    throw new Error(`${SOURCE} does not exist; run image/world --confirm first.`)
  })
  const falReq = themeImageRequest(theme)
  const falHash = requestHash(falReq.provider, falReq.endpoint, falReq.body)

  // Scene: the scene-<id>.json whose stored request hashes to this theme's FAL body.
  const scenes: Array<{ id: string; request: unknown; response: unknown }> = []
  for (const name of entries.filter((n) => /^scene-.+\.json$/.test(n))) {
    const stored = JSON.parse(await readFile(path.join(SOURCE, name), 'utf8')) as { request: unknown; response: unknown }
    if (requestHash(falReq.provider, falReq.endpoint, stored.request) === falHash) {
      scenes.push({ id: name.slice('scene-'.length, -'.json'.length), ...stored })
    }
  }
  if (scenes.length !== 1) {
    throw new Error(`Expected exactly one scene-*.json in ${SOURCE} matching FAL hash ${falHash}; found ${scenes.length}. Not importing.`)
  }
  const scene = scenes[0]
  const falLedger = repo.providerRequests.get(falHash)
  if (falLedger?.providerRef && falLedger.providerRef !== scene.id) {
    throw new Error(`Ledger FAL ref ${falLedger.providerRef} does not match ${scene.id} on disk. Not importing.`)
  }
  const scenePng = path.join(SOURCE, `scene-${scene.id}.png`)

  // World: rebuild the World Labs body from the scene PNG; the ledger names the operation.
  const worldReq = themeWorldRequest(theme, await readFile(scenePng), path.extname(scenePng))
  const worldHash = requestHash(worldReq.provider, worldReq.endpoint, worldReq.body)
  const worldLedger = repo.providerRequests.get(worldHash)
  const worldDirs = entries.filter((n) => n.startsWith('world-'))
  let operation: string
  if (worldLedger?.providerRef) {
    operation = worldLedger.providerRef
    if (!worldDirs.includes(`world-${operation}`)) throw new Error(`Ledger names operation ${operation} but ${SOURCE}/world-${operation} is missing.`)
  } else if (worldDirs.length === 1) {
    operation = worldDirs[0].slice('world-'.length)
    console.log(`note: no ledger ref for World Labs hash ${worldHash}; using the only world dir, ${worldDirs[0]}`)
  } else {
    throw new Error(`Cannot tell which world dir belongs to World Labs hash ${worldHash} (ledger has no ref; found ${worldDirs.length} dirs).`)
  }
  return { SOURCE, scene, scenePng, falReq, falHash, worldReq, worldHash, operation, worldDir: path.join(SOURCE, `world-${operation}`) }
}

async function importTheme(theme: Theme) {
  const { db, storage, repo } = openDb()
  const o = await locateOutputs(theme, repo)
  const worldResponse = JSON.parse(await readFile(path.join(o.worldDir, 'world.json'), 'utf8')) as {
    assets?: { splats?: { spz_urls?: Record<string, string>; semantics_metadata?: Record<string, unknown> } }
  }

  const ensureLedger = (presetId: string, assetIds: { fal: string[]; world: string[] }) => {
    const records = [
      { hash: o.falHash, provider: o.falReq.provider, endpoint: o.falReq.endpoint, request: o.falReq.displayBody, providerRef: o.scene.id, response: o.scene.response, outputs: { assetIds: assetIds.fal, presetId } },
      { hash: o.worldHash, provider: o.worldReq.provider, endpoint: o.worldReq.endpoint, request: o.worldReq.displayBody, providerRef: o.operation, response: worldResponse, outputs: { assetIds: assetIds.world, presetId } },
    ]
    for (const record of records) {
      const existing = repo.providerRequests.get(record.hash)
      if (existing?.status === 'completed') {
        console.log(`ledger ${record.provider} ${record.hash} already completed (ref ${existing.providerRef})`)
        continue
      }
      repo.providerRequests.put({ ...record, status: 'completed', error: null })
      console.log(`ledger ${record.provider} ${record.hash} recorded completed`)
    }
  }

  const existing = repo.presets.list().find((p) => p.provenance.worldlabsOperationId === o.operation)
  if (existing) {
    console.log(`Already imported as preset ${existing.id} ("${existing.name}"). Nothing copied.`)
    const f = existing.files
    ensureLedger(existing.id, {
      fal: f.sceneImage ? [f.sceneImage.id] : [],
      world: [...Object.values(f.spz), f.collider, f.pano, f.thumbnail, f.worldJson].filter((a) => !!a).map((a) => a!.id),
    })
    console.log(JSON.stringify(existing, null, 2))
    return
  }

  // --- Placement: drop the surface to y ≈ 0 using the collider ---
  const placement: Placement = structuredClone(theme.defaultPlacement)
  let calibration: Record<string, unknown> | null = null
  if (theme.calibrateHeightFromCollider) {
    const h = await colliderSurfaceHeight(path.join(o.worldDir, 'collider.glb'), placement.worldScale, placement.flipY)
    placement.worldOffset = [placement.worldOffset[0], Number(h.worldOffsetY.toFixed(4)), placement.worldOffset[2]]
    calibration = { ...h }
    console.log(
      `collider surface: median y ${h.medianY.toFixed(4)} raw (flipped frame; ${h.hits}/${h.rays} rays hit, ` +
        `range ${h.minY.toFixed(4)}..${h.maxY.toFixed(4)}; vertex median ${h.vertexMedianY?.toFixed(4) ?? 'n/a'} over ${h.vertexSamples} vertices) ` +
        `-> worldOffset[1] = ${placement.worldOffset[1]} at worldScale ${h.worldScale}`,
    )
  }

  // --- Copy files into storage under presets/<presetId>/ ---
  const presetId = newId()
  const spzUrls = worldResponse.assets?.splats?.spz_urls ?? {}
  if (!Object.keys(spzUrls).length) throw new Error('world.json has no assets.splats.spz_urls; nothing to import.')
  const worldFiles = await readdir(o.worldDir)
  const pick = (prefix: string) => {
    const name = worldFiles.find((n) => n.startsWith(prefix))
    if (!name) throw new Error(`${o.worldDir} has no ${prefix}* file`)
    return name
  }
  const pano = pick('pano.')
  const thumb = pick('thumbnail.')
  const files: Array<{ source: string; filename: string; kind: AssetKind; meta: Record<string, unknown> }> = [
    { source: o.scenePng, filename: 'scene.png', kind: 'scene-image', meta: { falRequestId: o.scene.id } },
    ...Object.keys(spzUrls).map((resolution) => ({
      source: path.join(o.worldDir, `world-${assetKeyForFilename(resolution)}.spz`),
      filename: `world-${assetKeyForFilename(resolution)}.spz`,
      kind: 'world-spz' as const,
      meta: { resolution },
    })),
    { source: path.join(o.worldDir, 'collider.glb'), filename: 'collider.glb', kind: 'world-collider', meta: {} },
    { source: path.join(o.worldDir, pano), filename: pano, kind: 'world-pano', meta: {} },
    { source: path.join(o.worldDir, thumb), filename: thumb, kind: 'world-thumbnail', meta: {} },
    { source: path.join(o.worldDir, 'world.json'), filename: 'world.json', kind: 'world-json', meta: {} },
  ]

  const copied: Array<(typeof files)[number] & { key: string; bytes: number }> = []
  try {
    for (const file of files) {
      const key = `presets/${presetId}/${file.filename}`
      const { bytes } = await storage.saveFromFile(key, file.source)
      copied.push({ ...file, key, bytes })
      console.log(`copied ${path.relative(env.dataDir, file.source)} -> ${key} (${bytes} bytes)`)
    }
  } catch (error) {
    for (const f of copied) await storage.delete(f.key)
    throw error
  }

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
      name: theme.name,
      templateId: theme.templateId,
      files: {
        sceneImage: idOf('scene-image'),
        spz,
        collider: idOf('world-collider'),
        pano: idOf('world-pano'),
        thumbnail: idOf('world-thumbnail'),
        worldJson: idOf('world-json'),
      },
      semantics: worldResponse.assets?.splats?.semantics_metadata ?? {},
      defaultPlacement: placement,
      prompts: { sceneImage: theme.sceneImagePrompt, world: theme.worldTextPrompt },
      provenance: {
        themeId: theme.id,
        falRequestId: o.scene.id,
        worldlabsOperationId: o.operation,
        importedFrom: path.relative(path.dirname(env.dataDir), o.SOURCE),
        ...(calibration ? { heightCalibration: calibration } : {}),
      },
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
  console.log(`FAL hash        ${o.falHash}`)
  console.log(`World Labs hash ${o.worldHash}`)
  if (theme.calibrateHeightFromCollider) {
    console.log('note: worldOffset[1] was calibrated from collider.glb so the surface sits at y ≈ 0; watch/camera are untuned defaults.')
  }
  console.log(JSON.stringify(repo.presets.get(presetId), null, 2))
}

const args = process.argv.slice(2).filter((a) => a !== '--confirm')
const confirm = process.argv.includes('--confirm')
const [command, themeId, arg] = args
if (command === 'image') await image(getTheme(themeId), confirm)
else if (command === 'world') await world(getTheme(themeId), arg, confirm)
else if (command === 'import') await importTheme(getTheme(themeId))
else console.log('Usage: theme-world.ts image <themeId> [--confirm] | world <themeId> <png> [--confirm] | import <themeId>')
