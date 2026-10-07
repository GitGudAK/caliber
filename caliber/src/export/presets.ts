// Output presets for MP4 export. Plain data, no runtime dependencies.
// All dimensions are even (H.264 / 4:2:0 requires even width and height).

export type ExportPresetId =
  | 'square-1080-30'
  | 'square-1080-60'
  | 'vertical-1080x1920-30'
  | 'vertical-1080x1920-60'
  | 'landscape-1920x1080-30'
  | 'landscape-1920x1080-60'

export interface ExportPreset {
  id: ExportPresetId
  label: string
  width: number
  height: number
  fps: 30 | 60
  /** Target video bitrate in bits per second. */
  bitrate: number
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'square-1080-30', label: 'Square 1080 × 1080 · 30 fps', width: 1080, height: 1080, fps: 30, bitrate: 10_000_000 },
  { id: 'square-1080-60', label: 'Square 1080 × 1080 · 60 fps', width: 1080, height: 1080, fps: 60, bitrate: 16_000_000 },
  { id: 'vertical-1080x1920-30', label: 'Vertical 1080 × 1920 · 30 fps', width: 1080, height: 1920, fps: 30, bitrate: 14_000_000 },
  { id: 'vertical-1080x1920-60', label: 'Vertical 1080 × 1920 · 60 fps', width: 1080, height: 1920, fps: 60, bitrate: 22_000_000 },
  { id: 'landscape-1920x1080-30', label: 'Landscape 1920 × 1080 · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 14_000_000 },
  { id: 'landscape-1920x1080-60', label: 'Landscape 1920 × 1080 · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 22_000_000 },
]

export const DEFAULT_EXPORT_PRESET_ID: ExportPresetId = 'landscape-1920x1080-30'

export function getExportPreset(id: ExportPresetId): ExportPreset {
  const preset = EXPORT_PRESETS.find((p) => p.id === id)
  if (!preset) throw new Error(`Unknown export preset: ${id}`)
  return preset
}
