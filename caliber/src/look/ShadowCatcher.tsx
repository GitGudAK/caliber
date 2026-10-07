import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import type { Vec3 } from './panoMath'
import { WATCH_LAYER, hasVisibleMesh, markWatchLayer } from './watchLayer'

export interface ShadowCatcherProps {
  /** A point on the resting surface (e.g. the watch's lowest point projected onto the desk). */
  position: Vec3
  /** Surface normal. Default [0, 1, 0]. */
  normal?: Vec3
  /** Edge length (m) of the key-light catcher plane (low sun = long shadows). Default 0.6. */
  size?: number
  /** Key-light shadow on/off. Default true. */
  keyShadow?: boolean
  /** Strength of the key-light shadow, 0..1 (0 = none, 1 = full shadowColor). Default 1. */
  shadowOpacity?: number
  /**
   * What the splat's displayed color is MULTIPLIED by inside full shadow (display space, 0..1).
   * Multiply, not black-over, so the wood grain stays and shadows get warmer/more saturated like
   * real ones. Use shadowTintFromEstimate(estimate). Default [0.45, 0.4, 0.36].
   */
  shadowColor?: Vec3
  /** The watch root, for the contact shadow (rendered alone via WATCH_LAYER). */
  contactTarget?: THREE.Object3D | null
  /** Contact (ambient-occlusion) shadow on/off. Default true. */
  contact?: boolean
  /** Strength of the contact shadow, 0..1 (multiplies by contactColor at 1). Default 1. */
  contactOpacity?: number
  /** Height (m) above the surface at which the contact shadow fades out. Default 0.012. */
  contactHeight?: number
  /** Edge length (m) of the contact-shadow area. Default 0.09. */
  contactSize?: number
  /** Gaussian blur sigma in texels of the contact map. Default 4. */
  contactBlur?: number
  /** Contact map resolution. Default 256. */
  contactResolution?: number
  /** Multiplier at full contact occlusion (display space). Default: shadowColor * 0.5. */
  contactColor?: Vec3
  /** Drawn after Spark's splats (renderOrder 0). Default 10. */
  renderOrder?: number
}

/**
 * Spark's splat draw leaves GL texture state that three's state cache doesn't know about, so a
 * textured/shadow-sampling material drawn AFTER the splats in the same render reads stale
 * bindings (verified: ShadowMaterial at renderOrder 10 showed no shadow until this). Resync the
 * cache right before our draw and restore the current render target (resetState clears it).
 */
const resyncAfterSpark: THREE.Object3D['onBeforeRender'] = (renderer) => {
  const target = renderer.getRenderTarget()
  const face = renderer.getActiveCubeFace()
  const mip = renderer.getActiveMipmapLevel()
  renderer.resetState()
  renderer.setRenderTarget(target, face, mip)
}

const DEFAULT_TINT: Vec3 = [0.45, 0.4, 0.36]

/**
 * Shadow multiplier from a light estimate: darker for a high-contrast (sunny) pano, tinted toward
 * the local surface color (shadowed wood reads warmer and more saturated, not grey).
 */
export function shadowTintFromEstimate(est: { groundColor: Vec3; contrast: number }, depth?: number): Vec3 {
  const d = depth ?? Math.min(0.7, Math.max(0.3, 0.12 * est.contrast))
  const base = 1 - d
  return est.groundColor.map((g) => Math.min(1, base * Math.pow(Math.max(g, 1e-3), 0.35))) as Vec3
}

/** dst * src blending: the fragment's rgb is a multiplier on what is already on screen. */
const MULTIPLY = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.DstColorFactor,
  blendDst: THREE.ZeroFactor,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
} as const

const CONTACT_DEPTH_VERT = /* glsl */ `
uniform vec3 planePoint;
uniform vec3 planeNormal;
varying float vHeight;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vHeight = dot(wp.xyz - planePoint, planeNormal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`
const CONTACT_DEPTH_FRAG = /* glsl */ `
uniform float maxHeight;
varying float vHeight;
void main() {
  float t = clamp(vHeight / maxHeight, 0.0, 1.0);
  float d = (1.0 - t);
  gl_FragColor = vec4(pow(d, 1.5), 0.0, 0.0, 1.0);
}`
const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 dir;
uniform float sigma;
varying vec2 vUv;
void main() {
  float sum = texture2D(tMap, vUv).r;
  float ws = 1.0;
  for (int i = 1; i <= 12; i++) {
    float x = float(i) * max(sigma, 0.01) / 4.0;
    float w = exp(-0.5 * x * x / (sigma * sigma + 1e-4));
    sum += w * (texture2D(tMap, vUv + dir * x).r + texture2D(tMap, vUv - dir * x).r);
    ws += 2.0 * w;
  }
  gl_FragColor = vec4(sum / ws, 0.0, 0.0, 1.0);
}`
const CONTACT_SHOW_VERT = /* glsl */ `
uniform mat4 contactViewProj;
varying vec2 vUv;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 c = contactViewProj * wp;
  vUv = c.xy / c.w * 0.5 + 0.5;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`
const CONTACT_SHOW_FRAG = /* glsl */ `
uniform sampler2D tMap;
uniform vec3 color;
uniform float opacity;
varying vec2 vUv;
void main() {
  vec2 e = smoothstep(0.0, 0.08, vUv) * smoothstep(0.0, 0.08, 1.0 - vUv);
  float a = texture2D(tMap, vUv).r * opacity * e.x * e.y;
  gl_FragColor = vec4(mix(vec3(1.0), color, a), 1.0);
}`

/**
 * Invisible ground at the watch's resting point:
 *  - a ShadowMaterial plane that receives the key light's shadow (tinted, not black);
 *  - a contact shadow: the watch rendered from below (WATCH_LAYER only) into a height-falloff map,
 *    blurred, and multiplied onto the surface for grounding.
 * Both draw after the splats (renderOrder), with depthWrite off and depthTest on, so the splat desk
 * shows through and only the watch occludes them.
 */
export function ShadowCatcher({
  position,
  normal = [0, 1, 0],
  size = 0.6,
  keyShadow = true,
  shadowOpacity = 1,
  shadowColor = DEFAULT_TINT,
  contactTarget = null,
  contact = true,
  contactOpacity = 1,
  contactColor,
  contactHeight = 0.012,
  contactSize = 0.09,
  contactBlur = 4,
  contactResolution = 256,
  renderOrder = 10,
}: ShadowCatcherProps) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)

  const quat = useMemo(() => {
    const n = new THREE.Vector3(...normal).normalize()
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n)
  }, [normal])

  const shadowMat = useMemo(() => {
    const m = new THREE.ShadowMaterial({ transparent: true, depthWrite: false, toneMapped: false, ...MULTIPLY })
    // Output a multiplier (display space) instead of color-over-alpha.
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
          'float lookShadow = opacity * ( 1.0 - getShadowMask() );\n\tgl_FragColor = vec4( mix( vec3( 1.0 ), color, lookShadow ), 1.0 );',
        )
        .replace('#include <colorspace_fragment>', '')
        .replace('#include <tonemapping_fragment>', '')
        .replace('#include <fog_fragment>', '')
    }
    m.customProgramCacheKey = () => 'look-shadow-multiply'
    return m
  }, [])
  useEffect(() => {
    shadowMat.opacity = shadowOpacity
    // Raw values: the shader uses them as display-space multipliers.
    shadowMat.color.setRGB(...shadowColor, THREE.LinearSRGBColorSpace)
  }, [shadowMat, shadowOpacity, shadowColor])

  const c = useMemo(() => {
    const rtOpts = { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
    const rtDepth = new THREE.WebGLRenderTarget(contactResolution, contactResolution, { ...rtOpts, depthBuffer: true })
    const rtA = new THREE.WebGLRenderTarget(contactResolution, contactResolution, rtOpts)
    const depthMat = new THREE.ShaderMaterial({
      uniforms: { planePoint: { value: new THREE.Vector3() }, planeNormal: { value: new THREE.Vector3() }, maxHeight: { value: 0.01 } },
      vertexShader: CONTACT_DEPTH_VERT,
      fragmentShader: CONTACT_DEPTH_FRAG,
      side: THREE.DoubleSide,
    })
    const blurMat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: null }, dir: { value: new THREE.Vector2() }, sigma: { value: 3 } },
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    })
    const showMat = new THREE.ShaderMaterial({
      uniforms: {
        tMap: { value: rtDepth.texture },
        color: { value: new THREE.Color() },
        opacity: { value: 0.75 },
        contactViewProj: { value: new THREE.Matrix4() },
      },
      vertexShader: CONTACT_SHOW_VERT,
      fragmentShader: CONTACT_SHOW_FRAG,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      ...MULTIPLY,
    })
    const cam = new THREE.OrthographicCamera()
    cam.layers.set(WATCH_LAYER)
    return { rtDepth, rtA, depthMat, blurMat, showMat, cam, quad: new FullScreenQuad(blurMat), clear: new THREE.Color() }
  }, [contactResolution])
  useEffect(
    () => () => {
      c.rtDepth.dispose()
      c.rtA.dispose()
      c.depthMat.dispose()
      c.blurMat.dispose()
      c.showMat.dispose()
      c.quad.dispose()
    },
    [c],
  )
  useEffect(() => () => shadowMat.dispose(), [shadowMat])

  useEffect(() => {
    const cc = contactColor ?? (shadowColor.map((v) => v * 0.5) as Vec3)
    c.showMat.uniforms.color.value.setRGB(...cc, THREE.LinearSRGBColorSpace)
    c.showMat.uniforms.opacity.value = contactOpacity
  }, [c, shadowColor, contactColor, contactOpacity])

  // Render the contact map before the main render (priority 0 runs before FrameRenderer's 1).
  useFrame(() => {
    if (!contact || !contactTarget || !hasVisibleMesh(contactTarget)) return
    markWatchLayer(contactTarget)
    const n = new THREE.Vector3(...normal).normalize()
    const p = new THREE.Vector3(...position)
    const cam = c.cam
    const h = contactSize / 2
    cam.left = -h
    cam.right = h
    cam.top = h
    cam.bottom = -h
    cam.near = 0
    cam.far = contactHeight + 0.002
    // From just below the surface, looking up along the normal.
    cam.position.copy(p).addScaledVector(n, -0.001)
    cam.up.set(0, 1, 0).applyQuaternion(quat)
    cam.lookAt(p.clone().add(n))
    cam.updateMatrixWorld()
    cam.updateProjectionMatrix()
    c.showMat.uniforms.contactViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    c.depthMat.uniforms.planePoint.value.copy(p)
    c.depthMat.uniforms.planeNormal.value.copy(n)
    c.depthMat.uniforms.maxHeight.value = contactHeight

    const prevTarget = gl.getRenderTarget()
    const prevOverride = scene.overrideMaterial
    const prevBg = scene.background
    const prevAuto = gl.shadowMap.autoUpdate
    const prevAlpha = gl.getClearAlpha()
    gl.getClearColor(c.clear)
    scene.overrideMaterial = c.depthMat
    scene.background = null
    const prevNeeds = gl.shadowMap.needsUpdate
    gl.shadowMap.autoUpdate = false
    gl.shadowMap.needsUpdate = false // never re-render the key shadow map from this side pass
    gl.setClearColor(0x000000, 0)
    gl.setRenderTarget(c.rtDepth)
    gl.clear()
    gl.render(scene, cam)
    scene.overrideMaterial = prevOverride
    scene.background = prevBg
    gl.shadowMap.autoUpdate = prevAuto
    gl.shadowMap.needsUpdate = prevNeeds

    c.quad.material = c.blurMat
    c.blurMat.uniforms.sigma.value = contactBlur
    c.blurMat.uniforms.tMap.value = c.rtDepth.texture
    c.blurMat.uniforms.dir.value.set(1 / contactResolution, 0)
    gl.setRenderTarget(c.rtA)
    c.quad.render(gl)
    c.blurMat.uniforms.tMap.value = c.rtA.texture
    c.blurMat.uniforms.dir.value.set(0, 1 / contactResolution)
    gl.setRenderTarget(c.rtDepth)
    c.quad.render(gl)

    gl.setRenderTarget(prevTarget)
    gl.setClearColor(c.clear, prevAlpha)
  })

  const lift = new THREE.Vector3(...normal).normalize().multiplyScalar(0.00005)
  const pos: Vec3 = [position[0] + lift.x, position[1] + lift.y, position[2] + lift.z]
  return (
    <group position={pos} quaternion={quat}>
      {keyShadow && (
        <mesh receiveShadow renderOrder={renderOrder} material={shadowMat} raycast={() => {}} onBeforeRender={resyncAfterSpark}>
          <planeGeometry args={[size, size]} />
        </mesh>
      )}
      {contact && contactTarget && (
        <mesh renderOrder={renderOrder + 1} material={c.showMat} raycast={() => {}} onBeforeRender={resyncAfterSpark}>
          <planeGeometry args={[contactSize, contactSize]} />
        </mesh>
      )}
    </group>
  )
}
