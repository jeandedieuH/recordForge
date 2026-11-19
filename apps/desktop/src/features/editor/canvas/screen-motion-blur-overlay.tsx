import { useCallback, useEffect, useRef } from "react"
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
  gl: WebGLRenderingContext
  program: WebGLProgram
  buffer: WebGLBuffer
  texture: WebGLTexture
  uVideo: WebGLUniformLocation | null
  uBlurA: WebGLUniformLocation | null
  uBlurB: WebGLUniformLocation | null
  uTaps: WebGLUniformLocation | null
  uPicRect: WebGLUniformLocation | null
}

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
  for (int i = 0; i < 24; i++) {
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
  return slots.find((slot) => slot.style.visibility === "visible") ?? slots[0] ?? null
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

function createPipeline(canvas: HTMLCanvasElement): WebGlShutterPipeline | null {
  const gl =
    canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    }) ??
    canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    })
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

  return {
    gl,
    program,
    buffer,
    texture,
    uVideo: gl.getUniformLocation(program, "u_video"),
    uBlurA: gl.getUniformLocation(program, "u_blurA"),
    uBlurB: gl.getUniformLocation(program, "u_blurB"),
    uTaps: gl.getUniformLocation(program, "u_taps"),
    uPicRect: gl.getUniformLocation(program, "u_picRect"),
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
 * Software Canvas2D fallback when WebGL is unavailable (e.g. restricted webview).
 * Caps at 7 tapered taps with additive `lighter` accumulation.
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

  const taps = Math.min(7, strip.taps)
  const rawWeights = Array.from({ length: taps }, (_, i) => motionBlurTapWeight(i, taps))
  const weightSum = rawWeights.reduce((acc, w) => acc + w, 0) || 1

  ctx.save()
  ctx.globalCompositeOperation = "source-over"
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, backingW, backingH)
  ctx.globalCompositeOperation = "lighter"
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "medium"

  for (let i = 0; i < taps; i++) {
    const t = (i + 0.5) / taps
    const sx = (strip.start[0] + (strip.end[0] - strip.start[0]) * t) * video.videoWidth
    const sy = (strip.start[1] + (strip.end[1] - strip.start[1]) * t) * video.videoHeight
    const sw = (strip.start[2] + (strip.end[2] - strip.start[2]) * t) * video.videoWidth
    const sh = (strip.start[3] + (strip.end[3] - strip.start[3]) * t) * video.videoHeight
    ctx.globalAlpha = rawWeights[i] / weightSum
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, backingW, backingH)
  }
  ctx.restore()
  return true
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
  const webglFailedRef = useRef(false)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !enabled || !strip) return
    const video = pickActiveVideo(surfaceRef.current)
    if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return
    }

    if (!webglFailedRef.current) {
      if (!pipelineRef.current) {
        pipelineRef.current = createPipeline(canvas)
        if (!pipelineRef.current) webglFailedRef.current = true
      }
      const pipe = pipelineRef.current
      if (pipe) {
        const { gl } = pipe
        if (gl.isContextLost()) return

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
          gl.useProgram(pipe.program)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, pipe.texture)
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
          gl.uniform1i(pipe.uVideo, 0)
          gl.uniform4f(pipe.uBlurA, strip.start[0], strip.start[1], strip.start[2], strip.start[3])
          gl.uniform4f(pipe.uBlurB, strip.end[0], strip.end[1], strip.end[2], strip.end[3])
          gl.uniform1i(pipe.uTaps, Math.max(3, Math.min(24, strip.taps)))
          gl.uniform4f(pipe.uPicRect, picRect[0], picRect[1], picRect[2], picRect[3])
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
          return
        } catch {
          // Cross-origin or transient video-upload failure — keep underlying video clean.
          return
        }
      }
    }

    try {
      drawCanvas2dFallback(canvas, video, strip, videoBounds)
    } catch {
      // Ignore transient draw errors when media is switching slots.
    }
  }, [enabled, strip, surfaceRef, videoBounds])

  const drawRef = useRef(draw)
  useEffect(() => {
    drawRef.current = draw
    draw()
  }, [draw])

  // Clean up WebGL objects on unmount or when Motion Blur is switched off.
  useEffect(() => {
    if (!enabled) {
      const pipe = pipelineRef.current
      if (pipe) {
        const { gl } = pipe
        gl.deleteTexture(pipe.texture)
        gl.deleteBuffer(pipe.buffer)
        gl.deleteProgram(pipe.program)
        pipelineRef.current = null
      }
      webglFailedRef.current = false
    }
    return () => {
      const pipe = pipelineRef.current
      if (pipe) {
        const { gl } = pipe
        gl.deleteTexture(pipe.texture)
        gl.deleteBuffer(pipe.buffer)
        gl.deleteProgram(pipe.program)
        pipelineRef.current = null
      }
    }
  }, [enabled])

  // Stay in lockstep with video frames while playing or scrubbing.
  useEffect(() => {
    if (!enabled) return
    const surface = surfaceRef.current
    const videos = surface ? Array.from(surface.querySelectorAll("video")) : []
    if (videos.length === 0) return

    const onFrame = () => drawRef.current()
    for (const video of videos) {
      video.addEventListener("seeked", onFrame)
      video.addEventListener("loadeddata", onFrame)
      video.addEventListener("timeupdate", onFrame)
    }

    let cancelled = false
    let frameHandle = 0
    const pump = () => {
      if (cancelled) return
      onFrame()
      const video = pickActiveVideo(surfaceRef.current)
      if (video?.requestVideoFrameCallback) {
        frameHandle = video.requestVideoFrameCallback(pump)
      }
    }
    if (pickActiveVideo(surface)?.requestVideoFrameCallback) pump()

    return () => {
      cancelled = true
      for (const video of videos) {
        video.removeEventListener("seeked", onFrame)
        video.removeEventListener("loadeddata", onFrame)
        video.removeEventListener("timeupdate", onFrame)
        video.cancelVideoFrameCallback?.(frameHandle)
      }
    }
  }, [enabled, surfaceRef])

  // Zero DOM / GPU cost when Motion Blur is disabled or timeline has no zooms.
  if (!enabled) return null

  const isActive = strip !== null

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute z-[2] overflow-hidden"
      style={{
        left: videoBounds.left,
        top: videoBounds.top,
        width: videoBounds.width,
        height: videoBounds.height,
        borderRadius,
        visibility: isActive ? "visible" : "hidden",
      }}
    />
  )
}
