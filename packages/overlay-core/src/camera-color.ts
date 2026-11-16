import type { CameraColor } from "@recordforge/contracts"
import { camera_lut_size, camera_lut_texture } from "../wasm/overlay_engine.js"
import { ensureOverlayWasmInitialized } from "./wasm-engine"

export interface CameraLutTexture {
  size: number
  /** RGBA8, size³ × 4 bytes, red varying fastest. */
  data: Uint8Array
}

export interface CameraLutRequest {
  color: CameraColor
  /** Raw `.cube` text for a user-imported LUT. */
  cubeText?: string
}

let cachedKey: string | null = null
let cachedTexture: CameraLutTexture | null = null

/**
 * Compose the camera LUT in the shared Rust engine (the same code the export
 * uses) and return the WebGL2 texture bytes. Results are cached by settings so
 * dragging a slider back to a previous value is free.
 */
export async function composeCameraLut(request: CameraLutRequest): Promise<CameraLutTexture> {
  const payload = {
    exposure: request.color.exposure,
    contrast: request.color.contrast,
    saturation: request.color.saturation,
    temperature: request.color.temperature,
    tint: request.color.tint,
    lutId: request.color.lutId,
    lutIntensity: request.color.lutIntensity,
    cubeText: request.cubeText,
  }
  const key = JSON.stringify(payload)
  if (cachedKey === key && cachedTexture) return cachedTexture
  await ensureOverlayWasmInitialized()
  const data = camera_lut_texture(key)
  const texture: CameraLutTexture = { size: camera_lut_size(), data }
  cachedKey = key
  cachedTexture = texture
  return texture
}
