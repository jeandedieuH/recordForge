import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { motionBlurTapWeight, type ScreenMotionBlurStrip } from "@recordforge/editor-core"
import type { PlaybackVideoBounds } from "./playback-overlays"

export interface ScreenMotionBlurOverlayProps {
  /** Whether zoom or pan motion blur is enabled on a timeline with zoom shots. */
  enabled: boolean
  /** Active per-frame shutter strip (`null` when frame is still or zoom-framing). */
  strip: ScreenMotionBlurStrip | null
  /** Wrapper around the screen's A/B video slots. */
  surfaceRef: React.RefObject<HTMLDivElement | null>
  videoBounds: PlaybackVideoBounds
  borderRadius?: number | string
}

interface WebGlShutterPipeline {
  canvas: HTMLCanvasElement
  gl: WebGLRenderingContext
  program: WebGLProgram
  buffer: WebGLBuffer
  texture: WebGLTexture
  uVideo: WebGLUniformLocation | null
  uBlurA: WebGLUniformLocation | null
  uBlurB: WebGLUniformLocation | null
  uTaps: WebGLUniformLocation | null
  uPicRect: WebGLUniformLocation | null
  cleanup?: () => void
}

type RenderBackend = "webgl" | "canvas2d"

const MAX_SHADER_TAPS = 32
const MAX_WEBGL_ERRORS = 3

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

// Mirrors apps/desktop/src-tauri/src/exports/gpu/shaders/composite.wgsl:
// midpoint quadrature across [u_blurA, u_blurB] with tapered shutter weights
// (0.45 + 0.55 * sin(PI * t)) and letterbox-safe clamping.
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_video;
uniform vec4 u_blurA;
uniform vec4 u_blurB;
uniform int u_taps;
uniform vec4 u_picRect;

void main() {
  vec4 acc = vec4(0.0);
  float wSum = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= u_taps) break;
    float t = (float(i) + 0.5) / float(u_taps);
    float w = 0.45 + 0.55 * sin(t * 3.14159265);
    vec4 crop = mix(u_blurA, u_blurB, t);
    vec2 contentUv = clamp(crop.xy + v_uv * crop.zw, vec2(0.0), vec2(1.0));
    vec2 picUv = (contentUv - u_picRect.xy) / max(u_picRect.zw, vec2(0.0001));
    if (picUv.x >= 0.0 && picUv.x <= 1.0 && picUv.y >= 0.0 && picUv.y <= 1.0) {
      vec3 rgb = texture2D(u_video, picUv).rgb;
      acc += vec4(rgb, 1.0) * w;
    }
    wSum += w;
  }
  vec4 outColor = acc / max(wSum, 0.0001);
  gl_FragColor = outColor;
}
`

/** Pick the currently visible A/B video slot (the hidden one is the pre-seeked standby). */
function pickActiveVideo(surface: HTMLDivElement | null): HTMLVideoElement | null {
  if (!surface) return null
  const slots = Array.from(surface.querySelectorAll("video"))
  const visible = slots.filter((slot) => slot.style.visibility === "visible")
  return (
    visible.find((slot) => slot.readyState >= 2 && slot.videoWidth > 0) ??
    slots.find((slot) => slot.readyState >= 2 && slot.videoWidth > 0) ??
    visible[0] ??
    slots[0] ??
    null
  )
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function createPipeline(
  canvas: HTMLCanvasElement,
  onContextLost: () => void,
): WebGlShutterPipeline | null {
  // preserveDrawingBuffer keeps paused, scrubbed, and slider-tuned frames intact across repaints.
  const contextOptions: WebGLContextAttributes = {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  }
  const gl =
    canvas.getContext("webgl2", contextOptions) ?? canvas.getContext("webgl", contextOptions)
  if (!gl) return null

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs)
    if (fs) gl.deleteShader(fs)
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return null
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }

  const buffer = gl.createBuffer()
  const texture = gl.createTexture()
  if (!buffer || !texture) {
    if (buffer) gl.deleteBuffer(buffer)
    if (texture) gl.deleteTexture(texture)
    gl.deleteProgram(program)
    return null
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  gl.useProgram(program)
  const posLoc = gl.getAttribLocation(program, "a_pos")
  gl.enableVertexAttribArray(posLoc)
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

  const handleContextLost = (event: Event) => {
    event.preventDefault()
    onContextLost()
  }
  canvas.addEventListener("webglcontextlost", handleContextLost)

  return {
    canvas,
    gl,
    program,
    buffer,
    texture,
    uVideo: gl.getUniformLocation(program, "u_video"),
    uBlurA: gl.getUniformLocation(program, "u_blurA"),
    uBlurB: gl.getUniformLocation(program, "u_blurB"),
    uTaps: gl.getUniformLocation(program, "u_taps"),
    uPicRect: gl.getUniformLocation(program, "u_picRect"),
    cleanup: () => canvas.removeEventListener("webglcontextlost", handleContextLost),
  }
}

/** Normalized letterbox picture rect of an `object-contain` `<video>` inside its box. */
function normalizedPictureRect(
  video: HTMLVideoElement,
  bounds: PlaybackVideoBounds,
): [number, number, number, number] {
  const elW = Math.max(1, video.clientWidth || bounds.width)
  const elH = Math.max(1, video.clientHeight || bounds.height)
  const fit = Math.min(elW / Math.max(1, video.videoWidth), elH / Math.max(1, video.videoHeight))
  const picW = video.videoWidth * fit
  const picH = video.videoHeight * fit
  const picX = (elW - picW) * 0.5
  const picY = (elH - picH) * 0.5
  return [picX / elW, picY / elH, picW / elW, picH / elH]
}

/**
 * Software Canvas2D fallback when WebGL is unavailable or fails video upload.
 * Mounted on a fresh `<canvas key="canvas2d">` so WebGL context locks never block
 * `getContext("2d")`, using exact cumulative `source-over` weighted blending and
 * letterbox-aware source mapping.
 */
function drawCanvas2dFallback(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  strip: ScreenMotionBlurStrip,
  bounds: PlaybackVideoBounds,
): boolean {
  const ctx = canvas.getContext("2d")
  if (!ctx) return false

  const ratio = Math.min(1.5, window.devicePixelRatio || 1)
  const backingW = Math.max(2, Math.round(bounds.width * ratio))
  const backingH = Math.max(2, Math.round(bounds.height * ratio))
  if (canvas.width !== backingW || canvas.height !== backingH) {
    canvas.width = backingW
    canvas.height = backingH
  }

  const [px, py, pw, ph] = normalizedPictureRect(video, bounds)
  const taps = Math.max(3, Math.min(12, strip.taps))

  ctx.save()
  ctx.globalCompositeOperation = "source-over"
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, backingW, backingH)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "medium"

  let weightSum = 0
  let drewAny = false
  for (let i = 0; i < taps; i++) {
    const t = (i + 0.5) / taps
    const cx = strip.start[0] + (strip.end[0] - strip.start[0]) * t
    const cy = strip.start[1] + (strip.end[1] - strip.start[1]) * t
    const cw = Math.max(0.0001, strip.start[2] + (strip.end[2] - strip.start[2]) * t)
    const ch = Math.max(0.0001, strip.start[3] + (strip.end[3] - strip.start[3]) * t)

    const ix0 = Math.max(cx, px)
    const iy0 = Math.max(cy, py)
    const ix1 = Math.min(cx + cw, px + pw)
    const iy1 = Math.min(cy + ch, py + ph)
    if (ix1 <= ix0 || iy1 <= iy0) continue

    const w = motionBlurTapWeight(i, taps)
    weightSum += w
    // Cumulative source-over alpha (w_i / sum_{0..i} w) yields exact normalized linear weights.
    ctx.globalAlpha = !drewAny ? 1 : w / weightSum
    drewAny = true

    const sx = ((ix0 - px) / Math.max(0.0001, pw)) * video.videoWidth
    const sy = ((iy0 - py) / Math.max(0.0001, ph)) * video.videoHeight
    const sw = ((ix1 - ix0) / Math.max(0.0001, pw)) * video.videoWidth
    const sh = ((iy1 - iy0) / Math.max(0.0001, ph)) * video.videoHeight
    const dx = ((ix0 - cx) / cw) * backingW
    const dy = ((iy0 - cy) / ch) * backingH
    const dw = ((ix1 - ix0) / cw) * backingW
    const dh = ((iy1 - iy0) / ch) * backingH
    ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh)
  }
  ctx.restore()
  return drewAny
}

/**
 * Real-time GPU shutter-strip preview for Zoom & Pan motion blur.
 *
 * Samples the active `<video>` slot along the exact continuous `[start, end]`
 * shutter strip and tapered weights used by `composite.wgsl` in export. Because
 * the strip is deterministic at any timestamp, motion blur renders accurately
 * while playing, scrubbing, and paused (so adjusting sliders updates live).
 *
 * Drawing stays purely imperative via canvas refs: raw video frames never touch
 * React state.
 */
export function ScreenMotionBlurOverlay({
  enabled,
  strip,
  surfaceRef,
  videoBounds,
  borderRadius,
}: ScreenMotionBlurOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pipelineRef = useRef<WebGlShutterPipeline | null>(null)
  const webglFailuresRef = useRef(0)
  const webglWarnedRef = useRef(false)
  const wasEnabledRef = useRef(enabled)
  const [renderBackend, setRenderBackend] = useState<RenderBackend>("webgl")

  const isActive = strip !== null

  const disposePipeline = useCallback(() => {
    const pipe = pipelineRef.current
    if (!pipe) return
    pipe.cleanup?.()
    const { gl } = pipe
    gl.deleteTexture(pipe.texture)
    gl.deleteBuffer(pipe.buffer)
    gl.deleteProgram(pipe.program)
    pipelineRef.current = null
  }, [])

  const switchToCanvas2d = useCallback(
    (reason: string) => {
      if (!webglWarnedRef.current) {
        webglWarnedRef.current = true
        console.warn(`Screen motion blur switching to Canvas2D fallback: ${reason}`)
      }
      disposePipeline()
      setRenderBackend("canvas2d")
    },
    [disposePipeline],
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!enabled || !strip) {
      canvas.style.opacity = "0"
      return
    }
    const video = pickActiveVideo(surfaceRef.current)
    if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      canvas.style.opacity = "0"
      return
    }

    if (renderBackend === "webgl") {
      if (!pipelineRef.current || pipelineRef.current.canvas !== canvas) {
        disposePipeline()
        pipelineRef.current = createPipeline(canvas, () => switchToCanvas2d("WebGL context lost"))
        if (!pipelineRef.current) {
          switchToCanvas2d("WebGL context unavailable")
          return
        }
      }
      const pipe = pipelineRef.current
      const { gl } = pipe
      if (gl.isContextLost()) {
        switchToCanvas2d("WebGL context lost")
        return
      }

      // Cap preview backing store at 1920px on the long edge so 4K monitors
      // maintain 60fps during multi-tap playback.
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const rawW = Math.max(2, Math.round(videoBounds.width * dpr))
      const rawH = Math.max(2, Math.round(videoBounds.height * dpr))
      const capScale = Math.min(1, 1920 / Math.max(rawW, rawH))
      const backingW = Math.max(2, Math.round(rawW * capScale))
      const backingH = Math.max(2, Math.round(rawH * capScale))
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW
        canvas.height = backingH
      }

      const picRect = normalizedPictureRect(video, videoBounds)
      try {
        gl.viewport(0, 0, backingW, backingH)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.useProgram(pipe.program)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, pipe.texture)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
        gl.uniform1i(pipe.uVideo, 0)
        gl.uniform4f(pipe.uBlurA, strip.start[0], strip.start[1], strip.start[2], strip.start[3])
        gl.uniform4f(pipe.uBlurB, strip.end[0], strip.end[1], strip.end[2], strip.end[3])
        gl.uniform1i(pipe.uTaps, Math.max(3, Math.min(MAX_SHADER_TAPS, strip.taps)))
        gl.uniform4f(pipe.uPicRect, picRect[0], picRect[1], picRect[2], picRect[3])
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

        const glErr = typeof gl.getError === "function" ? gl.getError() : gl.NO_ERROR
        if (glErr !== undefined && glErr !== gl.NO_ERROR) {
          webglFailuresRef.current += 1
          if (webglFailuresRef.current >= MAX_WEBGL_ERRORS) {
            switchToCanvas2d(`WebGL error code ${glErr}`)
          }
          return
        }
        webglFailuresRef.current = 0
        canvas.style.opacity = "1"
        return
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        switchToCanvas2d(`video texture upload failed (${message})`)
        return
      }
    }

    try {
      const drew = drawCanvas2dFallback(canvas, video, strip, videoBounds)
      canvas.style.opacity = drew ? "1" : "0"
    } catch {
      canvas.style.opacity = "0"
    }
  }, [enabled, strip, surfaceRef, videoBounds, renderBackend, disposePipeline, switchToCanvas2d])

  const drawRef = useRef(draw)
  useLayoutEffect(() => {
    drawRef.current = draw
    draw()
  }, [draw])

  // Reset backend to WebGL only when re-enabling after being disabled, and clean up GPU state.
  useEffect(() => {
    if (enabled && !wasEnabledRef.current) {
      webglFailuresRef.current = 0
      webglWarnedRef.current = false
      setRenderBackend("webgl")
    }
    wasEnabledRef.current = enabled
    if (!enabled) {
      disposePipeline()
    }
    return () => {
      disposePipeline()
    }
  }, [enabled, disposePipeline])

  // Stay in lockstep with video frames while playing, seeking, or swapping A/B slots.
  useEffect(() => {
    if (!enabled || !isActive) return
    const surface = surfaceRef.current
    const videos = surface ? Array.from(surface.querySelectorAll("video")) : []
    if (videos.length === 0) return

    const onFrame = () => drawRef.current()
    for (const video of videos) {
      video.addEventListener("seeked", onFrame)
      video.addEventListener("loadeddata", onFrame)
      video.addEventListener("canplay", onFrame)
      video.addEventListener("playing", onFrame)
      video.addEventListener("timeupdate", onFrame)
    }

    let cancelled = false
    let rafId = 0
    const tick = () => {
      if (cancelled) return
      const active = pickActiveVideo(surfaceRef.current)
      if (active && (!active.paused || active.seeking)) {
        drawRef.current()
      }
      rafId = window.requestAnimationFrame(tick)
    }
    rafId = window.requestAnimationFrame(tick)

    return () => {
      cancelled = true
      window.cancelAnimationFrame(rafId)
      for (const video of videos) {
        video.removeEventListener("seeked", onFrame)
        video.removeEventListener("loadeddata", onFrame)
        video.removeEventListener("canplay", onFrame)
        video.removeEventListener("playing", onFrame)
        video.removeEventListener("timeupdate", onFrame)
      }
    }
  }, [enabled, isActive, surfaceRef, videoBounds, renderBackend])

  // Zero DOM / GPU cost when Motion Blur is disabled or timeline has no zooms.
  if (!enabled) return null

  return (
    <canvas
      key={renderBackend}
      ref={canvasRef}
      aria-hidden
      data-blur-backend={renderBackend}
      className="pointer-events-none absolute z-[2] overflow-hidden"
      style={{
        left: videoBounds.left,
        top: videoBounds.top,
        width: videoBounds.width,
        height: videoBounds.height,
        borderRadius,
        visibility: isActive ? "visible" : "hidden",
        opacity: 0,
      }}
    />
  )
}
