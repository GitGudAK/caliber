import { useEffect, useImperativeHandle, useMemo, type RefObject, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { SparkRenderer } from '@sparkjsdev/spark'
import { MAX_WATCH_SIGMA_PX, WATCH_SHARP_SIGMA_PX, applySparkDof, cocPixels, type DofSettings } from './dof'
import type { ShotRigApi } from './ShotRig'
import { forceResort } from './sparkSort'
import type { FinishPassApi } from '../look'

export interface FrameStats {
  /** Focus distance used this frame (meters from the camera). */
  focus: number
  /** Watch blur sigma in drawing-buffer pixels (0 = drawn sharp in the normal pass). */
  watchSigma: number
}

export interface FrameRendererApi {
  /**
   * Render one complete frame to the canvas, synchronously: splat DOF, watch layer blur,
   * then the finish pass (grain seeded by `timeSeconds` when given, so export frames are repeatable).
   */
  renderNow: (timeSeconds?: number) => void
  lastStats: () => FrameStats
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

// Separable Gaussian over premultiplied RGBA. Up to 48 taps per side; for large sigma the taps
// spread out (bilinear filtering fills between them).
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 texel;
uniform float sigma;
varying vec2 vUv;
void main() {
  float radius = ceil(3.0 * sigma);
  float n = min(radius, 48.0);
  float stepPx = radius / max(n, 1.0);
  vec4 sum = texture2D(tDiffuse, vUv);
  float wsum = 1.0;
  for (int i = 1; i <= 48; i++) {
    if (float(i) > n) break;
    float x = float(i) * stepPx;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    sum += w * (texture2D(tDiffuse, vUv + texel * x) + texture2D(tDiffuse, vUv - texel * x));
    wsum += 2.0 * w;
  }
  gl_FragColor = sum / wsum;
}`

// Linear HDR (premultiplied) -> display values (premultiplied), BEFORE blurring. Blurring HDR
// first lets specular highlights (>> 1) spread into milky halos, which doesn't match the splat
// DOF (Spark blurs captured display colors). Same operator as the sharp path: three's
// NeutralToneMapping (Harmonize sets it) or none, then the sRGB OETF.
const PREPARE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float exposure;
uniform int mode; // 0 = none, 1 = Khronos PBR Neutral
varying vec2 vUv;
vec3 neutralTM(vec3 color) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.15;
  color *= exposure;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < StartCompression) return color;
  float d = 1.0 - StartCompression;
  float newPeak = 1.0 - d * d / (peak + d - StartCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (Desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}
vec3 srgbOETF(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  vec4 t = texture2D(tDiffuse, vUv);
  float a = t.a;
  vec3 c = a > 1e-4 ? t.rgb / a : vec3(0.0);
  c = mode == 1 ? neutralTM(c) : c * exposure;
  gl_FragColor = vec4(srgbOETF(c) * a, a);
}`

// Blurred display-space layer (premultiplied) straight onto the canvas.
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`

/**
 * Draw the scene with the watch contributing nothing to color or depth, while it stays visible
 * to the shadow-map pass and to WATCH_LAYER side passes (contact shadow, finish-pass mask).
 * Setting watch.visible = false instead would re-render a pending static shadow map without it.
 */
function renderWithoutWatchColor(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, watch: THREE.Object3D) {
  const saved: [THREE.Material, boolean, boolean][] = []
  watch.traverse((o) => {
    const m = (o as THREE.Mesh).material
    if (!m) return
    for (const mat of Array.isArray(m) ? m : [m]) {
      saved.push([mat, mat.colorWrite, mat.depthWrite])
      mat.colorWrite = false
      mat.depthWrite = false
    }
  })
  try {
    gl.render(scene, camera)
  } finally {
    for (const [mat, c, d] of saved) {
      mat.colorWrite = c
      mat.depthWrite = d
    }
  }
}

/** Renders the watch alone into a target, blurs it, and composites it over the frame. */
class WatchLayerBlur {
  private rtA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true })
  private rtB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
  private blurMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, texel: { value: new THREE.Vector2() }, sigma: { value: 1 } },
    vertexShader: VERT,
    fragmentShader: BLUR_FRAG,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private prepMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, exposure: { value: 1 }, mode: { value: 1 } },
    vertexShader: VERT,
    fragmentShader: PREPARE_FRAG,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private warned = false
  private compMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: VERT,
    fragmentShader: COMPOSITE_FRAG,
    toneMapped: false,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
  })
  // Shadow multiplier layer (display-space factors, 1 = no shadow) multiplied onto the canvas.
  private multiplyMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: VERT,
    fragmentShader: COMPOSITE_FRAG,
    toneMapped: false,
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
  })
  private quad = new FullScreenQuad(this.blurMat)
  private clear = new THREE.Color()

  /** Separable Gaussian: src -> tmp -> dst (all the same size). */
  private gaussian(gl: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget, tmp: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget, sigma: number, w: number, h: number) {
    this.quad.material = this.blurMat
    this.blurMat.uniforms.sigma.value = sigma
    this.blurMat.uniforms.tDiffuse.value = src.texture
    this.blurMat.uniforms.texel.value.set(1 / w, 0)
    gl.setRenderTarget(tmp)
    this.quad.render(gl)
    this.blurMat.uniforms.tDiffuse.value = tmp.texture
    this.blurMat.uniforms.texel.value.set(0, 1 / h)
    gl.setRenderTarget(dst)
    this.quad.render(gl)
  }

  /** Render only `keep` (+ lights) into `target`, cleared to the given color/alpha. */
  private renderOnly(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, keep: THREE.Object3D, target: THREE.WebGLRenderTarget, clear: number, alpha: number) {
    const hidden: THREE.Object3D[] = []
    for (const c of scene.children) {
      if (c !== keep && !(c as THREE.Light).isLight && c.visible) {
        c.visible = false
        hidden.push(c)
      }
    }
    const bg = scene.background
    scene.background = null
    gl.setRenderTarget(target)
    gl.setClearColor(clear, alpha)
    gl.autoClear = true
    try {
      gl.render(scene, camera)
    } finally {
      scene.background = bg
      for (const c of hidden) c.visible = true
    }
  }

  /**
   * Blurs the surface shadows (cast + contact) under the watch by the watch's CoC: they sit at
   * its depth. The catcher is drawn alone onto white (its materials multiply), blurred, and the
   * blurred factors multiplied onto the canvas, which was drawn without the catcher.
   */
  renderShadows(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, catcher: THREE.Object3D, sigma: number, size: THREE.Vector2) {
    const w = Math.max(1, Math.floor(size.x))
    const h = Math.max(1, Math.floor(size.y))
    if (this.rtA.width !== w || this.rtA.height !== h) {
      this.rtA.setSize(w, h)
      this.rtB.setSize(w, h)
    }
    const prevTarget = gl.getRenderTarget()
    const prevAutoClear = gl.autoClear
    gl.getClearColor(this.clear)
    const prevAlpha = gl.getClearAlpha()
    this.renderOnly(gl, scene, camera, catcher, this.rtA, 0xffffff, 1)
    this.gaussian(gl, this.rtA, this.rtB, this.rtA, sigma, w, h)
    gl.setRenderTarget(prevTarget)
    gl.autoClear = false
    this.quad.material = this.multiplyMat
    this.multiplyMat.uniforms.tDiffuse.value = this.rtA.texture
    this.quad.render(gl)
    gl.autoClear = prevAutoClear
    gl.setClearColor(this.clear, prevAlpha)
  }

  render(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, watch: THREE.Object3D, sigma: number, size: THREE.Vector2) {
    const w = Math.max(1, Math.floor(size.x))
    const h = Math.max(1, Math.floor(size.y))
    if (this.rtA.width !== w || this.rtA.height !== h) {
      this.rtA.setSize(w, h)
      this.rtB.setSize(w, h)
    }
    const prevTarget = gl.getRenderTarget()
    const prevAutoClear = gl.autoClear
    gl.getClearColor(this.clear)
    const prevAlpha = gl.getClearAlpha()

    // 1. Watch only, on transparent black.
    this.renderOnly(gl, scene, camera, watch, this.rtA, 0x000000, 0)

    // 2. To display values, A -> B.
    if (gl.toneMapping !== THREE.NeutralToneMapping && gl.toneMapping !== THREE.NoToneMapping && !this.warned) {
      this.warned = true
      console.warn('[viewer] DOF watch blur supports Neutral or no tone mapping; using Neutral')
    }
    this.quad.material = this.prepMat
    this.prepMat.uniforms.tDiffuse.value = this.rtA.texture
    this.prepMat.uniforms.exposure.value = gl.toneMappingExposure
    this.prepMat.uniforms.mode.value = gl.toneMapping === THREE.NoToneMapping ? 0 : 1
    gl.setRenderTarget(this.rtB)
    this.quad.render(gl)

    // 3. Separable Gaussian, B -> A -> B.
    this.gaussian(gl, this.rtB, this.rtA, this.rtB, sigma, w, h)

    // 4. Over the background already on the canvas.
    gl.setRenderTarget(prevTarget)
    gl.autoClear = false
    this.quad.material = this.compMat
    this.compMat.uniforms.tDiffuse.value = this.rtB.texture
    this.quad.render(gl)

    gl.autoClear = prevAutoClear
    gl.setClearColor(this.clear, prevAlpha)
  }

  dispose() {
    this.rtA.dispose()
    this.rtB.dispose()
    this.blurMat.dispose()
    this.compMat.dispose()
    this.prepMat.dispose()
    this.multiplyMat.dispose()
    this.quad.dispose()
  }
}

/**
 * Owns rendering of the canvas (useFrame priority 1, so R3F's automatic render is off):
 * - focus: the shot sample's focusDistance while previewing, else the orbit target distance;
 * - splats: Spark DOF uniforms with the shared CoC curve;
 * - watch: one depth (its center); CoC < 0.3px renders in the normal single pass (exact),
 *   otherwise background pass without the watch + blurred watch layer composited on top.
 *   Trade-off: while blurred, splats in front of the watch no longer occlude it.
 * - frame guide: with a frameAspect narrower than the canvas, camera.zoom < 1 so the guide
 *   rect shows exactly the export framing at the shot's vertical fov.
 */
export function FrameRenderer({
  watch,
  catcher,
  spark,
  dof,
  rig,
  frameAspect,
  exporting,
  finish,
  finishBlurred,
  playing,
  apiRef,
}: {
  watch: THREE.Object3D | null
  /** Shadow catcher root (cast + contact shadows): blurred with the watch when it is out of focus. */
  catcher: THREE.Object3D | null
  spark: RefObject<SparkRenderer | null>
  dof: RefObject<DofSettings>
  rig: RefObject<ShotRigApi | null>
  frameAspect: number | null
  exporting: RefObject<boolean>
  /** Finish pass for sharp frames, and one without the silhouette effects for blurred-watch frames. */
  finish?: RefObject<FinishPassApi | null>
  finishBlurred?: RefObject<FinishPassApi | null>
  /** True while a shot preview is playing (forces a splat re-sort each frame). */
  playing?: () => boolean
  apiRef: Ref<FrameRendererApi>
}) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null
  const size = useThree((s) => s.size)

  const { api, blur } = useMemo(() => {
    const blur = new WatchLayerBlur()
    const tmp = new THREE.Vector3()
    const buf = new THREE.Vector2()
    let stats: FrameStats = { focus: 0, watchSigma: 0 }
    const renderNow = (timeSeconds?: number) => {
      const blurred = renderScene()
      // The sharp silhouette mask would cut edges into a blurred watch, so skip it then.
      ;(blurred ? finishBlurred : finish)?.current?.apply(timeSeconds)
    }
    /** Returns true when the watch was drawn as a blurred layer. */
    const renderScene = (): boolean => {
      const settings = dof.current
      const sp = spark.current
      let focus = rig.current?.shotFocus() ?? null
      if (focus === null) focus = controls ? camera.position.distanceTo(controls.target) : 0
      if (sp) applySparkDof(sp, settings, focus)

      camera.updateMatrixWorld()
      let sigma = 0
      if (watch && watch.visible && settings.enabled) {
        watch.getWorldPosition(tmp).applyMatrix4(camera.matrixWorldInverse)
        gl.getDrawingBufferSize(buf)
        const focalPx = 0.5 * buf.x * camera.projectionMatrix.elements[0] * (sp?.focalAdjustment ?? 1)
        sigma = Math.min(MAX_WATCH_SIGMA_PX, cocPixels(-tmp.z, focus, settings, focalPx))
      }
      stats = { focus, watchSigma: sigma }
      if (!watch || sigma < WATCH_SHARP_SIGMA_PX) {
        gl.render(scene, camera)
        return false
      }
      const shadows = catcher && catcher.visible ? catcher : null
      if (shadows) shadows.visible = false
      try {
        renderWithoutWatchColor(gl, scene, camera, watch)
      } finally {
        if (shadows) shadows.visible = true
      }
      gl.getDrawingBufferSize(buf)
      if (shadows) blur.renderShadows(gl, scene, camera, shadows, sigma, buf)
      blur.render(gl, scene, camera, watch, sigma, buf)
      return true
    }
    const api: FrameRendererApi = { renderNow, lastStats: () => stats }
    return { api, blur }
  }, [gl, scene, camera, controls, watch, catcher, spark, dof, rig, finish, finishBlurred])
  useEffect(() => () => blur.dispose(), [blur])
  useImperativeHandle(apiRef, () => api, [api])

  useFrame(() => {
    if (exporting.current) return
    const zoom = frameAspect ? Math.min(1, size.width / frameAspect / size.height) : 1
    if (camera.zoom !== zoom) {
      camera.zoom = zoom
      camera.updateProjectionMatrix()
    }
    // While a shot plays the camera moves a little every frame; keep the splat order current.
    if (playing?.()) forceResort(spark.current)
    api.renderNow()
  }, 1)

  return null
}
