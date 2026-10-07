import { normalize, panoToWorld, pixelToDirection, type Vec3 } from './panoMath'

/** Anything with RGBA bytes: ImageData, or a plain object in tests. */
export interface PixelSource {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

export interface LightEstimateOptions {
  /**
   * Environment rotation about Y (radians) — the same value given to scene.environmentRotation.y.
   * For World Labs worlds use panoRotationY(placement). Default 0 (raw pano frame).
   */
  rotationY?: number
  /** Fraction of the (solid-angle weighted) sphere treated as "the light". Default 0.01 (top 1%). */
  brightFraction?: number
  /** Ignore pixels below this elevation (degrees) when finding the light. Default -5 (excludes desk glare). */
  minElevationDeg?: number
  /** Width the image is resampled to before analysis (browser path only). Default 512. */
  analysisWidth?: number
  /** Multiplier on the derived key intensity. Default 1. */
  keyScale?: number
}

export interface LightEstimate {
  /** World-space unit vector pointing FROM the scene TOWARD the light. */
  direction: Vec3
  /** Same, in the raw pano frame (three equirect convention, before rotationY). */
  panoDirection: Vec3
  /** Elevation of the light above the horizon, degrees. */
  elevationDeg: number
  /** Linear RGB, max component 1. */
  color: Vec3
  /** Directional-light intensity (three physically-based units), heuristic. */
  intensity: number
  /** Linear RGB, max component 1: average of the whole sphere. */
  ambientColor: Vec3
  /** Hemisphere/ambient fill intensity, heuristic. */
  ambientIntensity: number
  /** Linear RGB, max component 1: average of the lower hemisphere (the surface the watch sits on). */
  groundColor: Vec3
  /** Average linear color normalized to luminance 1 (white = [1,1,1]). */
  whiteBalance: Vec3
  /** Mean linear luminance of the bright region / of the whole sphere (contrast of the light). */
  contrast: number
  /** Image pixel (in the analysed resolution) of the light centroid, for debugging. */
  pixel: [number, number]
  analysedSize: [number, number]
}

const srgbToLinearLut = (() => {
  const lut = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const c = i / 255
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return lut
})()

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const maxNorm = (v: Vec3): Vec3 => {
  const m = Math.max(v[0], v[1], v[2]) || 1
  return [v[0] / m, v[1] / m, v[2] / m]
}

/**
 * Finds the dominant light in an equirectangular LDR pano (sRGB bytes).
 * The light is the solid-angle-weighted top `brightFraction` of upper-hemisphere pixels by
 * luminance; its luminance-weighted centroid direction is the key direction.
 */
export function estimateLightFromPixels(img: PixelSource, opts: LightEstimateOptions = {}): LightEstimate {
  const { width: W, height: H, data } = img
  if (!(W > 1 && H > 1) || data.length < W * H * 4) throw new Error('estimateLight: invalid image data')
  const rotationY = opts.rotationY ?? 0
  const brightFraction = opts.brightFraction ?? 0.01
  const minElev = ((opts.minElevationDeg ?? -5) * Math.PI) / 180
  const keyScale = opts.keyScale ?? 1

  const L = new Float32Array(W * H)
  const rowWeight = new Float32Array(H)
  let sumW = 0
  const avg: Vec3 = [0, 0, 0]
  const ground: Vec3 = [0, 0, 0]
  let groundW = 0
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * Math.PI
    const w = Math.cos(lat)
    rowWeight[y] = w
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const r = srgbToLinearLut[data[i]]
      const g = srgbToLinearLut[data[i + 1]]
      const b = srgbToLinearLut[data[i + 2]]
      L[y * W + x] = lum(r, g, b)
      avg[0] += r * w
      avg[1] += g * w
      avg[2] += b * w
      sumW += w
      if (lat < -0.15) {
        ground[0] += r * w
        ground[1] += g * w
        ground[2] += b * w
        groundW += w
      }
    }
  }
  const meanRgb: Vec3 = [avg[0] / sumW, avg[1] / sumW, avg[2] / sumW]
  const meanLum = lum(...meanRgb)

  // Luminance threshold for the top `brightFraction` of solid angle (upper region only).
  const candidates: { l: number; w: number }[] = []
  let candW = 0
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * Math.PI
    if (lat < minElev) continue
    const w = rowWeight[y]
    for (let x = 0; x < W; x++) {
      candidates.push({ l: L[y * W + x], w })
      candW += w
    }
  }
  candidates.sort((a, b) => b.l - a.l)
  const target = brightFraction * sumW
  let acc = 0
  let threshold = candidates[0]?.l ?? 1
  for (const c of candidates) {
    acc += c.w
    threshold = c.l
    if (acc >= target || acc >= candW) break
  }

  // A flat plateau at the threshold would otherwise swallow the whole sky: use strictly-brighter
  // pixels when there are any.
  const strict = candidates.some((c) => c.l > threshold)
  // Weighted centroid: weight = solid angle * luminance, summed as 3D vectors.
  const dirSum: Vec3 = [0, 0, 0]
  const colSum: Vec3 = [0, 0, 0]
  let brightW = 0
  let brightLum = 0
  let px = 0
  let py = 0
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * Math.PI
    if (lat < minElev) continue
    for (let x = 0; x < W; x++) {
      const l = L[y * W + x]
      if (strict ? l <= threshold : l < threshold) continue
      const w = rowWeight[y] * l
      const d = pixelToDirection(x, y, W, H)
      dirSum[0] += d[0] * w
      dirSum[1] += d[1] * w
      dirSum[2] += d[2] * w
      const i = (y * W + x) * 4
      colSum[0] += srgbToLinearLut[data[i]] * w
      colSum[1] += srgbToLinearLut[data[i + 1]] * w
      colSum[2] += srgbToLinearLut[data[i + 2]] * w
      brightW += w
      brightLum += l * w
      px += x * w
      py += y * w
    }
  }
  if (!(brightW > 0)) throw new Error('estimateLight: no bright region found')
  const panoDirection = normalize(dirSum)
  const direction = normalize(panoToWorld(panoDirection, rotationY))
  const brightMean = brightLum / brightW
  const contrast = brightMean / Math.max(1e-4, meanLum)

  // Heuristics (tuned on the desk preset; LDR panos clip the sun, so contrast saturates ~3–10):
  // a clear dominant light gets a strong key, a flat overcast pano gets a weak one.
  const intensity = keyScale * Math.min(6, Math.max(0.5, 0.6 * contrast))
  const ambientIntensity = Math.min(1.5, Math.max(0.1, 2 * meanLum))
  const wbLum = lum(...meanRgb) || 1

  return {
    direction,
    panoDirection,
    elevationDeg: (Math.asin(panoDirection[1]) * 180) / Math.PI,
    color: maxNorm([colSum[0] / brightW, colSum[1] / brightW, colSum[2] / brightW]),
    intensity,
    ambientColor: maxNorm(meanRgb),
    ambientIntensity,
    groundColor: groundW > 0 ? maxNorm([ground[0] / groundW, ground[1] / groundW, ground[2] / groundW]) : maxNorm(meanRgb),
    whiteBalance: [meanRgb[0] / wbLum, meanRgb[1] / wbLum, meanRgb[2] / wbLum],
    contrast,
    pixel: [px / brightW, py / brightW],
    analysedSize: [W, H],
  }
}

/** Downsamples an image to `width` x width/2 through a canvas and returns its pixels (browser only). */
export function imageToPixels(image: HTMLImageElement | ImageBitmap, width = 512): ImageData {
  const w = Math.max(16, Math.round(width))
  const h = Math.max(8, Math.round(w / 2))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('estimateLight: 2D canvas unavailable')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

/** Estimate from ImageData (used as-is) or an image element (resampled to opts.analysisWidth). */
export function estimateLightFromPano(
  image: PixelSource | HTMLImageElement | ImageBitmap,
  opts: LightEstimateOptions = {},
): LightEstimate {
  const px = 'data' in image ? image : imageToPixels(image, opts.analysisWidth)
  return estimateLightFromPixels(px, opts)
}

/** Loads an image URL and estimates its light (browser only). */
export async function estimateLightFromUrl(url: string, opts: LightEstimateOptions = {}): Promise<LightEstimate> {
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  try {
    await img.decode()
  } catch {
    throw new Error(`Light estimate: could not load pano (${url})`)
  }
  return estimateLightFromPano(img, opts)
}
