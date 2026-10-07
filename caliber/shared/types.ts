// Types shared by the server and the frontend. The frontend never touches the
// database or disk directly; these are the shapes the local API returns.

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

export interface JobStep {
  key: string
  label: string
  status: StepStatus
  detail?: string
  startedAt?: string
  finishedAt?: string
}

export interface Job {
  id: string
  kind: string
  projectId: string | null
  status: JobStatus
  progress: number
  steps: JobStep[]
  input: unknown
  result: unknown
  error: string | null
  createdAt: string
  updatedAt: string
}

export type AssetKind =
  | 'watch-model'
  | 'location-photo'
  | 'scene-image'
  | 'world-spz'
  | 'world-collider'
  | 'world-pano'
  | 'world-thumbnail'
  | 'world-json'
  | 'audio'
  | 'export'

export interface Asset {
  id: string
  projectId: string | null
  kind: AssetKind
  key: string
  url: string
  filename: string
  mime: string
  bytes: number
  meta: Record<string, unknown>
  createdAt: string
}

export type Vec3 = [number, number, number]

/** Where the watch and camera sit in a world. Meters, three.js Y-up. */
export interface Placement {
  /** Uniform scale applied to the splat world (and its collider/pano frame). */
  worldScale: number
  /** Translation applied to the world after scaling (e.g. to bring the desk to y = 0). */
  worldOffset: Vec3
  worldRotationY: number
  /**
   * Levelling tilt (radians) applied to the world so its surface is horizontal. Optional; absent = 0.
   * Order: flipY, then scale, then rotate X, Z, Y (worldRotationY last), then translate worldOffset.
   */
  worldRotationX?: number
  worldRotationZ?: number
  /** World Labs flip_y; true for Marble output. */
  flipY: boolean
  watch: {
    position: Vec3
    /** Euler XYZ, radians. */
    rotation: Vec3
    /** Largest dimension of the watch model, meters. */
    size: number
  }
  camera: { position: Vec3; target: Vec3; fov: number }
}

export interface CameraKey {
  /** Seconds from the start of the shot. */
  t: number
  position: Vec3
  target: Vec3
  fov: number
  /** Focus distance from the camera in meters (depth of field). Omit = focus on target. */
  focusDistance?: number
}

export type CameraMove = 'push-in' | 'pull-out' | 'orbit-arc' | 'slide' | 'crane' | 'focus-pull' | 'custom'
export type Easing = 'linear' | 'ease-in-out' | 'ease-out'

export interface CameraShot {
  /** The framing the user chose; every preset move is computed relative to it. */
  hero: Omit<CameraKey, 't'>
  /** 'custom' once the user edits keys by hand. */
  move: CameraMove
  /** Move strength, e.g. push-in distance fraction or orbit degrees; meaning depends on move. */
  amount: number
  /** Orbit/slide/crane direction: 1 or -1. */
  direction: 1 | -1
  durationSeconds: number
  easing: Easing
  /** Generated from hero + move, or hand-edited (sorted by t, first t = 0, last t = durationSeconds). */
  keys: CameraKey[]
  /** Depth of field for this shot. Absent = the viewer's defaults (on, 1.1° aperture). */
  dof?: ShotDof
}

export interface ShotDof {
  enabled: boolean
  /** Lens aperture angle in degrees (0.1–5.7); larger = shallower focus. */
  apertureDegrees: number
}

/** Look settings saved with the project (harmonization controls). */
export interface SceneLook {
  shadows: boolean
  /** 0–1 */
  shadowOpacity: number
  contact: boolean
  /** Film grain amount, 0–0.1 */
  grain: number
}

/** The project's soundtrack: one library audio asset, looped/trimmed to the shot length on export. */
export interface AudioTrack {
  /** Library asset of kind 'audio'. */
  assetId: string
  /** 0–1 */
  volume: number
  /** Where in the audio file playback starts, seconds (>= 0). */
  offsetSeconds: number
  /** Fades applied at the start/end of the shot, seconds (0–5). */
  fadeInSeconds: number
  fadeOutSeconds: number
  /** Repeat the audio to fill the shot when it is shorter than the shot. */
  loop: boolean
}

/** Inputs for one ElevenLabs sound-effects generation (FAL fal-ai/elevenlabs/sound-effects/v2). */
export interface SfxRequestInput {
  prompt: string
  /** 0.5–22 seconds (provider limit). Omit to let the provider choose. */
  durationSeconds?: number
  /** Seamless loop (ambience). Loops are not post-processed, to keep the seam clean. */
  loop: boolean
  /** 0–1, default 0.3 */
  promptInfluence?: number
}

export interface SfxPreview {
  endpoint: string
  /** The exact request body that will be sent. */
  request: unknown
  /** Fingerprint the user approves; POST must echo it back. */
  hash: string
  ledgerStatus: 'new' | 'completed' | 'submitted' | 'failed'
  /** When already generated, the library assets it produced. */
  existingAssets: Asset[]
  /** FAL request id for an existing ledger row (lets the user check a 'submitted' one that was interrupted). */
  providerRef?: string | null
  ledgerUpdatedAt?: string | null
  ledgerError?: string | null
  /** Plain-language explanation of the ledger status, e.g. why a 'submitted' row blocks resending. */
  ledgerNote?: string | null
}

export interface ProjectScene {
  presetId: string | null
  placement: Placement | null
  /** Absent on scenes saved before audio existed; treat as null. */
  audio?: AudioTrack | null
  /** Absent = viewer defaults. */
  look?: SceneLook | null
  /** Absent on scenes saved before shots existed; treat as null. */
  shot?: CameraShot | null
}

export interface Project {
  id: string
  name: string
  watchAssetId: string | null
  watchAsset: Asset | null
  scene: ProjectScene
  createdAt: string
  updatedAt: string
}

/** A finished, paid-for world kept in the library so it is never regenerated. */
export interface WorldPreset {
  id: string
  name: string
  templateId: string | null
  /** Resolved asset records; spz keys as World Labs returned them ("100k", "500k", "full_res", ...). */
  files: {
    sceneImage: Asset | null
    spz: Record<string, Asset>
    collider: Asset | null
    pano: Asset | null
    thumbnail: Asset | null
    worldJson: Asset | null
  }
  /** World Labs semantics_metadata as returned. */
  semantics: Record<string, unknown>
  /** Starting placement for new projects using this preset. */
  defaultPlacement: Placement
  prompts: { sceneImage?: string; world?: string }
  /** Provider ids for traceability (FAL request id, World Labs operation id). */
  provenance: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/**
 * Every paid provider request, keyed by a SHA-256 of its canonical body (including
 * any base64 image bytes). A completed record means the outputs already exist and the
 * request must not be sent again.
 */
export interface ProviderRequestRecord {
  hash: string
  provider: 'fal' | 'worldlabs'
  endpoint: string
  /** Body with base64 redacted, for display. */
  request: unknown
  status: 'submitted' | 'completed' | 'failed'
  providerRef: string | null
  response: unknown
  /** What the outputs became: asset ids and/or a preset id. */
  outputs: { assetIds?: string[]; presetId?: string }
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface Health {
  ok: true
  keys: { worldlabs: boolean; fal: boolean }
  sampleWatchAvailable: boolean
}

export type JobEvent = { type: 'job'; job: Job }
