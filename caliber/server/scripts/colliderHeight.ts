// Surface height of a World Labs collider near the watch spot, used to drop a world so
// its tabletop lands at y ≈ 0. Minimal GLB reader: float32 POSITION + (optional) index
// accessors, node translation/scale applied; rotation/matrix nodes are rejected rather
// than guessed.
//
// Why raycast instead of a vertex median: the Marble collider is sparse (≈6 vertices
// in the whole watch window on the desk world) and the window also contains ceiling
// vertices directly overhead (y ≈ +15.7 on the desk), so a plain vertex median lands on
// the ceiling. Casting vertical rays through the triangles and taking the first surface
// below the camera (the image camera sits at the origin, above the tabletop) gives the
// interpolated surface height. Checked on the desk world: -0.49 raw -> worldOffset
// 0.0294, matching the lead's hand-tuned value.
import { readFile } from 'node:fs/promises'

type Vec3 = [number, number, number]

interface Gltf {
  scenes?: Array<{ nodes?: number[] }>
  scene?: number
  nodes?: Array<{ mesh?: number; children?: number[]; translation?: Vec3; scale?: Vec3; rotation?: number[]; matrix?: number[] }>
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number; mode?: number }> }>
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; type: string; count: number }>
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>
}

export interface GlbMesh {
  /** xyz triples, raw (unflipped) frame. */
  positions: Float64Array
  /** Triangle vertex indices into positions (by vertex). */
  triangles: Uint32Array
}

export async function readGlbMesh(file: string): Promise<GlbMesh> {
  const buf = await readFile(file)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB`)
  let offset = 12
  let json: Gltf | null = null
  let bin: Buffer | null = null
  while (offset < buf.length) {
    const length = buf.readUInt32LE(offset)
    const type = buf.readUInt32LE(offset + 4)
    const chunk = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8')) as Gltf
    else if (type === 0x004e4942) bin = chunk
    offset += 8 + length
  }
  if (!json || !bin) throw new Error(`${file}: missing JSON or BIN chunk`)
  const gltf = json
  const binChunk = bin

  const positions: number[] = []
  const triangles: number[] = []
  const readIndex = (componentType: number, at: number) =>
    componentType === 5125 ? binChunk.readUInt32LE(at) : componentType === 5123 ? binChunk.readUInt16LE(at) : binChunk.readUInt8(at)
  const indexSize = (componentType: number) => (componentType === 5125 ? 4 : componentType === 5123 ? 2 : 1)

  const visit = (index: number, t: Vec3, s: Vec3) => {
    const node = gltf.nodes?.[index]
    if (!node) return
    const r = node.rotation
    if (node.matrix || (r && !(r[0] === 0 && r[1] === 0 && r[2] === 0))) {
      throw new Error(`${file}: node ${index} has a rotation/matrix; not supported by this reader`)
    }
    const ns = node.scale ?? [1, 1, 1]
    const nt = node.translation ?? [0, 0, 0]
    // parent(t, s) ∘ node(nt, ns): p -> t + s * (nt + ns * p)
    const T: Vec3 = [t[0] + s[0] * nt[0], t[1] + s[1] * nt[1], t[2] + s[2] * nt[2]]
    const S: Vec3 = [s[0] * ns[0], s[1] * ns[1], s[2] * ns[2]]
    for (const prim of node.mesh !== undefined ? (gltf.meshes?.[node.mesh]?.primitives ?? []) : []) {
      if ((prim.mode ?? 4) !== 4) throw new Error(`${file}: primitive mode ${prim.mode} is not TRIANGLES`)
      const accessor = gltf.accessors?.[prim.attributes.POSITION]
      if (!accessor) continue
      if (accessor.componentType !== 5126 || accessor.type !== 'VEC3' || accessor.bufferView === undefined) {
        throw new Error(`${file}: POSITION accessor is not float32 VEC3`)
      }
      const base = positions.length / 3
      const view = gltf.bufferViews![accessor.bufferView]
      const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
      const stride = view.byteStride ?? 12
      for (let i = 0; i < accessor.count; i++) {
        const o = start + i * stride
        positions.push(
          T[0] + S[0] * binChunk.readFloatLE(o),
          T[1] + S[1] * binChunk.readFloatLE(o + 4),
          T[2] + S[2] * binChunk.readFloatLE(o + 8),
        )
      }
      if (prim.indices === undefined) {
        for (let i = 0; i + 2 < accessor.count; i += 3) triangles.push(base + i, base + i + 1, base + i + 2)
      } else {
        const ia = gltf.accessors![prim.indices]
        const iv = gltf.bufferViews![ia.bufferView!]
        const istart = (iv.byteOffset ?? 0) + (ia.byteOffset ?? 0)
        const size = indexSize(ia.componentType)
        for (let i = 0; i < ia.count; i++) triangles.push(base + readIndex(ia.componentType, istart + i * size))
      }
    }
    for (const child of node.children ?? []) visit(child, T, S)
  }
  const scene = gltf.scenes?.[gltf.scene ?? 0]
  for (const root of scene?.nodes ?? []) visit(root, [0, 0, 0], [1, 1, 1])
  return { positions: Float64Array.from(positions), triangles: Uint32Array.from(triangles) }
}

export interface SurfaceHeight {
  /** Median surface y (after flip) under the watch window, raw world units. */
  medianY: number
  /** Rays that hit a surface below the camera / rays cast. */
  hits: number
  rays: number
  minY: number
  maxY: number
  /** Plain median of the vertex y values in the window, for comparison (often the ceiling). */
  vertexMedianY: number | null
  vertexSamples: number
  /** worldOffset[1] that puts the surface at y = 0 for this worldScale. */
  worldOffsetY: number
  worldScale: number
  window: { absX: number; zMin: number; zMax: number }
}

const median = (values: number[]) => {
  const a = [...values].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/**
 * Surface height near the watch spot. flip_y maps (x, y, z) -> (x, -y, -z); the window
 * |x| < 0.15, z in [-1.6, -0.3] is in that flipped frame, raw (unscaled) units. A grid of
 * vertical rays covers the window; each takes the highest surface below the camera
 * (y < 0); the result is the median over rays that hit.
 */
export async function colliderSurfaceHeight(file: string, worldScale: number, flipY = true): Promise<SurfaceHeight> {
  const window = { absX: 0.15, zMin: -1.6, zMax: -0.3 }
  const { positions: raw, triangles } = await readGlbMesh(file)
  const p = Float64Array.from(raw)
  if (flipY) for (let i = 0; i < p.length; i += 3) ((p[i + 1] = -p[i + 1]), (p[i + 2] = -p[i + 2]))

  const vertexYs: number[] = []
  for (let i = 0; i < p.length; i += 3) {
    if (Math.abs(p[i]) < window.absX && p[i + 2] >= window.zMin && p[i + 2] <= window.zMax) vertexYs.push(p[i + 1])
  }

  const rays: Array<[number, number]> = []
  for (let xi = 0; xi <= 6; xi++) {
    for (let zi = 0; zi <= 13; zi++) {
      rays.push([-window.absX + (xi * 2 * window.absX) / 6, window.zMin + (zi * (window.zMax - window.zMin)) / 13])
    }
  }
  const best = new Array<number>(rays.length).fill(-Infinity)
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3, b = triangles[t + 1] * 3, c = triangles[t + 2] * 3
    const ax = p[a], az = p[a + 2], bx = p[b], bz = p[b + 2], cx = p[c], cz = p[c + 2]
    const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx), minZ = Math.min(az, bz, cz), maxZ = Math.max(az, bz, cz)
    if (maxX < -window.absX || minX > window.absX || maxZ < window.zMin || minZ > window.zMax) continue
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if (Math.abs(det) < 1e-12) continue // vertical triangle: no unique height
    for (let r = 0; r < rays.length; r++) {
      const [x, z] = rays[r]
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det
      const l3 = 1 - l1 - l2
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue
      const y = l1 * p[a + 1] + l2 * p[b + 1] + l3 * p[c + 1]
      if (y < 0 && y > best[r]) best[r] = y
    }
  }
  const hits = best.filter((y) => y > -Infinity)
  if (!hits.length) throw new Error(`${file}: no collider surface below the camera in the watch window`)
  const medianY = median(hits)
  return {
    medianY,
    hits: hits.length,
    rays: rays.length,
    minY: Math.min(...hits),
    maxY: Math.max(...hits),
    vertexMedianY: vertexYs.length ? median(vertexYs) : null,
    vertexSamples: vertexYs.length,
    worldOffsetY: -medianY * worldScale,
    worldScale,
    window,
  }
}
