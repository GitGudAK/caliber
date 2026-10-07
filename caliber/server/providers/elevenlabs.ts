// FAL ElevenLabs sound effects v2. Ported from image-blaster
// .claude/scripts/sfx/fal-elevenlabs-sfx.mjs.
//
// Same defaults and validation: text required; duration_seconds optional, 0.5–22;
// prompt_influence 0–1 (default 0.3); output_format default mp3_44100_128 (not
// enum-validated, same as image-blaster; FAL validates); loop default false;
// count 1–4 (each is a separate request). Poll interval 3000ms.
// Non-loop output is post-processed with ffmpeg (silenceremove + loudnorm); loops are
// left untouched so the seamless boundary is preserved. Post-processing only supports
// mp3/opus and image-blaster throws up front for other formats when it would run.
//
// Deviations: ffmpeg/ffprobe paths are configurable (default /usr/local/bin/* when
// present, else PATH lookup) because a GUI-launched server may not have /usr/local/bin
// on PATH. The functions take file paths; downloading is the caller's job.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rename, stat, unlink } from 'node:fs/promises'

export const ELEVENLABS_SFX_ENDPOINT = 'fal-ai/elevenlabs/sound-effects/v2'
export const ELEVENLABS_SFX_POLL_MS = 3000
export const DEFAULT_SFX_OUTPUT_FORMAT = 'mp3_44100_128'
const SILENCE_THRESHOLD_DB = '-45dB'
const START_SILENCE_SECONDS = '0.03'
const END_SILENCE_SECONDS = '0.05'

function asNumber(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`Expected a number, received "${String(value)}".`)
  return number
}

/** image-blaster clampCount: integer-truncated, 1–4. */
export function normalizeSfxCount(value: unknown): number {
  const count = Math.trunc(asNumber(value, 1)!)
  if (count < 1 || count > 4) throw new Error('count must be between 1 and 4.')
  return count
}

export function extensionForOutputFormat(outputFormat: string): string {
  if (outputFormat.startsWith('mp3_')) return '.mp3'
  if (outputFormat.startsWith('pcm_')) return '.pcm'
  if (outputFormat.startsWith('opus_')) return '.opus'
  if (outputFormat.startsWith('ulaw_')) return '.ulaw'
  if (outputFormat.startsWith('alaw_')) return '.alaw'
  return '.audio'
}

export function canPostprocessExtension(extension: string): boolean {
  return ['.mp3', '.opus'].includes(extension)
}

export interface SfxInput {
  text: string
  loop: boolean
  prompt_influence: number
  output_format: string
  duration_seconds?: number
}

/** Pure: input for fal-ai/elevenlabs/sound-effects/v2 (one request; count = repeat). */
export function buildSfxInput(options: {
  text: string
  loop?: boolean
  durationSeconds?: number | string
  promptInfluence?: number | string
  outputFormat?: string
  /** When true (default) and not a loop, require an output format ffmpeg post-processing supports. */
  postprocess?: boolean
}): SfxInput {
  const { text, loop = false, outputFormat = DEFAULT_SFX_OUTPUT_FORMAT, postprocess = true } = options
  if (!text) throw new Error('prompt is required.')

  const duration = asNumber(options.durationSeconds, undefined)
  if (duration !== undefined && (duration < 0.5 || duration > 22)) {
    throw new Error('durationSeconds must be between 0.5 and 22 for the FAL ElevenLabs SFX endpoint.')
  }
  const influence = asNumber(options.promptInfluence, 0.3)!
  if (influence < 0 || influence > 1) throw new Error('promptInfluence must be between 0 and 1.')

  if (postprocess && !loop && !canPostprocessExtension(extensionForOutputFormat(outputFormat))) {
    throw new Error(`Audio post-processing is only supported for mp3 and opus outputs, received ${outputFormat}.`)
  }

  const input: SfxInput = {
    text,
    loop: Boolean(loop),
    prompt_influence: influence,
    output_format: outputFormat,
  }
  if (duration !== undefined) input.duration_seconds = duration
  return input
}

/** Whether image-blaster would post-process this request's output. */
export function shouldPostprocessSfx(input: SfxInput, postprocess = true): boolean {
  return postprocess && !input.loop
}

export function sfxAudioFile(data: unknown): { url: string; content_type?: string; file_name?: string } {
  const audio = (data as { audio?: { url?: unknown } })?.audio
  if (!audio || typeof audio.url !== 'string') throw new Error('FAL SFX result did not include audio.url.')
  return audio as { url: string }
}

// ---------------------------------------------------------------------------
// ffmpeg post-process
// ---------------------------------------------------------------------------

export interface AudioTools {
  ffmpeg?: string
  ffprobe?: string
}

function resolveTool(name: 'ffmpeg' | 'ffprobe', override?: string): string {
  if (override) return override
  const local = `/usr/local/bin/${name}`
  return existsSync(local) ? local : name
}

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${command} ${args.join(' ')} failed: ${error.message}\n${stderr}`
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export async function assertAudioTools(tools: AudioTools = {}): Promise<void> {
  await runCommand(resolveTool('ffmpeg', tools.ffmpeg), ['-version'])
  await runCommand(resolveTool('ffprobe', tools.ffprobe), ['-version'])
}

function parseDb(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function roundSeconds(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.round(value * 1000) / 1000
}

async function probeDuration(filePath: string, tools: AudioTools): Promise<number | undefined> {
  const { stdout } = await runCommand(resolveTool('ffprobe', tools.ffprobe), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath,
  ])
  const duration = Number(JSON.parse(stdout)?.format?.duration)
  return Number.isFinite(duration) ? duration : undefined
}

export interface SilenceAnalysis {
  threshold_db: string
  leading_seconds: number | undefined
  trailing_seconds: number | undefined
  regions: Array<{ start?: number; end?: number; duration?: number }>
}

async function detectSilence(filePath: string, durationSeconds: number | undefined, tools: AudioTools): Promise<SilenceAnalysis> {
  const { stderr } = await runCommand(resolveTool('ffmpeg', tools.ffmpeg), [
    '-hide_banner', '-nostats', '-i', filePath,
    '-af', `silencedetect=noise=${SILENCE_THRESHOLD_DB}:d=${START_SILENCE_SECONDS}`,
    '-f', 'null', '-',
  ])

  const starts = [...stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]))
  const ends = [...stderr.matchAll(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/g)].map((m) => ({
    end: Number(m[1]),
    duration: Number(m[2]),
  }))

  const leadingEnd = starts[0] !== undefined && starts[0] <= 0.05 ? ends[0]?.end : undefined
  const lastStart = starts.at(-1)
  const lastEnd = ends.at(-1)
  const trailingStart =
    durationSeconds !== undefined && lastStart !== undefined && durationSeconds - lastStart >= Number(END_SILENCE_SECONDS)
      ? lastStart
      : undefined

  return {
    threshold_db: SILENCE_THRESHOLD_DB,
    leading_seconds: roundSeconds(leadingEnd ?? 0),
    trailing_seconds: roundSeconds(
      trailingStart !== undefined
        ? Math.max(0, durationSeconds! - trailingStart)
        : lastEnd && durationSeconds !== undefined && Math.abs(durationSeconds - lastEnd.end) <= 0.05
          ? lastEnd.duration
          : 0,
    ),
    regions: starts.map((start, index) => ({
      start: roundSeconds(start),
      end: roundSeconds(ends[index]?.end),
      duration: roundSeconds(ends[index]?.duration),
    })),
  }
}

async function measureVolume(filePath: string, tools: AudioTools) {
  const { stderr } = await runCommand(resolveTool('ffmpeg', tools.ffmpeg), [
    '-hide_banner', '-nostats', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-',
  ])
  return {
    mean_db: parseDb(stderr.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/)?.[1]),
    max_db: parseDb(stderr.match(/max_volume:\s*(-?[0-9.]+)\s*dB/)?.[1]),
  }
}

export interface AudioAnalysis {
  duration_seconds: number | undefined
  bytes: number
  volume: { mean_db?: number; max_db?: number }
  silence: SilenceAnalysis
}

export async function analyzeAudio(filePath: string, tools: AudioTools = {}): Promise<AudioAnalysis> {
  const [durationSeconds, volume, fileStat] = await Promise.all([
    probeDuration(filePath, tools),
    measureVolume(filePath, tools),
    stat(filePath),
  ])
  const silence = await detectSilence(filePath, durationSeconds, tools)
  return { duration_seconds: roundSeconds(durationSeconds), bytes: fileStat.size, volume, silence }
}

function scoreAudio(analysis: { before: AudioAnalysis; after: AudioAnalysis }): number {
  const duration = analysis.after?.duration_seconds ?? analysis.before?.duration_seconds ?? 0
  const leading = analysis.before?.silence?.leading_seconds ?? 0
  const trailing = analysis.before?.silence?.trailing_seconds ?? 0
  const maxDb = analysis.after?.volume?.max_db

  let score = 100
  score -= Math.min(35, leading * 120)
  score -= Math.min(20, trailing * 50)
  if (duration > 3) score -= Math.min(20, (duration - 3) * 8)
  if (maxDb !== undefined && maxDb < -8) score -= Math.min(20, Math.abs(maxDb + 8) * 2)
  return Math.max(0, Math.round(score))
}

export interface PostprocessResult {
  postprocessed: boolean
  skipped_reason?: string
  filters?: string
  before: AudioAnalysis
  after: AudioAnalysis
  trimmed_seconds?: { leading?: number; trailing?: number; total?: number }
  quality_score: number
}

/**
 * Analyze the file and (unless disabled or unsupported) trim leading/trailing silence
 * and loudness-normalize it in place. Pass `postprocess: false` for loops.
 */
export async function analyzeAndPostprocessAudio(
  filePath: string,
  options: { extension?: string; postprocess?: boolean; tools?: AudioTools } = {},
): Promise<PostprocessResult> {
  const extension = options.extension ?? '.mp3'
  const postprocess = options.postprocess !== false
  const tools = options.tools ?? {}
  const before = await analyzeAudio(filePath, tools)

  if (!postprocess || !canPostprocessExtension(extension)) {
    return {
      postprocessed: false,
      skipped_reason: postprocess ? `Unsupported audio extension ${extension}` : 'Post-processing disabled',
      before,
      after: before,
      quality_score: scoreAudio({ before, after: before }),
    }
  }

  const tempPath = `${filePath}.postprocess${extension}`
  const filters = [
    `silenceremove=start_periods=1:start_duration=${START_SILENCE_SECONDS}:start_threshold=${SILENCE_THRESHOLD_DB}:stop_periods=-1:stop_duration=${END_SILENCE_SECONDS}:stop_threshold=${SILENCE_THRESHOLD_DB}`,
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  ].join(',')

  try {
    await runCommand(resolveTool('ffmpeg', tools.ffmpeg), [
      '-y', '-hide_banner', '-nostdin', '-i', filePath, '-af', filters, tempPath,
    ])
    await rename(tempPath, filePath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }

  const after = await analyzeAudio(filePath, tools)
  return {
    postprocessed: true,
    filters,
    before,
    after,
    trimmed_seconds: {
      leading: before.silence.leading_seconds,
      trailing: before.silence.trailing_seconds,
      total: roundSeconds((before.duration_seconds ?? 0) - (after.duration_seconds ?? 0)),
    },
    quality_score: scoreAudio({ before, after }),
  }
}
