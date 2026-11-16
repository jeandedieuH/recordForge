import { useEffect, useRef } from "react"
import type { CameraColor } from "@recordforge/contracts"
import { composeCameraLut } from "@recordforge/overlay-core"

// WebGL2 camera colour preview (#4a).
//
// The LUT comes from the shared Rust engine (WASM) — exactly the table the
// export writes as a `.cube` — and is uploaded as an RGBA8 3D texture. The
// component draws the active camera `<video>` into a canvas with the same
// normalized crop the CSS preview uses, so grading and framing stay aligned.
// It is intentionally colour-only: cutout compositing stays in the export
// renderer.

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
uniform highp sampler3D u_lut;
uniform vec4 u_crop;
out vec4 out_color;
void main() {
  vec2 top_left = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 uv = u_crop.xy + top_left * u_crop.zw;
  vec3 color = clamp(texture(u_video, vec2(uv.x, 1.0 - uv.y)).rgb, 0.0, 1.0);
  float size = 33.0;
  vec3 scale = vec3((size - 1.0) / size);
  float offset = 1.0 / (2.0 * size);
  vec3 graded = texture(u_lut, color * scale + offset).rgb;
  out_color = vec4(graded, 1.0);
}`

interface CameraLutCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  color: CameraColor | undefined
  cubeText?: string | null
  /** Source-space crop as normalized top-left x/y/width/height. */
  crop?: { x: number; y: number; width: number; height: number } | null
  className?: string
}

export function CameraLutCanvas({
  videoRef,
  color,
  cubeText,
  crop,
  className,
}: CameraLutCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glRef = useRef<WebGL2RenderingContext | null>(null)
  const programRef = useRef<WebGLProgram | null>(null)
  const videoTextureRef = useRef<WebGLTexture | null>(null)
  const lutTextureRef = useRef<WebGLTexture | null>(null)
  const cropRef = useRef<[number, number, number, number]>([0, 0, 1, 1])

  cropRef.current = crop ? [crop.x, crop.y, crop.width, crop.height] : [0, 0, 1, 1]

  // Build the GL pipeline once.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext("webgl2", { alpha: false, premultipliedAlpha: false })
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

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, "a_position")
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.useProgram(program)

    const videoTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, videoTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    videoTextureRef.current = videoTexture

    const lutTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_3D, lutTexture)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    lutTextureRef.current = lutTexture

    return () => {
      gl.deleteProgram(program)
      if (videoTexture) gl.deleteTexture(videoTexture)
      if (lutTexture) gl.deleteTexture(lutTexture)
      programRef.current = null
      videoTextureRef.current = null
      lutTextureRef.current = null
      glRef.current = null
    }
  }, [])

  // Compose/upload the LUT when the grade changes.
  useEffect(() => {
    const gl = glRef.current
    const texture = lutTextureRef.current
    if (!gl || !texture || !color) return
    let cancelled = false
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
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [color, cubeText])

  // Draw loop: upload the current video frame and composite the LUT.
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
          gl.viewport(0, 0, width, height)
          gl.useProgram(program)
          gl.bindTexture(gl.TEXTURE_2D, videoTextureRef.current)
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, videoTextureRef.current)
          gl.uniform1i(gl.getUniformLocation(program, "u_video"), 0)
          gl.activeTexture(gl.TEXTURE1)
          gl.bindTexture(gl.TEXTURE_3D, lutTextureRef.current)
          gl.uniform1i(gl.getUniformLocation(program, "u_lut"), 1)
          const [x, y, w, h] = cropRef.current
          gl.uniform4f(gl.getUniformLocation(program, "u_crop"), x, y, w, h)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
        }
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [videoRef])

  return <canvas ref={canvasRef} className={className} aria-hidden />
}
