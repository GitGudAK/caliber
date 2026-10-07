// FAL nano-banana-2 input builders.
//
// EDIT (`fal-ai/nano-banana-2/edit`): ported from image-blaster
// .claude/scripts/asset-pipeline/nano-banana-edit.mjs. Same defaults and key order:
// prompt, image_urls, num_images=1, aspect_ratio="auto", output_format="png",
// safety_tolerance="4", resolution="1K", limit_generations=true, seed (optional).
//
// TEXT-TO-IMAGE (`fal-ai/nano-banana-2`): not in image-blaster. Schema confirmed on
// 2026-10-06 from FAL's public OpenAPI document:
//   https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana-2
//   (human page: https://fal.ai/models/fal-ai/nano-banana-2/api)
// Schema title "NanoBanana2TextToImageInput", required: [prompt]. Properties:
//   prompt            string, minLength 3, maxLength 50000
//   num_images        integer 1–4, default 1
//   seed              integer | null
//   aspect_ratio      "auto"|"21:9"|"16:9"|"3:2"|"4:3"|"5:4"|"1:1"|"4:5"|"3:4"|"2:3"|"9:16"|"4:1"|"1:4"|"8:1"|"1:8" | null, default "auto"
//   output_format     "jpeg"|"png"|"webp", default "png"
//   safety_tolerance  "1".."6" (string), default "4"
//   sync_mode         boolean, default false
//   system_prompt     string ≤50000, default ""
//   resolution        "0.5K"|"1K"|"2K"|"4K", default "1K"
//   limit_generations boolean, default true
//   enable_web_search boolean, default false
//   thinking_level    "minimal"|"high" | null
// Output "NanoBanana2TextToImageOutput": { images: ImageFile[] ({url, content_type, file_name, ...}), description: string }.
// The edit endpoint's schema (same source, endpoint_id=fal-ai/nano-banana-2/edit) has the
// same enums/defaults plus image_urls (array) and optional audio_url/pdf_url/video_url.
//
// Deviation: image-blaster sends values unvalidated; here enum/range values are checked
// against the schema above so a bad payload fails locally before any money is spent.
// sync_mode / system_prompt / enable_web_search / thinking_level are not sent (FAL
// defaults apply), matching what image-blaster sends for edit.

import type { FalFile } from './fal.ts'

export const NANO_BANANA_EDIT_ENDPOINT = 'fal-ai/nano-banana-2/edit'
export const NANO_BANANA_T2I_ENDPOINT = 'fal-ai/nano-banana-2'

export const NANO_BANANA_RESOLUTIONS = ['0.5K', '1K', '2K', '4K'] as const
export const NANO_BANANA_ASPECT_RATIOS = [
  'auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4', '8:1', '1:8',
] as const
export const NANO_BANANA_OUTPUT_FORMATS = ['jpeg', 'png', 'webp'] as const
export const NANO_BANANA_SAFETY = ['1', '2', '3', '4', '5', '6'] as const

export type NanoBananaResolution = (typeof NANO_BANANA_RESOLUTIONS)[number]
export type NanoBananaAspectRatio = (typeof NANO_BANANA_ASPECT_RATIOS)[number]
export type NanoBananaOutputFormat = (typeof NANO_BANANA_OUTPUT_FORMATS)[number]

export interface NanoBananaCommonOptions {
  prompt: string
  numImages?: number
  resolution?: string
  aspectRatio?: string
  outputFormat?: string
  safetyTolerance?: string | number
  limitGenerations?: boolean
  seed?: number
}

interface CommonFields {
  num_images: number
  aspect_ratio: string
  output_format: string
  safety_tolerance: string
  resolution: string
  limit_generations: boolean
}

function oneOf(name: string, value: string, allowed: readonly string[]): string {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}.`)
  return value
}

function normalizeCommon(o: NanoBananaCommonOptions): CommonFields {
  const numImages = Number(o.numImages ?? 1)
  if (!Number.isInteger(numImages) || numImages < 1 || numImages > 4) {
    throw new Error('numImages must be an integer between 1 and 4.')
  }
  return {
    num_images: numImages,
    aspect_ratio: oneOf('aspectRatio', o.aspectRatio ?? 'auto', NANO_BANANA_ASPECT_RATIOS),
    output_format: oneOf('outputFormat', o.outputFormat ?? 'png', NANO_BANANA_OUTPUT_FORMATS),
    safety_tolerance: oneOf('safetyTolerance', String(o.safetyTolerance ?? '4'), NANO_BANANA_SAFETY),
    resolution: oneOf('resolution', o.resolution ?? '1K', NANO_BANANA_RESOLUTIONS),
    limit_generations: Boolean(o.limitGenerations ?? true),
  }
}

function normalizeSeed(seed: number | undefined): number | undefined {
  if (seed === undefined) return undefined
  const n = Number(seed)
  if (!Number.isInteger(n)) throw new Error('seed must be an integer.')
  return n
}

export interface NanoBananaEditInput extends CommonFields {
  prompt: string
  image_urls: string[]
  seed?: number
}

/**
 * Pure: input for fal-ai/nano-banana-2/edit. `imageUrls` must already be http(s)
 * URLs or data URIs (use bytesToDataUri from fal.ts for local files).
 */
export function buildEditInput(options: NanoBananaCommonOptions & { imageUrls: string[] }): NanoBananaEditInput {
  if (!options.prompt) throw new Error('Nano Banana prompt is required.')
  if (!options.imageUrls?.length) throw new Error('At least one input image is required.')
  for (const url of options.imageUrls) {
    if (!/^(https?:|data:)/i.test(url)) throw new Error(`Image input must be an http(s) URL or data URI.`)
  }
  const c = normalizeCommon(options)
  const input: NanoBananaEditInput = {
    prompt: options.prompt,
    image_urls: [...options.imageUrls],
    num_images: c.num_images,
    aspect_ratio: c.aspect_ratio,
    output_format: c.output_format,
    safety_tolerance: c.safety_tolerance,
    resolution: c.resolution,
    limit_generations: c.limit_generations,
  }
  const seed = normalizeSeed(options.seed)
  if (seed !== undefined) input.seed = seed
  return input
}

export interface NanoBananaTextToImageInput extends CommonFields {
  prompt: string
  seed?: number
}

/** Pure: input for fal-ai/nano-banana-2 (text → scene image). Same defaults as edit. */
export function buildTextToImageInput(options: NanoBananaCommonOptions): NanoBananaTextToImageInput {
  const prompt = options.prompt ?? ''
  if (prompt.trim().length < 3) throw new Error('Nano Banana prompt must be at least 3 characters.')
  if (prompt.length > 50000) throw new Error('Nano Banana prompt must be at most 50000 characters.')
  const c = normalizeCommon(options)
  const input: NanoBananaTextToImageInput = {
    prompt,
    num_images: c.num_images,
    aspect_ratio: c.aspect_ratio,
    output_format: c.output_format,
    safety_tolerance: c.safety_tolerance,
    resolution: c.resolution,
    limit_generations: c.limit_generations,
  }
  const seed = normalizeSeed(options.seed)
  if (seed !== undefined) input.seed = seed
  return input
}

/** Images returned by either nano-banana-2 endpoint (`images[]`). Throws if none. */
export function nanoBananaImages(data: unknown): FalFile[] {
  const images = (data as { images?: unknown })?.images
  const files = Array.isArray(images) ? images.filter((i): i is FalFile => typeof i?.url === 'string') : []
  if (!files.length) throw new Error('Nano Banana result did not include any images[].url.')
  return files
}
