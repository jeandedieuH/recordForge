import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { CursorAsset } from "@recordforge/cursor-core"
import type { CursorSettings } from "@recordforge/contracts"
import type { CursorMotionBlurSample } from "@recordforge/editor-core"

export interface CursorMotionBlurCanvasProps {
  asset: CursorAsset
  cursorMarkup: string
  cursorSettings: CursorSettings
  /** Scale excluding per-sample zoomScale (`settings.scale * sizeFactor * fitted.scale * clickScale`). */
  baseScale: number
  /** Zoom-independent cursor scale used to keep the cached raster stable across zoom transitions. */
  unzoomedScale?: number
  /** @deprecated Kept for backwards caller compatibility; prefer `unzoomedScale`. */
  centerScale?: number
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

// Module-level bounded LRU of rasterized cursor bitmaps and in-flight decode deduplication.
const BITMAP_CACHE_LIMIT = 24
const bitmapCache = new Map<string, CachedCursorBitmap>()
const pendingLoads = new Map<string, Promise<CachedCursorBitmap | null>>()

/**
 * Supersampled raster scale derived solely from the user's unzoomed cursor
 * size (`>= 2x`) so live zoom transitions and clicks never invalidate the cache.
 */
export function cursorBitmapReferenceScale(unzoomedScale: number): number {
  return Math.max(2, Math.min(4, Math.ceil(Math.max(0.5, unzoomedScale) * 2) / 2))
}

export function buildCursorBitmapCacheKey(
  assetId: string,
  cursorMarkup: string,
  settings: CursorSettings,
  refScale: number,
  dpr: number,
): string {
  return [
    assetId,
    refScale.toFixed(2),
    dpr.toFixed(2),
    settings.shadowEnabled ? "1" : "0",
    settings.shadowOffsetX,
    settings.shadowOffsetY,
    settings.shadowBlur,
    settings.shadowOpacity,
    settings.shadowColor,
    cursorMarkup,
  ].join("|")
}

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
  refScale: number,
  dpr: number,
): Promise<CachedCursorBitmap | null> {
  const existing = bitmapCache.get(key)
  if (existing) {
    bitmapCache.delete(key)
    bitmapCache.set(key, existing)
    return Promise.resolve(existing)
  }

  const inflight = pendingLoads.get(key)
  if (inflight) return inflight

  const [vbX, vbY, vbW, vbH] = parseViewBox(asset.viewBox)
  const padVb = getShadowPadVb(asset, settings)
  const scalePxX = (asset.width * refScale * dpr) / vbW
  const scalePxY = (asset.height * refScale * dpr) / vbH
  const width = Math.max(2, Math.ceil((vbW + padVb * 2) * scalePxX))
  const height = Math.max(2, Math.ceil((vbH + padVb * 2) * scalePxY))
  const padPx = padVb * scalePxX
  const hotspotX = asset.isCenterHotspot ? width * 0.5 : (asset.hotspotX - vbX + padVb) * scalePxX
  const hotspotY = asset.isCenterHotspot ? height * 0.5 : (asset.hotspotY - vbY + padVb) * scalePxY

  const svgText = buildCursorBitmapSvg(asset, cursorMarkup, settings, width, height, padVb)
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`

  const promise = new Promise<CachedCursorBitmap | null>((resolve) => {
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
          scale: refScale,
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
  }).finally(() => {
    pendingLoads.delete(key)
  })

  pendingLoads.set(key, promise)
  return promise
}

/**
 * Warm the raster bitmap cache while the cursor is stationary so the very first
 * moving frame renders motion blur immediately without flashing sharp SVG.
 */
export function preloadCursorMotionBitmap(
  asset: CursorAsset,
  cursorMarkup: string,
  cursorSettings: CursorSettings,
  unzoomedScale: number,
  dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1,
): Promise<CachedCursorBitmap | null> {
  const refScale = cursorBitmapReferenceScale(unzoomedScale)
  const key = buildCursorBitmapCacheKey(asset.id, cursorMarkup, cursorSettings, refScale, dpr)
  return loadBitmap(key, asset, cursorMarkup, cursorSettings, refScale, dpr)
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
  unzoomedScale,
  centerScale,
  opacity,
  samples,
  containerWidth,
  containerHeight,
  fallback,
}: CursorMotionBlurCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const accumRef = useRef<Float32Array>(new Float32Array(0))

  const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1
  const refScale = cursorBitmapReferenceScale(unzoomedScale ?? centerScale ?? baseScale)
  const cacheKey = useMemo(
    () => buildCursorBitmapCacheKey(asset.id, cursorMarkup, cursorSettings, refScale, dpr),
    [asset.id, cursorMarkup, cursorSettings, refScale, dpr],
  )
  const syncCached = bitmapCache.get(cacheKey) ?? null
  const [loadedBitmap, setLoadedBitmap] = useState<{
    assetId: string
    entry: CachedCursorBitmap
  } | null>(() => (syncCached ? { assetId: asset.id, entry: syncCached } : null))

  useEffect(() => {
    const cached = bitmapCache.get(cacheKey)
    if (cached) {
      setLoadedBitmap({ assetId: asset.id, entry: cached })
      return
    }
    let cancelled = false
    void loadBitmap(cacheKey, asset, cursorMarkup, cursorSettings, refScale, dpr).then((loaded) => {
      if (!cancelled && loaded) setLoadedBitmap({ assetId: asset.id, entry: loaded })
    })
    return () => {
      cancelled = true
    }
  }, [cacheKey, asset, cursorMarkup, cursorSettings, refScale, dpr])

  // Prefer the exact synchronous cache hit; if still decoding a style update,
  // hold the previous bitmap for the same asset so zoom/color changes never blink.
  const bitmap = syncCached ?? (loadedBitmap?.assetId === asset.id ? loadedBitmap.entry : null)

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
      const x0 = Math.floor(sample.x * dpr - bitmap.hotspotX * ratio) - 1
      const y0 = Math.floor(sample.y * dpr - bitmap.hotspotY * ratio) - 1
      const x1 = x0 + Math.ceil(bitmap.width * ratio) + 2
      const y1 = y0 + Math.ceil(bitmap.height * ratio) + 2
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

  useLayoutEffect(() => {
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
      if (sameSize) {
        for (let dy = sy0; dy < sy1; dy++) {
          const srcRow = dy * rw
          const dstRow = (y0 + dy - by0) * bw
          for (let dx = sx0; dx < sx1; dx++) {
            const srcIdx = (srcRow + dx) * 4
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
      } else {
        // Premultiplied bilinear sampling keeps scaled cursor edges crisp with zero dark fringe.
        for (let dy = sy0; dy < sy1; dy++) {
          const v = ((dy + 0.5) * rh) / drawH - 0.5
          const iy = Math.floor(v)
          const fy = v - iy
          const yA = Math.max(0, Math.min(rh - 1, iy))
          const yB = Math.max(0, Math.min(rh - 1, iy + 1))
          const rowA = yA * rw
          const rowB = yB * rw
          const dstRow = (y0 + dy - by0) * bw
          const wyA = 1 - fy
          const wyB = fy

          for (let dx = sx0; dx < sx1; dx++) {
            const u = ((dx + 0.5) * rw) / drawW - 0.5
            const ix = Math.floor(u)
            const fx = u - ix
            const xA = Math.max(0, Math.min(rw - 1, ix))
            const xB = Math.max(0, Math.min(rw - 1, ix + 1))
            const wxA = 1 - fx
            const wxB = fx

            const i00 = (rowA + xA) * 4
            const i10 = (rowA + xB) * 4
            const i01 = (rowB + xA) * 4
            const i11 = (rowB + xB) * 4

            const a00 = src[i00 + 3] * wxA * wyA
            const a10 = src[i10 + 3] * wxB * wyA
            const a01 = src[i01 + 3] * wxA * wyB
            const a11 = src[i11 + 3] * wxB * wyB
            const alphaSum = a00 + a10 + a01 + a11
            if (alphaSum <= 0) continue

            const scaleFactor = weight / 255
            const dstIdx = (dstRow + (x0 + dx - bx0)) * 4
            accum[dstIdx] +=
              (src[i00] * a00 + src[i10] * a10 + src[i01] * a01 + src[i11] * a11) * scaleFactor
            accum[dstIdx + 1] +=
              (src[i00 + 1] * a00 + src[i10 + 1] * a10 + src[i01 + 1] * a01 + src[i11 + 1] * a11) *
              scaleFactor
            accum[dstIdx + 2] +=
              (src[i00 + 2] * a00 + src[i10 + 2] * a10 + src[i01 + 2] * a01 + src[i11 + 2] * a11) *
              scaleFactor
            accum[dstIdx + 3] += alphaSum * scaleFactor
          }
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
