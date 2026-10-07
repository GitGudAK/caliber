/**
 * Equirectangular <-> direction math, matching three.js exactly.
 *
 * three's shader convention (ShaderChunk/common.glsl `equirectUv`):
 *   u = atan2(dir.z, dir.x) / 2PI + 0.5      (u = 0.5 is +X, u = 0.75 is +Z, u = 0.25 is -Z)
 *   v = asin(dir.y) / PI + 0.5              (v = 1 is straight up)
 * Textures load with flipY = true, so v = 1 is the TOP row of the image file.
 * Image coordinates used here: x in [0, width) left->right, y in [0, height) top->bottom.
 *
 * scene.environmentRotation.y = theta rotates the environment by +theta about Y:
 * three samples the env at R_y(-theta) * worldDir, so a pano-frame direction p shows up in
 * the world at R_y(theta) * p.
 */
export type Vec3 = [number, number, number]

/** Pano-frame (three equirect convention) direction for texture uv (v = 1 is the top). */
export function equirectUvToDirection(u: number, v: number): Vec3 {
  const phi = (u - 0.5) * 2 * Math.PI
  const lat = (v - 0.5) * Math.PI
  const c = Math.cos(lat)
  return [Math.cos(phi) * c, Math.sin(lat), Math.sin(phi) * c]
}

/** Inverse of equirectUvToDirection. dir need not be normalized. */
export function directionToEquirectUv(dir: Vec3): [number, number] {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1
  const y = Math.min(1, Math.max(-1, dir[1] / len))
  const u = Math.atan2(dir[2], dir[0]) / (2 * Math.PI) + 0.5
  const v = Math.asin(y) / Math.PI + 0.5
  return [u, v]
}

/** Image pixel center (x right, y down from the top row) -> pano-frame direction. */
export function pixelToDirection(x: number, y: number, width: number, height: number): Vec3 {
  return equirectUvToDirection((x + 0.5) / width, 1 - (y + 0.5) / height)
}

/** Pano-frame direction -> fractional image pixel (x right, y down from the top row). */
export function directionToPixel(dir: Vec3, width: number, height: number): [number, number] {
  const [u, v] = directionToEquirectUv(dir)
  return [u * width, (1 - v) * height]
}

/** Rotate a vector about +Y by `angle` radians (right-handed, same as Object3D.rotation.y). */
export function rotateY(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]
}

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/**
 * The scene.environmentRotation.y that lines a World Labs pano up with its splat.
 *
 * The pano's center column (u = 0.5, three's +X) is the world's original forward view.
 * World Labs splats are OpenCV-style (forward +Z, Y down); flipY (PI about X) turns forward
 * into -Z, so the pano needs +PI/2 to put its center at -Z. worldRotationY rotates the splat
 * about Y after that, so it adds on.
 *
 * Verified for flipY worlds (desk preset, mirror-sphere check in look-sandbox). For
 * flipY = false we assume forward stays +Z (-PI/2); not verified (no such world on hand).
 */
export function panoRotationY(world: { flipY: boolean; worldRotationY?: number }): number {
  return (world.flipY ? Math.PI / 2 : -Math.PI / 2) + (world.worldRotationY ?? 0)
}

/** Pano-frame direction -> world (scene) direction for a given environment rotation. */
export function panoToWorld(dir: Vec3, rotationY: number): Vec3 {
  return rotateY(dir, rotationY)
}
