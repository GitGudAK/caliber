// PATCH /api/projects/:id scene.shot validation and preservation, against a temp data dir.
// No network: only project routes are exercised.
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CameraShot, Placement, Project } from '../../shared/types.ts'
import { createApp, createServices } from '../app.ts'

// Vitest 2 (vite 5) strips the "node:" prefix from node:sqlite; hand it the real built-in.
vi.mock('node:sqlite', () => createRequire(import.meta.url)('node:sqlite'))

let dir: string
let app: ReturnType<typeof createApp>
let services: ReturnType<typeof createServices>
let projectId: string

const placement: Placement = {
  worldScale: 0.06,
  worldOffset: [0, 0.0294, 0],
  worldRotationY: 0,
  flipY: false,
  watch: { position: [0, 0, 0], rotation: [0, 0, 0], size: 0.065 },
  camera: { position: [0, 0.1, 0.3], target: [0, 0, 0], fov: 35 },
}

const validShot = (): CameraShot => ({
  hero: { position: [0, 0.1, 0.3], target: [0, 0, 0], fov: 35, focusDistance: 0.3 },
  move: 'push-in',
  amount: 0.3,
  direction: 1,
  durationSeconds: 4,
  easing: 'ease-in-out',
  keys: [
    { t: 0, position: [0, 0.1, 0.3], target: [0, 0, 0], fov: 35 },
    { t: 4, position: [0, 0.08, 0.2], target: [0, 0, 0], fov: 35, focusDistance: 0.2 },
  ],
})

const patch = (body: unknown) =>
  app.request(`/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const patchScene = (shot: unknown, extra: Record<string, unknown> = {}) =>
  patch({ scene: { presetId: null, placement, ...extra, ...(shot === undefined ? {} : { shot }) } })

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'caliber-shot-'))
  services = createServices(dir)
  app = createApp(services)
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Shot test' }),
  })
  projectId = ((await res.json()) as Project).id
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('PATCH scene.shot', () => {
  it('accepts a valid shot and returns it', async () => {
    const res = await patchScene(validShot())
    expect(res.status).toBe(200)
    const project = (await res.json()) as Project
    expect(project.scene.shot).toEqual(validShot())
    const again = (await (await app.request(`/api/projects/${projectId}`)).json()) as Project
    expect(again.scene.shot).toEqual(validShot())
  })

  it('accepts last t within 1e-6 of durationSeconds', async () => {
    const shot = validShot()
    shot.keys[1].t = 4 + 5e-7
    expect((await patchScene(shot)).status).toBe(200)
  })

  it('preserves the stored shot when a placement-only PATCH omits shot', async () => {
    await patchScene(validShot())
    const moved = { ...placement, worldScale: 0.08 }
    const res = await patch({ scene: { presetId: null, placement: moved } })
    expect(res.status).toBe(200)
    const project = (await res.json()) as Project
    expect(project.scene.placement?.worldScale).toBe(0.08)
    expect(project.scene.shot).toEqual(validShot())
  })

  it('preserves the stored shot on a name-only PATCH', async () => {
    await patchScene(validShot())
    const project = (await (await patch({ name: 'Renamed' })).json()) as Project
    expect(project.scene.shot).toEqual(validShot())
  })

  it('keeps the shot when presetId changes (framing is reusable) and fills the preset placement', async () => {
    await patchScene(validShot())
    const preset = services.repo.presets.create({
      name: 'Test world', templateId: null, files: { spz: {} }, semantics: {},
      defaultPlacement: placement, prompts: {}, provenance: {},
    })
    const res = await patch({ scene: { presetId: preset.id, placement: null } })
    expect(res.status).toBe(200)
    const project = (await res.json()) as Project
    expect(project.scene.presetId).toBe(preset.id)
    expect(project.scene.placement).toEqual(placement)
    expect(project.scene.shot).toEqual(validShot())
  })

  it('clears the shot with shot: null', async () => {
    await patchScene(validShot())
    const res = await patchScene(null)
    expect(res.status).toBe(200)
    expect(((await res.json()) as Project).scene.shot).toBeNull()
  })

  it('still rejects unknown scene fields', async () => {
    const res = await patchScene(undefined, { shots: validShot() })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('Unknown field "scene.shots"')
  })

  type Case = [string, (s: any) => void, string]
  const cases: Case[] = [
    ['fewer than 2 keys', (s) => (s.keys = [s.keys[0]]), '"scene.shot.keys" must have at least 2 keys'],
    ['keys not an array', (s) => (s.keys = {}), '"scene.shot.keys" must be an array'],
    ['unsorted t', (s) => s.keys.splice(1, 0, { ...s.keys[1], t: 3 }, { ...s.keys[1], t: 2 }), '"scene.shot.keys[2].t" must be greater than'],
    ['duplicate t', (s) => s.keys.splice(1, 0, { ...s.keys[1], t: 2 }, { ...s.keys[1], t: 2 }), '"scene.shot.keys[2].t" must be greater than'],
    ['first t not 0', (s) => (s.keys[0].t = 0.5), '"scene.shot.keys[0].t" must be 0'],
    ['last t != duration', (s) => (s.keys[1].t = 3), '"scene.shot.keys[1].t" must equal "scene.shot.durationSeconds"'],
    ['duration < 1', (s) => ((s.durationSeconds = 0.5), (s.keys[1].t = 0.5)), '"scene.shot.durationSeconds" must be between 1 and 60'],
    ['duration > 60', (s) => ((s.durationSeconds = 61), (s.keys[1].t = 61)), '"scene.shot.durationSeconds" must be between 1 and 60'],
    ['hero fov out of range', (s) => (s.hero.fov = 200), '"scene.shot.hero.fov" must be between 5 and 120 degrees (got 200)'],
    ['key fov out of range', (s) => (s.keys[1].fov = 2), '"scene.shot.keys[1].fov" must be between 5 and 120 degrees (got 2)'],
    ['vec3 wrong length', (s) => (s.keys[0].position = [0, 1]), '"scene.shot.keys[0].position" must be an array of 3 numbers'],
    ['vec3 non-finite', (s) => (s.hero.target = [0, 'x', 0]), '"scene.shot.hero.target[1]" must be a finite number'],
    ['focusDistance <= 0', (s) => (s.hero.focusDistance = 0), '"scene.shot.hero.focusDistance" must be > 0'],
    ['key focusDistance not a number', (s) => (s.keys[1].focusDistance = 'near'), '"scene.shot.keys[1].focusDistance" must be a finite number'],
    ['bad move', (s) => (s.move = 'zoom'), '"scene.shot.move" must be one of push-in'],
    ['bad easing', (s) => (s.easing = 'bounce'), '"scene.shot.easing" must be one of linear'],
    ['bad direction', (s) => (s.direction = 0), '"scene.shot.direction" must be 1 or -1'],
    ['amount not finite', (s) => (s.amount = 'big'), '"scene.shot.amount" must be a finite number'],
    ['missing field', (s) => delete s.easing, 'Missing field "scene.shot.easing"'],
    ['unknown field', (s) => (s.speed = 2), 'Unknown field "scene.shot.speed"'],
    ['unknown key field', (s) => (s.keys[0].roll = 1), 'Unknown field "scene.shot.keys[0].roll"'],
    ['key not an object', (s) => (s.keys[0] = 5), '"scene.shot.keys[0]" must be an object'],
    ['shot not an object', (s) => void s, '"scene.shot" must be an object'],
  ]

  it.each(cases)('rejects %s with a field-path 400', async (name, mutate, message) => {
    await patchScene(validShot())
    let shot: unknown = validShot()
    if (name === 'shot not an object') shot = 'push-in'
    else mutate(shot)
    const res = await patchScene(shot)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain(message)
    // A rejected PATCH leaves the stored shot untouched.
    const project = (await (await app.request(`/api/projects/${projectId}`)).json()) as Project
    expect(project.scene.shot).toEqual(validShot())
  })
})
