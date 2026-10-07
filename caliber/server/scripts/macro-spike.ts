// Spike: can World Labs Marble build a usable world from a macro tabletop image?
//
//   npx tsx server/scripts/macro-spike.ts image            # print the exact FAL request + hash (no call)
//   npx tsx server/scripts/macro-spike.ts image --confirm  # PAID: generate the scene still
//   npx tsx server/scripts/macro-spike.ts world <png>            # print the exact World Labs request + hash (no call)
//   npx tsx server/scripts/macro-spike.ts world <png> --confirm  # PAID: generate the world
//
// Outputs go to data/spikes/macro-desk/. The dry run and the paid run build the
// request with the same function (macroDeskRequests.ts), so what is shown is what is
// sent. Every --confirm goes through runPaidRequest against data/caliber.db: if this
// exact body already completed, nothing is sent and the stored outputs are printed.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProviderRequestRecord } from '../../shared/types.ts'
import { createSqliteRepository, type Repository } from '../db/repository.ts'
import { openDatabase } from '../db/sqlite.ts'
import { env, requireKey } from '../env.ts'
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
import { macroImageRequest, macroWorldRequest } from './macroDeskRequests.ts'

const OUT = path.join(env.dataDir, 'spikes', 'macro-desk')

function openRepo(): Repository {
  const db = openDatabase(path.join(env.dataDir, 'caliber.db'))
  return createSqliteRepository(db, (key) => `/assets/${key}`)
}

/** Print the hash and what the ledger already knows about it. */
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

async function image(confirm: boolean) {
  const req = macroImageRequest()
  console.log(JSON.stringify(buildFalSubmitRequest(req.endpoint, req.body), null, 2))
  const repo = openRepo()
  describeLedger(repo, req)
  if (!confirm) return console.log('\nDry run only. Re-run with --confirm to send this (paid).')

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

async function world(imagePath: string, confirm: boolean) {
  if (!imagePath) throw new Error('Pass the scene image path: world <png>')
  const req = macroWorldRequest(await readFile(imagePath), path.extname(imagePath))
  console.log(JSON.stringify(redactForDisplay(buildWorldSubmitRequest(req.body)), null, 2))
  const repo = openRepo()
  describeLedger(repo, req)
  if (!confirm) return console.log('\nDry run only. Re-run with --confirm to send this (paid).')

  // runPaidRequest checks the ledger first; send() (key + network) only runs on a miss.
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

const [command, arg] = process.argv.slice(2).filter((a) => a !== '--confirm')
const confirm = process.argv.includes('--confirm')
if (command === 'image') await image(confirm)
else if (command === 'world') await world(arg, confirm)
else console.log('Usage: macro-spike.ts image|world <png> [--confirm]')
