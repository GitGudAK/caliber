// Theme definitions for paid preset worlds, and the single source of truth for their
// request bodies. A theme is a macro tabletop still (FAL nano-banana-2 text-to-image)
// fed to World Labs Marble as an image prompt, then scaled down to watch size.
//
// The bodies built here are hashed by the paid-request ledger. Changing a theme's
// prompt or options changes its hash, i.e. a NEW paid request. The 'morning-desk'
// theme must stay byte-identical to what was paid for (hashes 3534e24a… / 79dd757e…).
import type { Placement } from '../../shared/types.ts'
import { redactForDisplay } from '../providers/http.ts'
import { buildTextToImageInput, NANO_BANANA_T2I_ENDPOINT, type NanoBananaCommonOptions } from '../providers/nanoBanana.ts'
import { buildWorldRequest } from '../providers/worldlabs.ts'

/** Ledger endpoint name for World Labs world generation. */
export const WORLDS_GENERATE_ENDPOINT = 'worlds:generate'

export interface Theme {
  id: string
  /** Preset name shown in the library. */
  name: string
  templateId: string
  /** World Labs display_name (part of the paid body). */
  displayName: string
  sceneImagePrompt: string
  worldTextPrompt: string
  /** nano-banana-2 options other than the prompt (part of the paid body). */
  nanoBanana: Omit<NanoBananaCommonOptions, 'prompt'>
  /** Starting placement written to the preset on import. */
  defaultPlacement: Placement
  /**
   * When true, import replaces defaultPlacement.worldOffset[1] with the height computed
   * from the collider so the surface lands at y ≈ 0. The desk keeps its hand-tuned value.
   */
  calibrateHeightFromCollider: boolean
}

const MACRO_OPTIONS = { aspectRatio: '16:9', resolution: '2K', outputFormat: 'png', numImages: 1 } as const

export const MORNING_DESK: Theme = {
  id: 'macro-desk',
  name: 'Morning Desk — macro oak',
  templateId: 'morning-desk',
  displayName: 'caliber-macro-desk-spike',
  sceneImagePrompt:
    'Photorealistic macro photograph of an empty light oak desk surface in early morning. The camera sits 3 cm above the desk, ' +
    'looking across it: fine wood grain and subtle pores fill the lower half of the frame, receding toward a window. ' +
    'Low warm sunlight from the left rakes across the surface, with long soft shadows and glowing highlights on the grain. ' +
    'Background: sheer linen curtains glowing with sun, a cream plaster wall, the soft shape of a green plant. ' +
    'Deep focus, everything sharp from foreground to background (f/16). The desk surface is completely empty. ' +
    'No people, no hands, no watches or jewelry, no objects on the desk, no readable text, no logos.',
  worldTextPrompt:
    'Macro view across an empty light oak desk surface at tabletop scale, fine wood grain in the foreground, warm low morning sun from the left, sheer curtains and a cream wall in the background.',
  nanoBanana: MACRO_OPTIONS,
  // Hand-tuned by the lead in the viewer.
  defaultPlacement: {
    worldScale: 0.06,
    worldOffset: [0, 0.0294, 0],
    worldRotationY: 0,
    flipY: true,
    watch: { position: [0, 0.0265, -0.05], rotation: [0, 3.14159265, 0], size: 0.065 },
    camera: { position: [0.04, 0.0994, 0.04], target: [0, 0.0265, -0.05], fov: 35 },
  },
  calibrateHeightFromCollider: false,
}

export const WATCHMAKERS_BENCH: Theme = {
  id: 'watchmakers-bench',
  name: "Watchmaker's Bench — macro",
  templateId: 'watchmakers-bench',
  displayName: 'caliber-watchmakers-bench',
  sceneImagePrompt:
    "Photorealistic macro photograph across an empty watchmaker's workbench in warm late-afternoon light. The camera sits 3 cm above a soft green leather bench mat that fills the lower half of the frame, its fine pebbled texture sharp in the foreground. The scene is built in clear layers of depth: the empty mat in front; further back on the bench a brass loupe, fine steel tweezers, a small open parts tray with tiny brass gears and screws, and a blower bulb, neatly arranged; behind them a warm wooden workshop wall with a tool rack and a window glowing with soft golden light. A brass desk lamp on the right casts a warm pool of light across the mat. Deep focus, everything sharp from foreground to background (f/16). The foreground mat is completely empty. No people, no hands, no complete watches, no watch faces or dials, no clocks, no readable text, no logos.",
  worldTextPrompt:
    "Macro view across an empty green leather watchmaker's bench mat at tabletop scale, brass loupe, tweezers and a tray of tiny gears further back, warm wooden workshop wall and a glowing window behind, warm lamp light from the right.",
  nanoBanana: MACRO_OPTIONS,
  // Same as the desk; worldOffset[1] is calibrated from the collider on import,
  // camera/watch get tuned later in the viewer.
  defaultPlacement: {
    worldScale: 0.06,
    worldOffset: [0, 0, 0],
    worldRotationY: 0,
    flipY: true,
    watch: { position: [0, 0.0265, -0.05], rotation: [0, 3.14159265, 0], size: 0.065 },
    camera: { position: [0.04, 0.07, 0.04], target: [0, 0.0265, -0.05], fov: 35 },
  },
  calibrateHeightFromCollider: true,
}

// One continuous surface, no props: the bench's small objects became floaters and
// collider holes, so this theme uses graphic light instead of objects.
export const TRAVERTINE_BLINDS: Theme = {
  id: 'travertine-blinds',
  name: 'Travertine & Blinds — macro',
  templateId: 'travertine-blinds',
  displayName: 'caliber-travertine-blinds',
  sceneImagePrompt:
    'Photorealistic macro photograph across an empty slab of warm honed travertine stone in bright late-morning sun. The camera sits 3 cm above the stone, looking across it: the fine natural pores and soft veining of the travertine fill the lower two-thirds of the frame, sharp in the foreground. Crisp parallel stripes of sunlight and shadow from venetian blinds fall diagonally across the stone surface. Behind the slab, a plain smooth warm-white plaster wall, softly lit, with the same blind-stripe pattern continuing across it. Nothing else in the scene: no objects, no plants, no furniture, no props on or near the stone. Clean, minimal, architectural. Deep focus, everything sharp from foreground to background (f/16). No people, no hands, no watches or jewelry, no readable text, no logos.',
  worldTextPrompt:
    'Macro view across an empty slab of warm honed travertine stone at tabletop scale, diagonal stripes of sunlight and shadow from venetian blinds across the stone, plain warm-white plaster wall behind, no objects.',
  nanoBanana: MACRO_OPTIONS,
  defaultPlacement: structuredClone(WATCHMAKERS_BENCH.defaultPlacement),
  calibrateHeightFromCollider: true,
}

export const THEMES: Record<string, Theme> = {
  [MORNING_DESK.id]: MORNING_DESK,
  [WATCHMAKERS_BENCH.id]: WATCHMAKERS_BENCH,
  [TRAVERTINE_BLINDS.id]: TRAVERTINE_BLINDS,
}

export function getTheme(id: string | undefined): Theme {
  const theme = id ? THEMES[id] : undefined
  if (!theme) throw new Error(`Unknown theme "${id ?? ''}". Known: ${Object.keys(THEMES).join(', ')}`)
  return theme
}

/** Exact FAL text-to-image request for a theme's scene still. */
export function themeImageRequest(theme: Theme) {
  const body = buildTextToImageInput({ prompt: theme.sceneImagePrompt, ...theme.nanoBanana })
  return { provider: 'fal' as const, endpoint: NANO_BANANA_T2I_ENDPOINT, body, displayBody: body }
}

/** Exact World Labs request. `extension` as path.extname gives it (".png"); bytes are the scene still. */
export function themeWorldRequest(theme: Theme, imageBytes: Uint8Array, extension: string) {
  const body = buildWorldRequest({
    displayName: theme.displayName,
    textPrompt: theme.worldTextPrompt,
    image: { base64: Buffer.from(imageBytes).toString('base64'), extension, mimeType: 'image/png' },
  })
  return { provider: 'worldlabs' as const, endpoint: WORLDS_GENERATE_ENDPOINT, body, displayBody: redactForDisplay(body) }
}
