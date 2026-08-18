import type { MaskClip, MaskRect } from "@recordforge/contracts"

export interface MaskShaderRenderOptions {
  canvasWidth: number
  canvasHeight: number
  playheadMs: number
  preferWebGL?: boolean
}

interface WebGLContextBundle {
  gl: WebGLRenderingContext
  program: WebGLProgram
  videoTexture: WebGLTexture
  positionBuffer: WebGLBuffer
  texCoordBuffer: WebGLBuffer
  locations: {
    aPosition: number
    aTexCoord: number
    uVideo: WebGLUniformLocation | null
    uResolution: WebGLUniformLocation | null
    uMaskCount: WebGLUniformLocation | null
    uMaskRects: WebGLUniformLocation | null
    uMaskModes: WebGLUniformLocation | null
    uPixelSizes: WebGLUniformLocation | null
    uBlurRadii: WebGLUniformLocation | null
    uRedactColors: WebGLUniformLocation | null
  }
}

const MAX_MASKS = 8

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  // Invert Y for video texture coordinates
  v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
}
`

const FRAGMENT_SHADER_SOURCE = `
precision mediump float;

uniform sampler2D u_video;
uniform vec2 u_resolution;
uniform int u_maskCount;
uniform vec4 u_maskRects[${MAX_MASKS}];
uniform int u_maskModes[${MAX_MASKS}];
uniform float u_pixelSizes[${MAX_MASKS}];
uniform float u_blurRadii[${MAX_MASKS}];
uniform vec4 u_redactColors[${MAX_MASKS}];

varying vec2 v_texCoord;

void main() {
  // Check if current fragment falls inside any active mask
  bool insideAny = false;
  vec4 finalColor = vec4(0.0);

  // Inverted Y comparison for screen-space UV
  vec2 screenUV = vec2(v_texCoord.x, 1.0 - v_texCoord.y);

  for (int i = 0; i < ${MAX_MASKS}; i++) {
    if (i >= u_maskCount) break;

    vec4 rect = u_maskRects[i];
    if (screenUV.x >= rect.x && screenUV.x <= (rect.x + rect.z) &&
        screenUV.y >= rect.y && screenUV.y <= (rect.y + rect.w)) {
      
      insideAny = true;
      int mode = u_maskModes[i];

      if (mode == 0) {
        // Redact
        finalColor = u_redactColors[i];
      } else if (mode == 2) {
        // Pixelate (Nearest Neighbor Coordinate Quantization)
        float pixelSize = max(2.0, u_pixelSizes[i]);
        vec2 stepUV = pixelSize / u_resolution;
        vec2 localUV = screenUV - rect.xy;
        vec2 quantizedScreenUV = floor(localUV / stepUV) * stepUV + rect.xy + (stepUV * 0.5);
        vec2 texUV = vec2(quantizedScreenUV.x, 1.0 - quantizedScreenUV.y);
        finalColor = texture2D(u_video, texUV);
      } else {
        // Blur (9-tap separable Gaussian / box blur approximation)
        float radius = max(1.0, u_blurRadii[i] * 0.5);
        vec2 texel = (radius / u_resolution);
        vec4 sum = vec4(0.0);
        sum += texture2D(u_video, v_texCoord + vec2(-texel.x, -texel.y)) * 0.094;
        sum += texture2D(u_video, v_texCoord + vec2(0.0, -texel.y)) * 0.118;
        sum += texture2D(u_video, v_texCoord + vec2(texel.x, -texel.y)) * 0.094;
        sum += texture2D(u_video, v_texCoord + vec2(-texel.x, 0.0)) * 0.118;
        sum += texture2D(u_video, v_texCoord) * 0.152;
        sum += texture2D(u_video, v_texCoord + vec2(texel.x, 0.0)) * 0.118;
        sum += texture2D(u_video, v_texCoord + vec2(-texel.x, texel.y)) * 0.094;
        sum += texture2D(u_video, v_texCoord + vec2(0.0, texel.y)) * 0.118;
        sum += texture2D(u_video, v_texCoord + vec2(texel.x, texel.y)) * 0.094;
        finalColor = sum;
      }
      break;
    }
  }

  if (!insideAny) {
    discard;
  } else {
    gl_FragColor = finalColor;
  }
}
`

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

function initWebGL(canvas: HTMLCanvasElement): WebGLContextBundle | null {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false })
  if (!gl) return null

  const vert = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE)
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE)
  if (!vert || !frag) return null

  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null

  const posBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer)
  // Full-screen quad in NDC
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  )

  const texBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
    gl.STATIC_DRAW,
  )

  const texture = gl.createTexture()
  if (!texture || !posBuffer || !texBuffer) return null

  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  return {
    gl,
    program,
    videoTexture: texture,
    positionBuffer: posBuffer,
    texCoordBuffer: texBuffer,
    locations: {
      aPosition: gl.getAttribLocation(program, "a_position"),
      aTexCoord: gl.getAttribLocation(program, "a_texCoord"),
      uVideo: gl.getUniformLocation(program, "u_video"),
      uResolution: gl.getUniformLocation(program, "u_resolution"),
      uMaskCount: gl.getUniformLocation(program, "u_maskCount"),
      uMaskRects: gl.getUniformLocation(program, "u_maskRects"),
      uMaskModes: gl.getUniformLocation(program, "u_maskModes"),
      uPixelSizes: gl.getUniformLocation(program, "u_pixelSizes"),
      uBlurRadii: gl.getUniformLocation(program, "u_blurRadii"),
      uRedactColors: gl.getUniformLocation(program, "u_redactColors"),
    },
  }
}

function parseHexColor(hex: string): [number, number, number, number] {
  const clean = hex.replace("#", "")
  if (clean.length === 6) {
    return [
      parseInt(clean.slice(0, 2), 16) / 255,
      parseInt(clean.slice(2, 4), 16) / 255,
      parseInt(clean.slice(4, 6), 16) / 255,
      1.0,
    ]
  }
  return [0.08, 0.09, 0.12, 1.0]
}

function isMaskActive(clip: MaskClip, playheadMs: number): boolean {
  return clip.enabled && playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs
}

function clampMaskRect(rect: MaskRect, canvasWidth: number, canvasHeight: number): MaskRect {
  const width = Math.min(Math.max(1, rect.width), canvasWidth)
  const height = Math.min(Math.max(1, rect.height), canvasHeight)
  return {
    x: Math.min(Math.max(0, rect.x), Math.max(0, canvasWidth - width)),
    y: Math.min(Math.max(0, rect.y), Math.max(0, canvasHeight - height)),
    width,
    height,
  }
}

// Global cached offscreen Canvas2D helper to avoid allocations on every frame
let sharedOffscreenCanvas: HTMLCanvasElement | null = null

/**
 * Render privacy masks on a hardware-accelerated WebGL or 2D canvas.
 */
export function renderMasksToCanvas(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement | null,
  clips: MaskClip[],
  options: MaskShaderRenderOptions,
  webglBundleRef: { current: WebGLContextBundle | null },
): void {
  const { canvasWidth, canvasHeight, playheadMs, preferWebGL = true } = options
  const activeClips = clips.filter((c) => isMaskActive(c, playheadMs))

  if (activeClips.length === 0) {
    if (webglBundleRef.current) {
      const { gl } = webglBundleRef.current
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    } else {
      const ctx = canvas.getContext("2d")
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
    return
  }

  // Check if video is playable
  const hasPlayableVideo = video && video.readyState >= 2 && video.videoWidth > 0

  // WebGL Path
  if (preferWebGL && hasPlayableVideo) {
    if (!webglBundleRef.current) {
      webglBundleRef.current = initWebGL(canvas)
    }

    if (webglBundleRef.current) {
      const { gl, program, videoTexture, positionBuffer, texCoordBuffer, locations } =
        webglBundleRef.current

      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      gl.useProgram(program)

      // Upload video frame to texture
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, videoTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
      gl.uniform1i(locations.uVideo, 0)

      gl.uniform2f(locations.uResolution, canvas.width, canvas.height)
      gl.uniform1i(locations.uMaskCount, Math.min(MAX_MASKS, activeClips.length))

      const rects = new Float32Array(MAX_MASKS * 4)
      const modes = new Int32Array(MAX_MASKS)
      const pixelSizes = new Float32Array(MAX_MASKS)
      const blurRadii = new Float32Array(MAX_MASKS)
      const redactColors = new Float32Array(MAX_MASKS * 4)

      activeClips.slice(0, MAX_MASKS).forEach((clip, i) => {
        const clamped = clampMaskRect(clip.rect, canvasWidth, canvasHeight)
        rects[i * 4 + 0] = clamped.x / canvasWidth
        rects[i * 4 + 1] = clamped.y / canvasHeight
        rects[i * 4 + 2] = clamped.width / canvasWidth
        rects[i * 4 + 3] = clamped.height / canvasHeight

        modes[i] = clip.mode === "redact" ? 0 : clip.mode === "blur" ? 1 : 2
        pixelSizes[i] = clip.pixelSize ?? 16
        blurRadii[i] = clip.blurRadius ?? 16

        const [r, g, b, a] = parseHexColor(clip.redactColor ?? "#141820")
        redactColors[i * 4 + 0] = r
        redactColors[i * 4 + 1] = g
        redactColors[i * 4 + 2] = b
        redactColors[i * 4 + 3] = a
      })

      gl.uniform4fv(locations.uMaskRects, rects)
      gl.uniform1iv(locations.uMaskModes, modes)
      gl.uniform1fv(locations.uPixelSizes, pixelSizes)
      gl.uniform1fv(locations.uBlurRadii, blurRadii)
      gl.uniform4fv(locations.uRedactColors, redactColors)

      // Bind positions
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
      gl.enableVertexAttribArray(locations.aPosition)
      gl.vertexAttribPointer(locations.aPosition, 2, gl.FLOAT, false, 0, 0)

      // Bind texCoords
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer)
      gl.enableVertexAttribArray(locations.aTexCoord)
      gl.vertexAttribPointer(locations.aTexCoord, 2, gl.FLOAT, false, 0, 0)

      gl.drawArrays(gl.TRIANGLES, 0, 6)
      return
    }
  }

  // Fallback: Canvas2D Fast Blit
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const scaleX = canvas.width / Math.max(1, canvasWidth)
  const scaleY = canvas.height / Math.max(1, canvasHeight)

  for (const clip of activeClips) {
    const clamped = clampMaskRect(clip.rect, canvasWidth, canvasHeight)
    const dx = clamped.x * scaleX
    const dy = clamped.y * scaleY
    const dw = clamped.width * scaleX
    const dh = clamped.height * scaleY

    if (clip.mode === "redact") {
      ctx.fillStyle = clip.redactColor ?? "#141820"
      ctx.fillRect(dx, dy, dw, dh)
      continue
    }

    if (!hasPlayableVideo) {
      // Placeholder visual when video is paused or loading
      ctx.fillStyle = "rgba(20, 24, 32, 0.4)"
      ctx.fillRect(dx, dy, dw, dh)
      continue
    }

    // Video coordinates
    const sx = (clamped.x / canvasWidth) * video.videoWidth
    const sy = (clamped.y / canvasHeight) * video.videoHeight
    const sw = (clamped.width / canvasWidth) * video.videoWidth
    const sh = (clamped.height / canvasHeight) * video.videoHeight

    if (!sharedOffscreenCanvas) {
      sharedOffscreenCanvas = document.createElement("canvas")
    }

    if (clip.mode === "pixelate") {
      const pixelSize = Math.max(2, clip.pixelSize ?? 16)
      const tinyW = Math.max(1, Math.floor(dw / pixelSize))
      const tinyH = Math.max(1, Math.floor(dh / pixelSize))

      sharedOffscreenCanvas.width = tinyW
      sharedOffscreenCanvas.height = tinyH
      const offCtx = sharedOffscreenCanvas.getContext("2d")
      if (offCtx) {
        offCtx.imageSmoothingEnabled = false
        offCtx.drawImage(video, sx, sy, sw, sh, 0, 0, tinyW, tinyH)

        ctx.imageSmoothingEnabled = false
        ctx.drawImage(sharedOffscreenCanvas, 0, 0, tinyW, tinyH, dx, dy, dw, dh)
        ctx.imageSmoothingEnabled = true
      }
    } else {
      // Blur
      const downscale = Math.max(2, Math.min(8, (clip.blurRadius ?? 16) / 4))
      const tinyW = Math.max(1, Math.floor(dw / downscale))
      const tinyH = Math.max(1, Math.floor(dh / downscale))

      sharedOffscreenCanvas.width = tinyW
      sharedOffscreenCanvas.height = tinyH
      const offCtx = sharedOffscreenCanvas.getContext("2d")
      if (offCtx) {
        offCtx.imageSmoothingEnabled = true
        offCtx.drawImage(video, sx, sy, sw, sh, 0, 0, tinyW, tinyH)

        ctx.imageSmoothingEnabled = true
        ctx.drawImage(sharedOffscreenCanvas, 0, 0, tinyW, tinyH, dx, dy, dw, dh)
      }
    }
  }
}
