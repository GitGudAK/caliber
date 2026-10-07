import path from 'node:path'

const MIME: Record<string, string> = {
  '.spz': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.json': 'application/json',
}

export function mimeFor(filename: string): string {
  return MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream'
}
