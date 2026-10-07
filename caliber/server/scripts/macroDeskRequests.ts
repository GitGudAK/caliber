// The exact bodies of the two paid macro-desk spike calls. Shared by macro-spike.ts
// (which sends them through runPaidRequest) and import-preset.ts (which records them
// as completed). Both hash the same body, so the ledger entry always matches.
//
// The definitions now live in themes.ts (theme 'macro-desk'); this module keeps the
// original names so existing scripts and their request hashes are unchanged.
import { MORNING_DESK, themeImageRequest, themeWorldRequest, WORLDS_GENERATE_ENDPOINT } from './themes.ts'

export const MACRO_PROMPT = MORNING_DESK.sceneImagePrompt
export const WORLD_TEXT = MORNING_DESK.worldTextPrompt
export const WORLD_DISPLAY_NAME = MORNING_DESK.displayName
export { WORLDS_GENERATE_ENDPOINT }

export function macroImageRequest() {
  return themeImageRequest(MORNING_DESK)
}

/** `extension` as path.extname gives it (".png"); bytes are the scene still. */
export function macroWorldRequest(imageBytes: Uint8Array, extension: string) {
  return themeWorldRequest(MORNING_DESK, imageBytes, extension)
}
