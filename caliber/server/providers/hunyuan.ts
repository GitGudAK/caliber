// FAL Hunyuan 3D v3 image-to-3d input builder. Ported from image-blaster
// .claude/scripts/asset-pipeline/hunyuan-3d.mjs + fal-3d-provider.mjs.
//
// Same defaults and validation: face_count integer 40000–1500000 (default 50000),
// generate_type Normal|LowPoly|Geometry (case-insensitive, default Normal),
// polygon_type triangle|quadrilateral (always validated, only sent for LowPoly),
// enable_pbr boolean or true/false/1/0/yes/no/on/off strings (default true).
// Image key is `input_image_url`, merged after the other fields (fal-3d-provider.mjs).
// Poll interval 10000ms (fal-3d-provider.mjs default).
//
// Note: FAL's own defaults differ (face_count 500000, enable_pbr false per the public
// OpenAPI at https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/hunyuan3d-v3/image-to-3d),
// so these fields are always sent explicitly, exactly as image-blaster does.
// Output (same source): { model_glb: File, model_urls: {glb?, fbx?, obj?, usdz?}, thumbnail?: File, seed? }.
// image-blaster downloads every url-bearing object (collectRemoteFiles); hunyuanOutputFiles
// does the same and also exposes the GLB directly.

import { collectRemoteFiles, type FalFile } from './fal.ts'

export const HUNYUAN_3D_ENDPOINT = 'fal-ai/hunyuan3d-v3/image-to-3d'
export const HUNYUAN_POLL_MS = 10000
export const DEFAULT_HUNYUAN_FACE_COUNT = 50000
export const DEFAULT_HUNYUAN_ENABLE_PBR = true
export const DEFAULT_HUNYUAN_GENERATE_TYPE = 'Normal'
export const DEFAULT_HUNYUAN_POLYGON_TYPE = 'triangle'

const MIN_FACE_COUNT = 40000
const MAX_FACE_COUNT = 1500000
const GENERATE_TYPES = new Map([
  ['normal', 'Normal'],
  ['lowpoly', 'LowPoly'],
  ['geometry', 'Geometry'],
])
const POLYGON_TYPES = new Map([
  ['triangle', 'triangle'],
  ['quadrilateral', 'quadrilateral'],
])

function normalizeFaceCount(value: unknown): number {
  const faceCount = Number(value)
  if (!Number.isInteger(faceCount) || faceCount < MIN_FACE_COUNT || faceCount > MAX_FACE_COUNT) {
    throw new Error(`face-count must be an integer between ${MIN_FACE_COUNT} and ${MAX_FACE_COUNT}.`)
  }
  return faceCount
}

function normalizeGenerateType(value: unknown): string {
  const normalized = GENERATE_TYPES.get(String(value).trim().toLowerCase())
  if (!normalized) throw new Error('generate-type must be one of: Normal, LowPoly, Geometry.')
  return normalized
}

function normalizePolygonType(value: unknown): string {
  const normalized = POLYGON_TYPES.get(String(value).trim().toLowerCase())
  if (!normalized) throw new Error('polygon-type must be one of: triangle, quadrilateral.')
  return normalized
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  throw new Error('enable-pbr must be true or false.')
}

export interface HunyuanInput {
  generate_type: string
  enable_pbr: boolean
  face_count: number
  polygon_type?: string
  input_image_url: string
}

/** Pure: input for fal-ai/hunyuan3d-v3/image-to-3d. `imageUrl` is an http(s) URL or data URI. */
export function buildHunyuanInput(options: {
  imageUrl: string
  faceCount?: number | string
  enablePbr?: boolean | string
  generateType?: string
  polygonType?: string
}): HunyuanInput {
  const {
    imageUrl,
    faceCount = DEFAULT_HUNYUAN_FACE_COUNT,
    enablePbr = DEFAULT_HUNYUAN_ENABLE_PBR,
    generateType = DEFAULT_HUNYUAN_GENERATE_TYPE,
    polygonType = DEFAULT_HUNYUAN_POLYGON_TYPE,
  } = options
  if (!imageUrl) throw new Error('Input image is required.')
  if (!/^(https?:|data:)/i.test(imageUrl)) throw new Error('Input image must be an http(s) URL or data URI.')

  const normalizedFaceCount = normalizeFaceCount(faceCount)
  const normalizedGenerateType = normalizeGenerateType(generateType)
  const normalizedEnablePbr = normalizeBoolean(enablePbr)
  const normalizedPolygonType = normalizePolygonType(polygonType)

  const input: Omit<HunyuanInput, 'input_image_url'> = {
    generate_type: normalizedGenerateType,
    enable_pbr: normalizedEnablePbr,
    face_count: normalizedFaceCount,
  }
  if (normalizedGenerateType === 'LowPoly') input.polygon_type = normalizedPolygonType
  return { ...input, input_image_url: imageUrl }
}

export interface HunyuanOutputFiles {
  /** The GLB to load (model_glb, else model_urls.glb). Throws if neither present. */
  glb: FalFile
  /** Every url-bearing file in the result, as image-blaster downloads them. */
  all: Array<{ label: string; file: FalFile }>
}

export function hunyuanOutputFiles(data: unknown): HunyuanOutputFiles {
  const d = (data ?? {}) as { model_glb?: FalFile | null; model_urls?: { glb?: FalFile | null } }
  const glb = d.model_glb?.url ? d.model_glb : d.model_urls?.glb?.url ? d.model_urls.glb : undefined
  if (!glb) throw new Error('Hunyuan result did not include model_glb.url.')
  return { glb, all: collectRemoteFiles(data, 'hunyuan') }
}
