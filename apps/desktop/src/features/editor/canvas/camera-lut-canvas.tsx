import { useEffect, useRef } from "react"
import type { CameraColor, CameraCutout } from "@recordforge/contracts"
import { composeCameraLut } from "@recordforge/overlay-core"
import {
  FULL_FRAME_CROP,
  backgroundCoverUv,
  cutoutBlurUv,
  matteShrinkShift,
  parseCutoutColor,
  type NormalizedCrop,
} from "./camera-cutout"

// WebGL2 camera effects preview (#4a colour, #4b cutout).
//
// The LUT comes from the shared Rust engine (WASM) — exactly the table the
// export writes as a `.cube` — and is uploaded as an RGBA8 3D texture. Cutout
// takes the synthetic matte the export consumes and composites it with the same
// alpha math: `edgeShrink` shifts the matte luma and the background is
// transparent, blurred, a colour, or a cover-fitted image. The canvas draws at
// source resolution and is stretched to the bubble with the same crop the CSS
// preview uses, so grading and framing stay aligned.

const VERTEX_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_video;
uniform sampler2D u_matte;
uniform sampler2D u_bg_image;
uniform highp sampler3D u_lut;
uniform vec4 u_crop;
uniform vec4 u_bg_fit;
uniform vec2 u_blur_uv;
uniform vec3 u_bg_color;
uniform int u_bg_mode;
uniform bool u_has_matte;
uniform bool u_has_bg_image;
uniform bool u_has_lut;
uniform float u_edge_softness;
uniform float u_edge_shift;
out vec4 out_color;

vec2 src_uv(vec2 top_left) {
  return vec2(top_left.x, 1.0 - top_left.y);
}

vec3 grade(vec3 color) {
  if (!u_has_lut) return color;
  float size = 33.0;
  vec3 scale = vec3((size - 1.0) / size);
  float offset = 1.0 / (2.0 * size);
  return texture(u_lut, color * scale + offset).rgb;
}

vec3 sample_frame(vec2 top_left) {
  return texture(u_video, src_uv(top_left)).rgb;
}

float matte_at(vec2 top_left) {
  return texture(u_matte, src_uv(top_left)).r;
}

void main() {
  vec2 top_left = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 uv = u_crop.xy + top_left * u_crop.zw;
  vec3 foreground = grade(clamp(sample_frame(uv), 0.0, 1.0));
  float alpha = 1.0;
  if (u_has_matte) {
    if (u_edge_softness > 0.2) {
      // Approximation of the renderer's two-pass box blur on the matte.
      vec2 texel = vec2(u_edge_softness) / vec2(textureSize(u_matte, 0));
      alpha = (
        matte_at(uv) +
        matte_at(uv + vec2(texel.x, 0.0)) +
        matte_at(uv - vec2(texel.x, 0.0)) +
        matte_at(uv + vec2(0.0, texel.y)) +
        matte_at(uv - vec2(0.0, texel.y))
      ) / 5.0;
    } else {
      alpha = matte_at(uv);
    }
    alpha = clamp((alpha - u_edge_shift) * 1.04, 0.0, 1.0);
  }
  if (!u_has_matte || u_bg_mode == 0) {
    out_color = vec4(foreground, alpha);
    return;
  }
  vec3 background = vec3(0.0);
  bool has_background = true;
  if (u_bg_mode == 1) {
    // 9-tap disc blur of the camera itself, graded once after averaging.
    vec3 sum = sample_frame(uv);
    for (int i = 0; i < 8; i++) {
      float angle = float(i) * 0.7853981634;
      vec2 offset = vec2(cos(angle), sin(angle)) * u_blur_uv;
      sum += sample_frame(uv + offset);
    }
    background = grade(clamp(sum / 9.0, 0.0, 1.0));
  } else if (u_bg_mode == 2) {
    background = u_bg_color;
  } else if (u_bg_mode == 3 && u_has_bg_image) {
    // top_left is [0,1] inside the visible crop, so the image fills the bubble
    // exactly like the renderer's cover-fit plate.
    vec2 image_uv = (top_left - vec2(0.5)) * u_bg_fit.xy + vec2(0.5) + u_bg_fit.zw;
    background = texture(u_bg_image, src_uv(image_uv)).rgb;
  } else {
    // Image mode without a usable image falls back to a transparent cutout,
    // matching the exporter's missing-asset behaviour.
    has_background = false;
  }
  if (!has_background) {
    out_color = vec4(foreground, alpha);
    return;
  }
  out_color = vec4(mix(background, foreground, alpha), alpha);
}`

const BACKGROUND_MODE = { none: 0, blur: 1, color: 2, image: 3 } as const

interface CameraLutCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** Synthetic matte video for the same source time (cutout only). */
  matteVideoRef?: React.RefObject<HTMLVideoElement | null>
  matteEnabled?: boolean
  color: CameraColor
  cubeText?: string | null
  /** Source-space crop as normalized top-left x/y/width/height. */
  crop?: NormalizedCrop | null
  cutout?: CameraCutout | null
  /** Cover-fitted background image URL when `cutout.background === "image"`. */
  backgroundImageUrl?: string | null
  /** Camera bubble size in canvas px, used to scale the blur radius. */
  displayWidth?: number
  displayHeight?: number
  className?: string
}

export function CameraLutCanvas({
  videoRef,
  matteVideoRef,
  matteEnabled = false,
  color,
  cubeText,
  crop,
  cutout,
  backgroundImageUrl,
  displayWidth = 1,
  displayHeight = 1,
  className,
}: CameraLutCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glRef = useRef<WebGL2RenderingContext | null>(null)
  const programRef = useRef<WebGLProgram | null>(null)
  const uniformsRef = useRef<Record<string, WebGLUniformLocation | null>>({})
  const videoTextureRef = useRef<WebGLTexture | null>(null)
  const lutTextureRef = useRef<WebGLTexture | null>(null)
  const matteTextureRef = useRef<WebGLTexture | null>(null)
  const bgTextureRef = useRef<WebGLTexture | null>(null)
  const bgReadyRef = useRef(false)
  const bgImageAspectRef = useRef(1)
  const lutReadyRef = useRef(false)
  const cropRef = useRef<[number, number, number, number]>([0, 0, 1, 1])

  const activeCrop = crop ?? FULL_FRAME_CROP
  cropRef.current = [activeCrop.x, activeCrop.y, activeCrop.width, activeCrop.height]

  const cutoutActive = Boolean(cutout?.enabled)
  const mode = cutoutActive ? BACKGROUND_MODE[cutout?.background ?? "none"] : 0
  const settingsRef = useRef({
    matteEnabled: false,
    mode: 0,
    blurUv: [0, 0] as readonly [number, number],
    edgeSoftness: 0,
    edgeShift: 0,
    bgColor: parseCutoutColor(undefined),
  })
  settingsRef.current = {
    matteEnabled: matteEnabled && cutoutActive,
    mode,
    blurUv: cutoutBlurUv(cutout?.blurRadius ?? 18, activeCrop, displayWidth, displayHeight),
    edgeSoftness: Math.max(0, Math.min(16, cutout?.edgeSoftness ?? 2)),
    edgeShift: matteShrinkShift(cutout?.edgeShrink ?? 0),
    bgColor: parseCutoutColor(cutout?.color),
  }

  // Build the GL pipeline once.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Alpha stays enabled so a cutout can reveal the screen behind it; opaque
    // frames write alpha 1 and composite exactly as before.
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false })
    if (!gl) return
    glRef.current = gl

    const compile = (type: number, source: string) => {
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
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SOURCE)
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE)
    if (!vertex || !fragment) return
    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return
    programRef.current = program
    for (const name of [
      "u_video",
      "u_matte",
      "u_bg_image",
      "u_lut",
      "u_crop",
      "u_bg_fit",
      "u_blur_uv",
      "u_bg_color",
      "u_bg_mode",
      "u_has_matte",
      "u_has_bg_image",
      "u_has_lut",
      "u_edge_softness",
      "u_edge_shift",
    ]) {
      uniformsRef.current[name] = gl.getUniformLocation(program, name)
    }

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, "a_position")
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.useProgram(program)

    const createTexture = (target: number) => {
      const texture = gl.createTexture()
      gl.bindTexture(target, texture)
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      if (target === gl.TEXTURE_3D) {
        gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
      }
      return texture
    }

    videoTextureRef.current = createTexture(gl.TEXTURE_2D)
    matteTextureRef.current = createTexture(gl.TEXTURE_2D)
    bgTextureRef.current = createTexture(gl.TEXTURE_2D)
    lutTextureRef.current = createTexture(gl.TEXTURE_3D)

    return () => {
      gl.deleteProgram(program)
      for (const texture of [
        videoTextureRef.current,
        matteTextureRef.current,
        bgTextureRef.current,
        lutTextureRef.current,
      ]) {
        if (texture) gl.deleteTexture(texture)
      }
      programRef.current = null
      videoTextureRef.current = null
      matteTextureRef.current = null
      bgTextureRef.current = null
      lutTextureRef.current = null
      uniformsRef.current = {}
      glRef.current = null
    }
  }, [])

  // Compose/upload the LUT when the grade changes.
  useEffect(() => {
    const gl = glRef.current
    const texture = lutTextureRef.current
    if (!gl || !texture) return
    let cancelled = false
    // Sampling a 3D texture with no storage returns black; keep the pass-through
    // path until the composed table is uploaded.
    lutReadyRef.current = false
    void composeCameraLut({ color, cubeText: cubeText ?? undefined })
      .then((lut) => {
        if (cancelled || !glRef.current) return
        gl.bindTexture(gl.TEXTURE_3D, texture)
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
        gl.texImage3D(
          gl.TEXTURE_3D,
          0,
          gl.RGBA8,
          lut.size,
          lut.size,
          lut.size,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          lut.data,
        )
        lutReadyRef.current = true
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [color, cubeText])

  // Upload the cutout background image whenever the URL changes. Fetching the
  // bytes avoids a cross-origin taint on the WebGL texture (the asset protocol
  // is a different origin from the app page).
  useEffect(() => {
    bgReadyRef.current = false
    if (!backgroundImageUrl) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(backgroundImageUrl)
        if (!response.ok) return
        const bitmap = await createImageBitmap(await response.blob())
        const gl = glRef.current
        const texture = bgTextureRef.current
        if (cancelled || !gl || !texture) {
          bitmap.close()
          return
        }
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
        bgImageAspectRef.current = bitmap.width / Math.max(1, bitmap.height)
        bitmap.close()
        bgReadyRef.current = true
      } catch {
        // A missing/undecodable image falls back to a transparent cutout.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [backgroundImageUrl])

  // Draw loop: upload the current video/matte frames and composite the effects.
  useEffect(() => {
    let frame = 0
    const draw = () => {
      const gl = glRef.current
      const program = programRef.current
      const canvas = canvasRef.current
      const video = videoRef.current
      if (gl && program && canvas && video && video.readyState >= 2) {
        const width = video.videoWidth
        const height = video.videoHeight
        if (width > 0 && height > 0) {
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width
            canvas.height = height
          }
          const uniforms = uniformsRef.current
          const settings = settingsRef.current
          gl.viewport(0, 0, width, height)
          gl.clearColor(0, 0, 0, 0)
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.useProgram(program)

          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, videoTextureRef.current)
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
          gl.uniform1i(uniforms.u_video, 0)

          gl.activeTexture(gl.TEXTURE1)
          gl.bindTexture(gl.TEXTURE_3D, lutTextureRef.current)
          gl.uniform1i(uniforms.u_lut, 1)

          const matte = settings.matteEnabled ? matteVideoRef?.current : null
          const matteReady = Boolean(
            matte && matte.readyState >= 2 && matte.videoWidth > 0 && matte.videoHeight > 0,
          )
          gl.activeTexture(gl.TEXTURE2)
          gl.bindTexture(gl.TEXTURE_2D, matteTextureRef.current)
          if (matte && matteReady) {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, matte)
          }
          gl.uniform1i(uniforms.u_matte, 2)
          gl.uniform1i(uniforms.u_has_matte, matteReady ? 1 : 0)
          gl.uniform1i(uniforms.u_has_lut, lutReadyRef.current ? 1 : 0)

          gl.activeTexture(gl.TEXTURE3)
          gl.bindTexture(gl.TEXTURE_2D, bgTextureRef.current)
          gl.uniform1i(uniforms.u_bg_image, 3)
          gl.uniform1i(
            uniforms.u_has_bg_image,
            settings.mode === BACKGROUND_MODE.image && bgReadyRef.current ? 1 : 0,
          )

          const [x, y, w, h] = cropRef.current
          gl.uniform4f(uniforms.u_crop, x, y, w, h)
          gl.uniform2f(uniforms.u_blur_uv, settings.blurUv[0], settings.blurUv[1])
          gl.uniform3f(uniforms.u_bg_color, ...settings.bgColor)
          gl.uniform1i(uniforms.u_bg_mode, settings.mode)
          gl.uniform1f(uniforms.u_edge_softness, settings.edgeSoftness)
          gl.uniform1f(uniforms.u_edge_shift, settings.edgeShift)
          const frameAspect = w / Math.max(1e-6, h)
          const [fitX, fitY, offsetX, offsetY] = backgroundCoverUv(
            bgImageAspectRef.current,
            frameAspect,
          )
          gl.uniform4f(uniforms.u_bg_fit, fitX, fitY, offsetX, offsetY)

          gl.drawArrays(gl.TRIANGLES, 0, 3)
        }
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [matteVideoRef, videoRef])

  return <canvas ref={canvasRef} className={className} aria-hidden />
}
