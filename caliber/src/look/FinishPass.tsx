import { useEffect, useImperativeHandle, useMemo, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { WATCH_LAYER, hasVisibleMesh, markWatchLayer } from './watchLayer'

export interface FinishPassApi {
  /** Post-process whatever is currently on the canvas (call right after the frame is rendered). */
  apply: (timeSeconds?: number) => void
}

export interface FinishPassProps {
  /** Watch root: its silhouette drives edge softening and light wrap. */
  watch: THREE.Object3D | null
  /** Master switch. Default true. */
  enabled?: boolean
  /** Film grain amplitude in display units (0..~0.06). 0 = off. Default 0.025. */
  grain?: number
  /** 0..1 blend of a small blur onto the watch's silhouette pixels (the canvas has no MSAA). Default 0.7. */
  edgeSoften?: number
  /** 0..1 strength of background light wrapping over the watch's edges. 0 = off. Default 0.35. */
  lightWrap?: number
  /** Light-wrap reach in drawing-buffer pixels. Default 6. */
  wrapRadius?: number
  /**
   * Run automatically each frame at useFrame priority 2 (after FrameRenderer's 1). Default true.
   * Set false and call apiRef.apply() yourself (e.g. from the export path).
   */
  auto?: boolean
  apiRef?: Ref<FinishPassApi>
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`

// tFrame: the finished, display-referred canvas. tMask: watch silhouette (r = 1 inside).
const FRAG = /* glsl */ `
uniform sampler2D tFrame;
uniform sampler2D tMask;
uniform vec2 texel;
uniform float grain;
uniform float soften;
uniform float wrap;
uniform float wrapRadius;
uniform float seed;
uniform bool useMask;
varying vec2 vUv;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 c = texture2D(tFrame, vUv).rgb;
  if (useMask) {
    float m = texture2D(tMask, vUv).r;
    // 1-px neighborhood: silhouette detection + small blur.
    float m4 = 0.0;
    vec3 b = c * 4.0;
    float wsum = 4.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      vec2 o = vec2(cos(a), sin(a)) * texel * 1.2;
      m4 += texture2D(tMask, vUv + o).r;
      b += texture2D(tFrame, vUv + o).rgb;
      wsum += 1.0;
    }
    m4 = (m4 + m) / 9.0;
    float edge = 1.0 - abs(2.0 * m4 - 1.0);
    c = mix(c, b / wsum, clamp(edge * soften, 0.0, 1.0));

    // Light wrap: inside the watch near its silhouette, bleed in the surrounding background.
    if (wrap > 0.0 && m > 0.01) {
      vec3 bg = vec3(0.0);
      float bgw = 0.0;
      float cover = 0.0;
      for (int r = 1; r <= 3; r++) {
        float rad = wrapRadius * float(r) / 3.0;
        for (int i = 0; i < 12; i++) {
          float a = (float(i) + 0.5 * float(r)) * 0.523599;
          vec2 o = vec2(cos(a), sin(a)) * texel * rad;
          float mm = texture2D(tMask, vUv + o).r;
          float w = (1.0 - mm) / float(r);
          bg += texture2D(tFrame, vUv + o).rgb * w;
          bgw += w;
          cover += 1.0 / float(r);
        }
      }
      if (bgw > 1e-3) {
        float k = wrap * m * (bgw / cover);
        // Screen-style: light from behind brightens edges; dark backgrounds barely change them.
        vec3 wrapped = 1.0 - (1.0 - c) * (1.0 - bg / bgw * 0.8);
        c = mix(c, wrapped, clamp(k, 0.0, 1.0));
      }
    }
  }
  if (grain > 0.0) {
    float n = hash(gl_FragCoord.xy + seed * 97.0) + hash(gl_FragCoord.xy * 1.37 + seed * 61.0) - 1.0;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Strongest in midtones, like film/sensor noise.
    c += n * grain * (0.35 + 2.6 * l * (1.0 - l));
  }
  gl_FragColor = vec4(c, 1.0);
}`

/**
 * Final-frame unifying pass in plain three.js (no postprocessing dependency): copies the finished
 * canvas into a texture, then redraws it with (a) slight softening of the watch's aliased
 * silhouette, (b) light wrap of the background over the watch's edges, (c) fine film grain over
 * everything. Works on top of any renderer (FrameRenderer included) because it reads the canvas.
 */
export function FinishPass({
  watch,
  enabled = true,
  grain = 0.025,
  edgeSoften = 0.7,
  lightWrap = 0.35,
  wrapRadius = 6,
  auto = true,
  apiRef,
}: FinishPassProps) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)

  const r = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tFrame: { value: null },
        tMask: { value: null },
        texel: { value: new THREE.Vector2() },
        grain: { value: 0 },
        soften: { value: 0 },
        wrap: { value: 0 },
        wrapRadius: { value: 6 },
        seed: { value: 0 },
        useMask: { value: false },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
    const maskCam = new THREE.PerspectiveCamera()
    maskCam.layers.set(WATCH_LAYER)
    return {
      mat,
      white,
      maskCam,
      quad: new FullScreenQuad(mat),
      frame: null as THREE.FramebufferTexture | null,
      mask: new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType }),
      size: new THREE.Vector2(),
      clear: new THREE.Color(),
      zero: new THREE.Vector2(0, 0),
      frameNo: 0,
    }
  }, [])
  useEffect(
    () => () => {
      r.mat.dispose()
      r.white.dispose()
      r.quad.dispose()
      r.frame?.dispose()
      r.mask.dispose()
    },
    [r],
  )

  const api = useMemo<FinishPassApi>(
    () => ({
      apply: (timeSeconds) => {
        if (!enabled) return
        const useMask = !!watch && hasVisibleMesh(watch) && (edgeSoften > 0 || lightWrap > 0)
        if (grain <= 0 && !useMask) return
        gl.getDrawingBufferSize(r.size)
        const w = Math.max(1, Math.floor(r.size.x))
        const h = Math.max(1, Math.floor(r.size.y))
        if (!r.frame || r.frame.image.width !== w || r.frame.image.height !== h) {
          r.frame?.dispose()
          r.frame = new THREE.FramebufferTexture(w, h)
          r.frame.minFilter = THREE.LinearFilter
          r.frame.magFilter = THREE.LinearFilter
        }
        const prevTarget = gl.getRenderTarget()
        gl.setRenderTarget(null)
        gl.copyFramebufferToTexture(r.frame, r.zero)

        if (useMask) {
          markWatchLayer(watch)
          if (r.mask.width !== w || r.mask.height !== h) r.mask.setSize(w, h)
          const cam = camera as THREE.PerspectiveCamera
          r.maskCam.copy(cam, false)
          r.maskCam.layers.set(WATCH_LAYER)
          r.maskCam.updateMatrixWorld()
          const prevOverride = scene.overrideMaterial
          const prevBg = scene.background
          const prevAuto = gl.shadowMap.autoUpdate
          const prevAlpha = gl.getClearAlpha()
          gl.getClearColor(r.clear)
          scene.overrideMaterial = r.white
          scene.background = null
          const prevNeeds = gl.shadowMap.needsUpdate
          gl.shadowMap.autoUpdate = false
          gl.shadowMap.needsUpdate = false // never re-render the key shadow map from this side pass
          gl.setClearColor(0x000000, 0)
          gl.setRenderTarget(r.mask)
          gl.clear()
          gl.render(scene, r.maskCam)
          scene.overrideMaterial = prevOverride
          scene.background = prevBg
          gl.shadowMap.autoUpdate = prevAuto
          gl.shadowMap.needsUpdate = prevNeeds
          gl.setClearColor(r.clear, prevAlpha)
        }

        const u = r.mat.uniforms
        u.tFrame.value = r.frame
        u.tMask.value = r.mask.texture
        u.useMask.value = useMask
        u.texel.value.set(1 / w, 1 / h)
        u.grain.value = grain
        u.soften.value = edgeSoften
        u.wrap.value = lightWrap
        u.wrapRadius.value = wrapRadius
        u.seed.value = timeSeconds !== undefined ? (timeSeconds * 24) % 997 : r.frameNo++ % 997
        gl.setRenderTarget(null)
        const prevAutoClear = gl.autoClear
        gl.autoClear = false
        r.quad.render(gl)
        gl.autoClear = prevAutoClear
        gl.setRenderTarget(prevTarget)
      },
    }),
    [gl, scene, camera, watch, enabled, grain, edgeSoften, lightWrap, wrapRadius, r],
  )
  useImperativeHandle(apiRef, () => api, [api])

  useFrame(() => {
    if (auto) api.apply()
  }, 2)

  return null
}
