// Fetch + decode an audio file to an AudioBuffer. Uses an OfflineAudioContext so no
// live AudioContext (and no autoplay prompt) is needed just to decode.

export const MIX_SAMPLE_RATE = 48000

export async function decodeAudioUrl(url: string, sampleRate = MIX_SAMPLE_RATE): Promise<AudioBuffer> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    throw new Error(`Could not fetch audio ${url}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) throw new Error(`Could not fetch audio ${url}: HTTP ${res.status} ${res.statusText}`)
  const bytes = await res.arrayBuffer()
  if (bytes.byteLength === 0) throw new Error(`Audio file ${url} is empty (0 bytes).`)
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate })
  try {
    return await ctx.decodeAudioData(bytes)
  } catch (e) {
    throw new Error(`Could not decode audio ${url}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
