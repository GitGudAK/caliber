// Pure state machine for "generate a sound" (paid). The money rule: the user sees the exact
// request + hash, then approves THAT request. Any edit after review throws the review away.
import type { Asset, SfxPreview, SfxRequestInput, WorldPreset } from '../../shared/types'
import { templateById } from '../../shared/templates'

export interface SfxForm {
  prompt: string
  durationSeconds: number
  loop: boolean
  promptInfluence: number
}

export type SfxPhase =
  | { kind: 'editing' }
  | { kind: 'previewing'; input: SfxRequestInput }
  | { kind: 'reviewed'; input: SfxRequestInput; preview: SfxPreview }
  | { kind: 'submitting'; input: SfxRequestInput; preview: SfxPreview }
  | { kind: 'running'; input: SfxRequestInput; preview: SfxPreview; jobId: string }
  | { kind: 'done'; assets: Asset[]; cached: boolean }
  | { kind: 'error'; message: string; stage: 'preview' | 'generate' }

export interface SfxState {
  form: SfxForm
  /** The user typed in the prompt; stop re-seeding it from the active world. */
  promptTouched: boolean
  phase: SfxPhase
}

export type SfxAction =
  | { type: 'seedPrompt'; prompt: string }
  | { type: 'edit'; patch: Partial<SfxForm> }
  | { type: 'previewStart'; input: SfxRequestInput }
  | { type: 'previewOk'; input: SfxRequestInput; preview: SfxPreview }
  | { type: 'previewFailed'; input: SfxRequestInput; message: string }
  | { type: 'approve' }
  | { type: 'jobStarted'; jobId: string }
  | { type: 'finished'; assets: Asset[]; cached: boolean }
  | { type: 'failed'; message: string }
  | { type: 'reset' }

export const DEFAULT_SFX_FORM: SfxForm = { prompt: '', durationSeconds: 10, loop: true, promptInfluence: 0.3 }

export function initialSfxState(prompt = ''): SfxState {
  return { form: { ...DEFAULT_SFX_FORM, prompt }, promptTouched: false, phase: { kind: 'editing' } }
}

/** The exact SfxRequestInput for a form. */
export function toRequestInput(form: SfxForm): SfxRequestInput {
  return {
    prompt: form.prompt,
    durationSeconds: form.durationSeconds,
    loop: form.loop,
    promptInfluence: form.promptInfluence,
  }
}

/** Client-side check before asking for a preview; null when valid. The server validates again. */
export function formProblem(form: SfxForm): string | null {
  if (!form.prompt.trim()) return 'Write a prompt first.'
  if (!Number.isFinite(form.durationSeconds) || form.durationSeconds < 0.5 || form.durationSeconds > 22) {
    return 'Duration must be between 0.5 and 22 seconds.'
  }
  if (!Number.isFinite(form.promptInfluence) || form.promptInfluence < 0 || form.promptInfluence > 1) {
    return 'Prompt influence must be between 0 and 1.'
  }
  return null
}

const sameInput = (a: SfxRequestInput, b: SfxRequestInput) => JSON.stringify(a) === JSON.stringify(b)

export const isSfxBusy = (p: SfxPhase) => p.kind === 'previewing' || p.kind === 'submitting' || p.kind === 'running'

/** The approved request, only while it still matches the form exactly. */
export function approvable(state: SfxState): { input: SfxRequestInput; hash: string } | null {
  const p = state.phase
  if (p.kind !== 'reviewed') return null
  if (!sameInput(p.input, toRequestInput(state.form))) return null
  return { input: p.input, hash: p.preview.hash }
}

export function sfxReducer(state: SfxState, action: SfxAction): SfxState {
  const p = state.phase
  switch (action.type) {
    case 'seedPrompt':
      if (state.promptTouched || isSfxBusy(p) || p.kind === 'reviewed') return state
      if (state.form.prompt === action.prompt) return state
      return { ...state, form: { ...state.form, prompt: action.prompt } }
    case 'edit': {
      // The form is locked while a request is in flight.
      if (isSfxBusy(p)) return state
      const form = { ...state.form, ...action.patch }
      const promptTouched = state.promptTouched || action.patch.prompt !== undefined
      // Any edit invalidates a review (and clears a finished/failed result).
      return { form, promptTouched, phase: { kind: 'editing' } }
    }
    case 'previewStart':
      if (isSfxBusy(p)) return state
      return { ...state, phase: { kind: 'previewing', input: action.input } }
    case 'previewOk':
      if (p.kind !== 'previewing' || !sameInput(p.input, action.input)) return state
      if (!sameInput(action.input, toRequestInput(state.form))) return { ...state, phase: { kind: 'editing' } }
      return { ...state, phase: { kind: 'reviewed', input: action.input, preview: action.preview } }
    case 'previewFailed':
      if (p.kind !== 'previewing' || !sameInput(p.input, action.input)) return state
      return { ...state, phase: { kind: 'error', message: action.message, stage: 'preview' } }
    case 'approve': {
      if (!approvable(state) || p.kind !== 'reviewed') return state
      return { ...state, phase: { kind: 'submitting', input: p.input, preview: p.preview } }
    }
    case 'jobStarted':
      if (p.kind !== 'submitting') return state
      return { ...state, phase: { kind: 'running', input: p.input, preview: p.preview, jobId: action.jobId } }
    case 'finished':
      if (p.kind !== 'submitting' && p.kind !== 'running') return state
      return { ...state, phase: { kind: 'done', assets: action.assets, cached: action.cached } }
    case 'failed':
      if (p.kind !== 'submitting' && p.kind !== 'running') return state
      return { ...state, phase: { kind: 'error', message: action.message, stage: 'generate' } }
    case 'reset':
      if (isSfxBusy(p)) return state
      return { ...state, phase: { kind: 'editing' } }
  }
}

const GENERIC_AMBIENCE = 'ambient environment, loop of quiet indoor room tone, no music, no voices'

/** First sentence of a world prompt, lowercased start, no trailing period, <= maxLen at a word boundary. */
export function shortAmbientDescription(worldPrompt: string, maxLen = 110): string {
  let s = worldPrompt.replace(/\s+/g, ' ').trim()
  const end = s.search(/[.!?](\s|$)/)
  if (end > 0) s = s.slice(0, end)
  s = s.replace(/[.,;:\s]+$/, '')
  if (s.length > maxLen) {
    const cut = s.slice(0, maxLen)
    const space = cut.lastIndexOf(' ')
    s = (space > 20 ? cut.slice(0, space) : cut).replace(/[.,;:\s]+$/, '')
  }
  if (s && /^[A-Z](?![A-Z])/.test(s)) s = s[0].toLowerCase() + s.slice(1)
  return s
}

/** Prefill for the generate form: the template's ambience prompt, else one built from the world prompt. */
export function defaultAmbiencePrompt(preset: Pick<WorldPreset, 'templateId' | 'prompts'> | null): string {
  if (!preset) return GENERIC_AMBIENCE
  const template = preset.templateId ? templateById(preset.templateId) : undefined
  if (template?.ambiencePrompt) return template.ambiencePrompt
  const world = preset.prompts.world?.trim()
  if (!world) return GENERIC_AMBIENCE
  const short = shortAmbientDescription(world)
  return short ? `ambient environment, loop of ${short}, no music, no voices` : GENERIC_AMBIENCE
}
