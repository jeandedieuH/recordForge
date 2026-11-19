import { useEffect, useMemo, useRef, useState } from "react"
import type { CursorAsset } from "@recordforge/cursor-core"
import type { CursorSettings } from "@recordforge/contracts"
import type { CursorMotionBlurSample } from "@recordforge/editor-core"

export interface CursorMotionBlurCanvasProps {
  asset: CursorAsset
  cursorMarkup: string
  cursorSettings: CursorSettings
  /** Scale excluding per-sample zoomScale (`settings.scale * sizeFactor * fitted.scale * clickScale`). */
  baseScale: number
  /** Reference scale at the frame center, used to size the cached bitmap. */
  centerScale: number
  opacity: number
  samples: readonly CursorMotionBlurSample[]
  containerWidth: number
  containerHeight: number
  /** Shown while the cached SVG bitmap decodes on the very first frame (zero blink). */
  fallback?: React.ReactNode
}

interface CachedCursorBitmap {
  key: string
  width: number
  height: number
  padPx: number
  hotspotX: number
  hotspotY: number
  scale: number
  data: Uint8ClampedArray
}

// Module-level bounded LRU of rasterized cursor bitmaps so scrubbing/playback
// never re-decodes the SVG data URL per frame.
const BITMAP_CACHE_LIMIT = 24
const bitmapCache = new Map<string, CachedCursorBitmap>()

function parseViewBox(viewBox: string): [number, number, number, number] {
  const parts = viewBox
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
    return [parts[0], parts[1], parts[2], parts[3]]
  }
  return [0, 0, 24, 24]
}

function buildCursorBitmapSvg(
  asset: CursorAsset,
  cursorMarkup: string,
  settings: CursorSettings,
  widthPx: number,
  heightPx: number,
  padVb: number,
): string {
  const [vbX, vbY, vbW, vbH] = parseViewBox(asset.viewBox)
  const paddedVb = `${vbX - padVb} ${vbY - padVb} ${vbW + padVb * 2} ${vbH + padVb * 2}`
  if (settings.shadowEnabled && settings.shadowOpacity > 0) {
    const stdDev = Math.max(0, settings.shadowBlur / 2)
    const fx = vbX - padVb * 2
    const fy = vbY - padVb * 2
    const fw = vbW + padVb * 4
    const fh = vbH + padVb * 4
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${paddedVb}" width="${widthPx}" height="${heightPx}">` +
      `<defs><filter id="rf-cur-sh" x="${fx}" y="${fy}" width="${fw}" height="${fh}" filterUnits="userSpaceOnUse">` +
      `<feDropShadow dx="${settings.shadowOffsetX}" dy="${settings.shadowOffsetY}" stdDeviation="${stdDev}" flood-color="${settings.shadowColor}" flood-opacity="${settings.shadowOpacity}"/>` +
      `</filter></defs><g filter="url(#rf-cur-sh)">${cursorMarkup}</g></svg>`
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${paddedVb}" width="${widthPx}" height="${heightPx}">${cursorMarkup}</svg>`
}

function getShadowPadVb(asset: CursorAsset, settings: CursorSettings): number {
  if (!settings.shadowEnabled || settings.shadowOpacity <= 0) return 2
  const [, , vbW, vbH] = parseViewBox(asset.viewBox)
  const maxOffset = Math.max(Math.abs(settings.shadowOffsetX), Math.abs(settings.shadowOffsetY))
  const padCss = maxOffset + settings.shadowBlur * 2 + 2
  const ratio = Math.max(vbW / Math.max(1, asset.width), vbH / Math.max(1, asset.height))
  return Math.max(2, Math.ceil(padCss * ratio))
}

function loadBitmap(
  key: string,
  asset: CursorAsset,
  cursorMarkup: string,
  settings: CursorSettings,
  quantizedScale: number,
  dpr: number,
): Promise<CachedCursorBitmap | null> {
  const existing = bitmapCache.get(key)
  if (existing) {
    bitmapCache.delete(key)
    bitmapCache.set(key, existing)
    return Promise.resolve(existing)
  }

  const [vbX, vbY, vbW, vbH] = parseViewBox(asset.viewBox)
  const padVb = getShadowPadVb(asset, settings)
  const scalePxX = (asset.width * quantizedScale * dpr) / vbW
  const scalePxY = (asset.height * quantizedScale * dpr) / vbH
  const width = Math.max(2, Math.ceil((vbW + padVb * 2) * scalePxX))
  const height = Math.max(2, Math.ceil((vbH + padVb * 2) * scalePxY))
  const padPx = padVb * scalePxX
  const hotspotX = asset.isCenterHotspot ? width * 0.5 : (asset.hotspotX - vbX + padVb) * scalePxX
  const hotspotY = asset.isCenterHotspot ? height * 0.5 : (asset.hotspotY - vbY + padVb) * scalePxY

  const svgText = buildCursorBitmapSvg(asset, cursorMarkup, settings, width, height, padVb)
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`

  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const offscreen = document.createElement("canvas")
        offscreen.width = width
        offscreen.height = height
        const ctx = offscreen.getContext("2d")
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(img, 0, 0, width, height)
        const imageData = ctx.getImageData(0, 0, width, height)
        const entry: CachedCursorBitmap = {
          key,
          width,
          height,
          padPx,
          hotspotX,
          hotspotY,
          scale: quantizedScale,
          data: imageData.data,
        }
        bitmapCache.set(key, entry)
        if (bitmapCache.size > BITMAP_CACHE_LIMIT) {
          const oldestKey = bitmapCache.keys().next().value
          if (oldestKey !== undefined) bitmapCache.delete(oldestKey)
        }
        resolve(entry)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

/**
 * Linear premultiplied RGBA shutter accumulator for preview cursor motion blur.
 *
 * Mirrors Rust `exports::cursor::CursorRenderer::draw_cursor_motion_blur`:
 * integrating weighted sub-frame poses in Float32 premultiplied RGBA preserves
 * 100% core opacity (zero Porter-Duff wash-out) and renders silky multi-sample
 * trails inside a tight bounding-box `<canvas>` — including while paused.
 */
export function CursorMotionBlurCanvas({
  asset,
  cursorMarkup,
  cursorSettings,
  baseScale,
  centerScale,
  opacity,
  samples,
  containerWidth,
  containerHeight,
  fallback,
}: CursorMotionBlurCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const accumRef = useRef<Float32Array>(new Float32Array(0))
  const [bitmap, setBitmap] = useState<CachedCursorBitmap | null>(null)

  const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1
  // Quantize bitmap scale to 5% bins so zooming smoothly reuses cached rasters.
  const quantizedScale = Math.max(0.1, Math.round(centerScale * 20) / 20)
  const cacheKey = useMemo(
    () =>
      [
        asset.id,
        quantizedScale.toFixed(2),
        dpr.toFixed(2),
        cursorSettings.shadowEnabled ? "1" : "0",
        cursorSettings.shadowOffsetX,
        cursorSettings.shadowOffsetY,
        cursorSettings.shadowBlur,
        cursorSettings.shadowOpacity,
        cursorSettings.shadowColor,
        cursorMarkup,
      ].join("|"),
    [
      asset.id,
      quantizedScale,
      dpr,
      cursorSettings.shadowEnabled,
      cursorSettings.shadowOffsetX,
      cursorSettings.shadowOffsetY,
      cursorSettings.shadowBlur,
      cursorSettings.shadowOpacity,
      cursorSettings.shadowColor,
      cursorMarkup,
    ],
  )

  useEffect(() => {
    const cached = bitmapCache.get(cacheKey)
    if (cached) {
      setBitmap(cached)
      return
    }
    let cancelled = false
    void loadBitmap(cacheKey, asset, cursorMarkup, cursorSettings, quantizedScale, dpr).then(
      (loaded) => {
        if (!cancelled && loaded) setBitmap(loaded)
      },
    )
    return () => {
      cancelled = true
    }
  }, [cacheKey, asset, cursorMarkup, cursorSettings, quantizedScale, dpr])

  const layout = useMemo(() => {
    if (!bitmap || samples.length === 0) return null
    const maxW = Math.max(1, Math.ceil(containerWidth * dpr))
    const maxH = Math.max(1, Math.ceil(containerHeight * dpr))
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY

    for (const sample of samples) {
      const sampleScale = Math.max(0.05, baseScale * sample.zoomScale)
      const ratio = sampleScale / Math.max(0.05, bitmap.scale)
      const x0 = Math.floor(sample.x * dpr - bitmap.hotspotX * ratio)
      const y0 = Math.floor(sample.y * dpr - bitmap.hotspotY * ratio)
      const x1 = x0 + Math.ceil(bitmap.width * ratio)
      const y1 = y0 + Math.ceil(bitmap.height * ratio)
      if (x0 < minX) minX = x0
      if (y0 < minY) minY = y0
      if (x1 > maxX) maxX = x1
      if (y1 > maxY) maxY = y1
    }

    const bx0 = Math.max(0, minX)
    const by0 = Math.max(0, minY)
    const bx1 = Math.min(maxW, maxX)
    const by1 = Math.min(maxH, maxY)
    if (bx0 >= bx1 || by0 >= by1) return null
    return { bx0, by0, bw: bx1 - bx0, bh: by1 - by0 }
  }, [bitmap, samples, baseScale, containerWidth, containerHeight, dpr])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !bitmap || !layout) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const { bx0, by0, bw, bh } = layout
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }

    const needed = bw * bh * 4
    if (accumRef.current.length < needed) {
      accumRef.current = new Float32Array(needed)
    }
    const accum = accumRef.current
    accum.fill(0, 0, needed)

    const src = bitmap.data
    const rw = bitmap.width
    const rh = bitmap.height

    for (const sample of samples) {
      const sampleScale = Math.max(0.05, baseScale * sample.zoomScale)
      const ratio = sampleScale / Math.max(0.05, bitmap.scale)
      const drawW = Math.max(1, Math.round(rw * ratio))
      const drawH = Math.max(1, Math.round(rh * ratio))
      const x0 = Math.round(sample.x * dpr - bitmap.hotspotX * ratio)
      const y0 = Math.round(sample.y * dpr - bitmap.hotspotY * ratio)
      const weight = sample.weight

      const sx0 = Math.max(0, bx0 - x0)
      const sy0 = Math.max(0, by0 - y0)
      const sx1 = Math.min(drawW, bx0 + bw - x0)
      const sy1 = Math.min(drawH, by0 + bh - y0)
      if (sx0 >= sx1 || sy0 >= sy1) continue

      const sameSize = drawW === rw && drawH === rh
      for (let dy = sy0; dy < sy1; dy++) {
        const srcY = sameSize ? dy : Math.min(rh - 1, Math.floor((dy * rh) / drawH))
        const srcRow = srcY * rw
        const dstRow = (y0 + dy - by0) * bw
        for (let dx = sx0; dx < sx1; dx++) {
          const srcX = sameSize ? dx : Math.min(rw - 1, Math.floor((dx * rw) / drawW))
          const srcIdx = (srcRow + srcX) * 4
          const srcA = src[srcIdx + 3]
          if (srcA === 0) continue
          const wa = (srcA / 255) * weight
          const dstIdx = (dstRow + (x0 + dx - bx0)) * 4
          accum[dstIdx] += src[srcIdx] * wa
          accum[dstIdx + 1] += src[srcIdx + 1] * wa
          accum[dstIdx + 2] += src[srcIdx + 2] * wa
          accum[dstIdx + 3] += wa
        }
      }
    }

    const imageData = ctx.createImageData(bw, bh)
    const out = imageData.data
    const clampedOpacity = Math.max(0, Math.min(1, opacity))
    for (let i = 0; i < needed; i += 4) {
      const a = accum[i + 3]
      if (a <= 1e-4) continue
      const invA = 1 / a
      out[i] = Math.min(255, Math.round(accum[i] * invA))
      out[i + 1] = Math.min(255, Math.round(accum[i + 1] * invA))
      out[i + 2] = Math.min(255, Math.round(accum[i + 2] * invA))
      out[i + 3] = Math.min(255, Math.round(a * clampedOpacity * 255))
    }
    ctx.putImageData(imageData, 0, 0)
  }, [bitmap, layout, samples, baseScale, opacity, dpr])

  if (!bitmap || !layout) return <>{fallback ?? null}</>

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        left: layout.bx0 / dpr,
        top: layout.by0 / dpr,
        width: layout.bw / dpr,
        height: layout.bh / dpr,
      }}
    />
  )
}
