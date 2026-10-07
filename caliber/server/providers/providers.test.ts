// All network access goes through a fake fetch. No real keys, no real calls.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeAndPostprocessAudio, buildSfxInput, normalizeSfxCount, sfxAudioFile } from './elevenlabs.ts'
import { buildFalSubmitRequest, bytesToDataUri, collectRemoteFiles, runFal, submitFal } from './fal.ts'
import { type FetchLike, redactForDisplay } from './http.ts'
import { buildHunyuanInput, hunyuanOutputFiles } from './hunyuan.ts'
import { buildEditInput, buildTextToImageInput, nanoBananaImages } from './nanoBanana.ts'
import {
  buildWorldRequest,
  pollOperation,
  submitWorld,
  type WorldResponse,
  worldAssetUrls,
} from './worldlabs.ts'

const FAKE_KEY = 'test-key-not-real-1234567890'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = []
  const queue = [...responses]
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    })
    const next = queue.shift()
    if (!next) throw new Error(`fake fetch: unexpected call to ${String(input)}`)
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body)
    return new Response(text, { status: next.status ?? 200 })
  }) as FetchLike
  return { fetch: fn, calls }
}

// ---------------------------------------------------------------------------
describe('FAL queue', () => {
  const endpoint = 'fal-ai/nano-banana-2'
  const statusUrl = `https://queue.fal.run/fal-ai/nano-banana-2/requests/req-1/status`
  const responseUrl = `https://queue.fal.run/fal-ai/nano-banana-2/requests/req-1`

  it('submits, polls with logs=1 until COMPLETED, and fetches the result', async () => {
    const { fetch, calls } = fakeFetch([
      { body: { request_id: 'req-1', status_url: statusUrl, response_url: responseUrl } },
      { body: { status: 'IN_QUEUE', queue_position: 2 } },
      { body: { status: 'IN_PROGRESS', logs: [{ message: 'step 1' }] } },
      { body: { status: 'COMPLETED' } },
      { body: { images: [{ url: 'https://v3.fal.media/x.png' }], description: '' } },
    ])
    const updates: Array<{ status: string; queuePosition?: number; logs: unknown[] }> = []
    const input = buildTextToImageInput({ prompt: 'a marble plinth' })
    const result = await runFal(endpoint, input, {
      apiKey: FAKE_KEY,
      fetch,
      intervalMs: 1,
      onStatus: (u) => {
        updates.push({ status: u.status, queuePosition: u.queuePosition, logs: u.logs })
      },
    })

    expect(calls[0]).toMatchObject({
      url: 'https://queue.fal.run/fal-ai/nano-banana-2',
      method: 'POST',
      headers: { Authorization: `Key ${FAKE_KEY}`, 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(calls[0].body!)).toEqual(input)
    for (const c of calls.slice(1, 4)) {
      expect(c.url).toBe(`${statusUrl}?logs=1`)
      expect(c.method).toBe('GET')
      expect(c.headers).toEqual({ Authorization: `Key ${FAKE_KEY}` })
    }
    expect(calls[4].url).toBe(responseUrl)
    expect(updates.map((u) => u.status)).toEqual(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'])
    expect(updates[0].queuePosition).toBe(2)
    expect(updates[1].logs).toEqual([{ message: 'step 1' }])
    expect(nanoBananaImages(result.data)[0].url).toBe('https://v3.fal.media/x.png')
  })

  it('surfaces FAL 422 validation detail in the error and never leaks the key', async () => {
    const { fetch } = fakeFetch([
      {
        status: 422,
        body: { detail: [{ loc: ['body', 'prompt'], msg: `bad prompt for Key ${FAKE_KEY}`, type: 'value_error' }] },
      },
    ])
    const err = await submitFal(endpoint, { prompt: 'x' }, { apiKey: FAKE_KEY, fetch }).catch((e) => e)
    expect(err.message).toContain('FAL submit failed (422): body.prompt: bad prompt')
    expect(err.message).not.toContain(FAKE_KEY)
  })

  it('surfaces string detail and non-JSON bodies; truncates long bodies', async () => {
    const long = 'x'.repeat(5000)
    const { fetch } = fakeFetch([{ status: 401, body: { detail: 'Invalid key' } }, { status: 500, body: long }])
    await expect(submitFal(endpoint, {}, { apiKey: FAKE_KEY, fetch })).rejects.toThrow(
      'FAL submit failed (401): Invalid key',
    )
    const err = await submitFal(endpoint, {}, { apiKey: FAKE_KEY, fetch }).catch((e) => e)
    expect(err.message.length).toBeLessThan(800)
    expect(err.message).toContain('more chars')
  })

  it('throws when COMPLETED carries an error', async () => {
    const { fetch } = fakeFetch([
      { body: { request_id: 'req-1', status_url: statusUrl, response_url: responseUrl } },
      { body: { status: 'COMPLETED', error: 'NSFW content detected' } },
    ])
    await expect(runFal(endpoint, {}, { apiKey: FAKE_KEY, fetch, intervalMs: 1 })).rejects.toThrow(
      'FAL request failed: NSFW content detected',
    )
  })

  it('surfaces status and result HTTP errors with body', async () => {
    const { fetch } = fakeFetch([
      { body: { request_id: 'req-1', status_url: statusUrl, response_url: responseUrl } },
      { body: { status: 'COMPLETED' } },
      { status: 400, body: { detail: 'Image could not be processed' } },
    ])
    await expect(runFal(endpoint, {}, { apiKey: FAKE_KEY, fetch, intervalMs: 1 })).rejects.toThrow(
      'FAL result failed (400): Image could not be processed',
    )
  })

  it('aborts while waiting between polls', async () => {
    const { fetch } = fakeFetch([
      { body: { request_id: 'req-1', status_url: statusUrl, response_url: responseUrl } },
      { body: { status: 'IN_QUEUE' } },
    ])
    const controller = new AbortController()
    const p = runFal(endpoint, {}, { apiKey: FAKE_KEY, fetch, intervalMs: 60_000, signal: controller.signal })
    setTimeout(() => controller.abort(new Error('cancelled by user')), 10)
    await expect(p).rejects.toThrow('cancelled by user')
  })

  it('falls back to standard queue URLs when submit omits them', async () => {
    const { fetch } = fakeFetch([{ body: { request_id: 'abc' } }])
    const s = await submitFal('fal-ai/hunyuan3d-v3/image-to-3d', {}, { apiKey: FAKE_KEY, fetch })
    expect(s.statusUrl).toBe('https://queue.fal.run/fal-ai/hunyuan3d-v3/image-to-3d/requests/abc/status')
    expect(s.responseUrl).toBe('https://queue.fal.run/fal-ai/hunyuan3d-v3/image-to-3d/requests/abc')
  })

  it('buildFalSubmitRequest shows the request without the key', () => {
    const r = buildFalSubmitRequest('fal-ai/x', { a: 1 })
    expect(r.url).toBe('https://queue.fal.run/fal-ai/x')
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY)
  })
})

// ---------------------------------------------------------------------------
describe('World Labs', () => {
  it('builds text, image-base64 and image-uri requests exactly like image-blaster', () => {
    expect(buildWorldRequest({ displayName: 'w', textPrompt: 'empty studio' })).toEqual({
      display_name: 'w',
      model: 'marble-1.1',
      world_prompt: { type: 'text', text_prompt: 'empty studio' },
    })
    expect(
      buildWorldRequest({
        displayName: 'w',
        textPrompt: 'tp',
        image: { base64: 'AAAA', extension: '.jpg', mimeType: 'image/jpeg' },
      }),
    ).toEqual({
      display_name: 'w',
      model: 'marble-1.1',
      world_prompt: {
        type: 'image',
        image_prompt: { source: 'data_base64', data_base64: 'AAAA', extension: 'jpg', mime_type: 'image/jpeg' },
        text_prompt: 'tp',
      },
    })
    const uri = buildWorldRequest({ displayName: 'w', image: { uri: 'https://x/y.png' } })
    expect(uri.world_prompt).toEqual({ type: 'image', image_prompt: { source: 'uri', uri: 'https://x/y.png' } })
    expect(() => buildWorldRequest({ displayName: 'w' })).toThrow('requires a source image or a text prompt')
    expect(() => buildWorldRequest({ displayName: '', textPrompt: 'x' })).toThrow('displayName is required')
  })

  it('submits and polls /operations/{id} with WLT-Api-Key until done', async () => {
    const response: WorldResponse = { assets: { splats: { spz_urls: { full_res: 'https://cdn/w.spz' } } } }
    const { fetch, calls } = fakeFetch([
      { body: { operation_id: 'operations/op-9', done: false } },
      { body: { operation_id: 'op-9', done: false, metadata: { progress: 0.5 } } },
      { body: { operation_id: 'op-9', done: true, response } },
    ])
    const request = buildWorldRequest({ displayName: 'w', textPrompt: 'p' })
    const op = await submitWorld(request, { apiKey: FAKE_KEY, fetch })
    const statuses: string[] = []
    const done = await pollOperation(op, {
      apiKey: FAKE_KEY,
      fetch,
      intervalMs: 1,
      onStatus: (u) => {
        statuses.push(u.status)
      },
    })

    expect(calls[0]).toMatchObject({
      url: 'https://api.worldlabs.ai/marble/v1/worlds:generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'WLT-Api-Key': FAKE_KEY },
    })
    expect(JSON.parse(calls[0].body!)).toEqual(request)
    expect(calls[1].url).toBe('https://api.worldlabs.ai/marble/v1/operations/op-9')
    expect(calls[1].headers).toEqual({ 'WLT-Api-Key': FAKE_KEY })
    expect(statuses).toEqual(['running', 'completed'])
    expect(done.response).toEqual(response)
  })

  it('surfaces submit error bodies and operation errors', async () => {
    const { fetch } = fakeFetch([
      { status: 400, body: { message: 'Image too small' } },
      { body: { operation_id: 'op-1', done: true, error: { code: 3, message: 'content policy' } } },
    ])
    await expect(
      submitWorld(buildWorldRequest({ displayName: 'w', textPrompt: 'p' }), { apiKey: FAKE_KEY, fetch }),
    ).rejects.toThrow('World Labs submit failed (400): Image too small')
    await expect(
      pollOperation({ operation_id: 'op-1', done: false }, { apiKey: FAKE_KEY, fetch, intervalMs: 1 }),
    ).rejects.toThrow('World Labs generation failed: {"code":3,"message":"content policy"}')
  })

  it('surfaces poll HTTP errors and missing response', async () => {
    const { fetch } = fakeFetch([
      { status: 404, body: { error: 'operation not found' } },
      { body: { operation_id: 'op-1', done: true } },
    ])
    await expect(
      pollOperation({ operation_id: 'op-1', done: false }, { apiKey: FAKE_KEY, fetch, intervalMs: 1 }),
    ).rejects.toThrow('World Labs poll failed (404): operation not found')
    await expect(
      pollOperation({ operation_id: 'op-1', done: false }, { apiKey: FAKE_KEY, fetch, intervalMs: 1 }),
    ).rejects.toThrow('completed without response')
  })

  it('extracts all asset URLs from a realistic response', () => {
    // Shaped from the fields generate-world.mjs reads (downloadWorldAssets) and the
    // semantics_metadata keys noted in caliber/CLAUDE.md.
    const response: WorldResponse = {
      id: 'world_abc',
      display_name: 'watch-studio',
      assets: {
        caption: 'A minimalist marble studio',
        thumbnail_url: 'https://cdn.worldlabs.ai/w/abc/thumb.webp',
        imagery: { pano_url: 'https://cdn.worldlabs.ai/w/abc/pano.png' },
        mesh: { collider_mesh_url: 'https://cdn.worldlabs.ai/w/abc/collider.glb' },
        splats: {
          spz_urls: {
            '100k': 'https://cdn.worldlabs.ai/w/abc/100k.spz',
            '500k': 'https://cdn.worldlabs.ai/w/abc/500k.spz',
            full_res: 'https://cdn.worldlabs.ai/w/abc/full.spz',
            missing: null,
          },
          semantics_metadata: { ground_plane_offset: 1.42, flip_y: true, metric_scale_factor: 0.87 },
        },
      },
    }
    expect(worldAssetUrls(response)).toEqual({
      spz: {
        '100k': 'https://cdn.worldlabs.ai/w/abc/100k.spz',
        '500k': 'https://cdn.worldlabs.ai/w/abc/500k.spz',
        full_res: 'https://cdn.worldlabs.ai/w/abc/full.spz',
      },
      colliderMeshUrl: 'https://cdn.worldlabs.ai/w/abc/collider.glb',
      panoUrl: 'https://cdn.worldlabs.ai/w/abc/pano.png',
      thumbnailUrl: 'https://cdn.worldlabs.ai/w/abc/thumb.webp',
      semanticsMetadata: { ground_plane_offset: 1.42, flip_y: true, metric_scale_factor: 0.87 },
    })
    expect(worldAssetUrls({})).toEqual({ spz: {} })
  })
})

// ---------------------------------------------------------------------------
describe('nano-banana-2', () => {
  it('edit input matches image-blaster defaults', () => {
    expect(buildEditInput({ prompt: 'remove the cup', imageUrls: ['https://x/a.png'] })).toEqual({
      prompt: 'remove the cup',
      image_urls: ['https://x/a.png'],
      num_images: 1,
      aspect_ratio: 'auto',
      output_format: 'png',
      safety_tolerance: '4',
      resolution: '1K',
      limit_generations: true,
    })
    expect(buildEditInput({ prompt: 'p', imageUrls: ['data:image/png;base64,AA=='], seed: 7, safetyTolerance: 2 }))
      .toMatchObject({ seed: 7, safety_tolerance: '2' })
    expect(() => buildEditInput({ prompt: '', imageUrls: ['https://x'] })).toThrow('prompt is required')
    expect(() => buildEditInput({ prompt: 'p', imageUrls: [] })).toThrow('At least one input image')
    expect(() => buildEditInput({ prompt: 'p', imageUrls: ['/local/file.png'] })).toThrow('http(s) URL or data URI')
    expect(() => buildEditInput({ prompt: 'p', imageUrls: ['https://x'], resolution: '8K' })).toThrow('resolution')
  })

  it('text-to-image input matches confirmed schema', () => {
    expect(buildTextToImageInput({ prompt: 'a luxury watch boutique, empty', aspectRatio: '16:9' })).toEqual({
      prompt: 'a luxury watch boutique, empty',
      num_images: 1,
      aspect_ratio: '16:9',
      output_format: 'png',
      safety_tolerance: '4',
      resolution: '1K',
      limit_generations: true,
    })
    expect(() => buildTextToImageInput({ prompt: 'ab' })).toThrow('at least 3')
    expect(() => buildTextToImageInput({ prompt: 'abc', numImages: 5 })).toThrow('between 1 and 4')
    expect(() => buildTextToImageInput({ prompt: 'abc', aspectRatio: '7:3' })).toThrow('aspectRatio')
    expect(() => nanoBananaImages({ images: [] })).toThrow('did not include any images')
  })
})

// ---------------------------------------------------------------------------
describe('Hunyuan 3D', () => {
  it('builds with image-blaster defaults and key order', () => {
    const input = buildHunyuanInput({ imageUrl: 'https://x/watch.png' })
    expect(input).toEqual({
      generate_type: 'Normal',
      enable_pbr: true,
      face_count: 50000,
      input_image_url: 'https://x/watch.png',
    })
    expect(Object.keys(input)).toEqual(['generate_type', 'enable_pbr', 'face_count', 'input_image_url'])
  })

  it('sends polygon_type only for LowPoly; normalizes case and booleans', () => {
    expect(buildHunyuanInput({ imageUrl: 'https://x', generateType: 'lowpoly', polygonType: 'QUADRILATERAL' }))
      .toMatchObject({ generate_type: 'LowPoly', polygon_type: 'quadrilateral' })
    expect(buildHunyuanInput({ imageUrl: 'https://x', generateType: 'geometry', polygonType: 'quadrilateral' }))
      .not.toHaveProperty('polygon_type')
    expect(buildHunyuanInput({ imageUrl: 'https://x', enablePbr: 'off' }).enable_pbr).toBe(false)
    expect(buildHunyuanInput({ imageUrl: 'https://x', faceCount: '1500000' }).face_count).toBe(1500000)
  })

  it('validates like image-blaster', () => {
    expect(() => buildHunyuanInput({ imageUrl: 'https://x', faceCount: 39999 })).toThrow('between 40000 and 1500000')
    expect(() => buildHunyuanInput({ imageUrl: 'https://x', faceCount: 1500001 })).toThrow('between 40000')
    expect(() => buildHunyuanInput({ imageUrl: 'https://x', faceCount: 50000.5 })).toThrow('integer')
    expect(() => buildHunyuanInput({ imageUrl: 'https://x', generateType: 'HighPoly' })).toThrow('generate-type')
    expect(() => buildHunyuanInput({ imageUrl: 'https://x', polygonType: 'hex' })).toThrow('polygon-type')
    expect(() => buildHunyuanInput({ imageUrl: 'https://x', enablePbr: 'maybe' })).toThrow('enable-pbr')
    expect(() => buildHunyuanInput({ imageUrl: '' })).toThrow('Input image is required')
  })

  it('extracts output files like fal-3d-provider (collectRemoteFiles)', () => {
    const data = {
      model_glb: { url: 'https://fal/m.glb', file_name: 'm.glb' },
      model_urls: { glb: { url: 'https://fal/m.glb' }, obj: { url: 'https://fal/m.obj' }, fbx: null },
      thumbnail: { url: 'https://fal/preview.png' },
      seed: 3,
    }
    const out = hunyuanOutputFiles(data)
    expect(out.glb.url).toBe('https://fal/m.glb')
    expect(out.all.map((f) => [f.label, f.file.url])).toEqual([
      ['model_glb', 'https://fal/m.glb'],
      ['obj', 'https://fal/m.obj'],
      ['thumbnail', 'https://fal/preview.png'],
    ])
    expect(() => hunyuanOutputFiles({})).toThrow('model_glb')
    expect(collectRemoteFiles({ images: [{ url: 'a' }, { url: 'b' }] }).map((f) => f.label)).toEqual([
      'images-1',
      'images-2',
    ])
  })
})

// ---------------------------------------------------------------------------
describe('ElevenLabs SFX', () => {
  it('builds with image-blaster defaults', () => {
    expect(buildSfxInput({ text: 'watch tick' })).toEqual({
      text: 'watch tick',
      loop: false,
      prompt_influence: 0.3,
      output_format: 'mp3_44100_128',
    })
    expect(buildSfxInput({ text: 'room tone', loop: true, durationSeconds: '10' })).toEqual({
      text: 'room tone',
      loop: true,
      prompt_influence: 0.3,
      output_format: 'mp3_44100_128',
      duration_seconds: 10,
    })
  })

  it('validates like image-blaster', () => {
    expect(() => buildSfxInput({ text: '' })).toThrow('prompt is required')
    expect(() => buildSfxInput({ text: 'x', durationSeconds: 0.4 })).toThrow('between 0.5 and 22')
    expect(() => buildSfxInput({ text: 'x', durationSeconds: 22.1 })).toThrow('between 0.5 and 22')
    expect(() => buildSfxInput({ text: 'x', promptInfluence: 1.5 })).toThrow('between 0 and 1')
    expect(() => buildSfxInput({ text: 'x', promptInfluence: 'abc' })).toThrow('Expected a number')
    expect(() => buildSfxInput({ text: 'x', outputFormat: 'pcm_44100' })).toThrow('only supported for mp3 and opus')
    expect(buildSfxInput({ text: 'x', outputFormat: 'pcm_44100', loop: true }).output_format).toBe('pcm_44100')
    expect(() => normalizeSfxCount(5)).toThrow('between 1 and 4')
    expect(normalizeSfxCount('2.9')).toBe(2)
    expect(() => sfxAudioFile({})).toThrow('audio.url')
  })

  it('trims silence and normalizes a locally generated tone with ffmpeg', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'caliber-sfx-'))
    try {
      const file = path.join(dir, 'tone.mp3')
      // 1s silence + 1s 440Hz tone + 1s silence
      execFileSync('/usr/local/bin/ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100',
        '-af', 'volume=0.2,adelay=1000|1000,apad=pad_dur=1',
        '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', file,
      ])
      const result = await analyzeAndPostprocessAudio(file, { extension: '.mp3' })
      expect(result.postprocessed).toBe(true)
      expect(result.before.duration_seconds!).toBeGreaterThan(2.9)
      expect(result.before.silence.leading_seconds!).toBeGreaterThan(0.9)
      expect(result.before.silence.trailing_seconds!).toBeGreaterThan(0.9)
      expect(result.after.duration_seconds!).toBeLessThan(1.3)
      expect(result.after.duration_seconds!).toBeGreaterThan(0.9)
      expect(result.after.volume.max_db!).toBeGreaterThan(result.before.volume.max_db!)

      const skipped = await analyzeAndPostprocessAudio(file, { extension: '.mp3', postprocess: false })
      expect(skipped).toMatchObject({ postprocessed: false, skipped_reason: 'Post-processing disabled' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
describe('redactForDisplay', () => {
  it('replaces base64 blobs with sizes and leaves the rest intact', () => {
    const bytes = new Uint8Array(1000)
    const dataUri = bytesToDataUri(bytes, 'image/png')
    const b64 = Buffer.from(bytes).toString('base64')
    const world = buildWorldRequest({
      displayName: 'w',
      textPrompt: 'p',
      image: { base64: b64, extension: 'png', mimeType: 'image/png' },
    })
    const redacted = redactForDisplay({ fal: buildEditInput({ prompt: 'p', imageUrls: [dataUri] }), world })
    expect(redacted.fal.image_urls).toEqual(['[base64 image/png 1000 bytes]'])
    expect(redacted.fal.prompt).toBe('p')
    expect((redacted.world.world_prompt as { image_prompt: { data_base64: string } }).image_prompt.data_base64).toBe(
      '[base64 1000 bytes]',
    )
    // original untouched
    expect((world.world_prompt as { image_prompt: { data_base64: string } }).image_prompt.data_base64).toBe(b64)
  })
})
