import { createReadStream } from 'node:fs'
import { mkdir, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'

// The app only depends on this interface; a local folder is one implementation.
export interface AssetStorage {
  /** Write bytes under a storage key like "projects/<id>/watch/model.glb". */
  save(key: string, data: Uint8Array): Promise<{ key: string; bytes: number }>
  /** Copy a file already on disk into storage. */
  saveFromFile(key: string, sourcePath: string): Promise<{ key: string; bytes: number }>
  /** Download a remote URL straight into storage (provider outputs). */
  saveFromUrl(key: string, url: string): Promise<{ key: string; bytes: number }>
  url(key: string): string
  delete(key: string): Promise<void>
  /** For the server's own use (static serving, ffmpeg). */
  stat(key: string): Promise<{ size: number } | undefined>
  read(key: string, range?: { start: number; end: number }): NodeJS.ReadableStream
}

export function createLocalStorage(rootDir: string, urlPrefix = '/assets'): AssetStorage {
  const resolve = (key: string) => {
    const full = path.resolve(rootDir, key)
    if (!full.startsWith(path.resolve(rootDir) + path.sep)) throw new Error(`Invalid storage key: ${key}`)
    return full
  }

  return {
    async save(key, data) {
      const full = resolve(key)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, data)
      return { key, bytes: data.byteLength }
    },
    async saveFromFile(key, sourcePath) {
      const full = resolve(key)
      await mkdir(path.dirname(full), { recursive: true })
      await copyFile(sourcePath, full)
      return { key, bytes: (await stat(full)).size }
    },
    async saveFromUrl(key, url) {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`)
      return this.save(key, new Uint8Array(await response.arrayBuffer()))
    },
    url: (key) => `${urlPrefix}/${key.split(path.sep).map(encodeURIComponent).join('/')}`,
    async delete(key) {
      await rm(resolve(key), { force: true })
    },
    async stat(key) {
      try {
        const s = await stat(resolve(key))
        return s.isFile() ? { size: s.size } : undefined
      } catch {
        return undefined
      }
    },
    read(key, range) {
      return createReadStream(resolve(key), range)
    },
  }
}
