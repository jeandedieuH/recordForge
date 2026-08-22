import { useEffect, useState } from "react"
import type { TimelineCanvas } from "@recordforge/contracts"
import {
  getEffectiveBackgroundFilterPlan,
  normalizeBackgroundCss,
  type BackgroundFilterOptimizationMode,
} from "@recordforge/editor-core"

interface PreRenderedBackgroundResult {
  /** If true, the background has been pre-rendered into a static image URL with zero live CSS filter cost. */
  isPreRendered: boolean
  /** The CSS background value (or pre-rendered data URL). */
  backgroundStyle: string
  /** Live CSS filter string if not pre-rendered. */
  filter?: string
  /** Live CSS transform string if not pre-rendered. */
  transform?: string
  /** Live CSS overlay opacity if not pre-rendered. */
  overlayOpacity?: number
}

// In-memory LRU-style cache for pre-filtered background data URLs
const backgroundCache = new Map<string, string>()
const MAX_CACHE_ENTRIES = 20

function trimCache() {
  if (backgroundCache.size > MAX_CACHE_ENTRIES) {
    const firstKey = backgroundCache.keys().next().value
    if (firstKey) backgroundCache.delete(firstKey)
  }
}

/**
 * Pre-render a blurred/dimmed background into an offscreen canvas.
 * Executes once on property change, completely eliminating per-frame CSS filter costs.
 */
async function preRenderBackgroundToUrl(
  background: string,
  blurRadius: number,
  dimFactor: number,
  canvasWidth: number,
  canvasHeight: number,
  downscaleFactor: number,
  fit: "cover" | "contain" | "fill" = "cover",
): Promise<string> {
  const width = Math.max(64, Math.round(canvasWidth / downscaleFactor))
  const height = Math.max(64, Math.round(canvasHeight / downscaleFactor))

  const offscreen = document.createElement("canvas")
  offscreen.width = width
  offscreen.height = height
  const ctx = offscreen.getContext("2d")
  if (!ctx) return background

  // If the background is an image or URL
  const isImage =
    background.startsWith("url(") ||
    background.startsWith("data:") ||
    background.startsWith("/backgrounds/") ||
    background.startsWith("http")

  if (isImage) {
    const urlMatch = background.match(/url\(['"]?(.*?)['"]?\)/)
    const rawUrl = urlMatch ? urlMatch[1] : background
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.src = rawUrl

    await new Promise<void>((resolve) => {
      if (img.complete && img.naturalWidth > 0) {
        resolve()
        return
      }
      img.onload = () => resolve()
      img.onerror = () => resolve()
    })

    if (img.naturalWidth > 0) {
      const imgAspect = img.naturalWidth / img.naturalHeight
      const canvasAspect = width / height

      if (fit === "contain") {
        // Draw soft blurred ambient underlay filling the canvas
        ctx.save()
        ctx.filter = `blur(${Math.max(8, (blurRadius + 24) / downscaleFactor)}px)`
        let uw = width
        let uh = height
        let ux = 0
        let uy = 0
        if (imgAspect > canvasAspect) {
          uw = height * imgAspect
          ux = (width - uw) / 2
        } else {
          uh = width / imgAspect
          uy = (height - uh) / 2
        }
        ctx.drawImage(img, ux, uy, uw, uh)
        // Darken ambient underlay slightly for contrast
        ctx.fillStyle = "rgba(0, 0, 0, 0.25)"
        ctx.fillRect(0, 0, width, height)
        ctx.restore()

        // Draw crisp full uncropped image
        if (blurRadius > 0) {
          ctx.filter = `blur(${Math.max(1, blurRadius / downscaleFactor)}px)`
        }
        let dw = width
        let dh = height
        let dx = 0
        let dy = 0
        if (imgAspect > canvasAspect) {
          dh = width / imgAspect
          dy = (height - dh) / 2
        } else {
          dw = height * imgAspect
          dx = (width - dw) / 2
        }
        ctx.drawImage(img, dx, dy, dw, dh)
        ctx.filter = "none"
      } else {
        // Cover fit
        if (blurRadius > 0) {
          ctx.filter = `blur(${Math.max(1, blurRadius / downscaleFactor)}px)`
        }
        let dw = width
        let dh = height
        let dx = 0
        let dy = 0
        if (imgAspect > canvasAspect) {
          dw = height * imgAspect
          dx = (width - dw) / 2
        } else {
          dh = width / imgAspect
          dy = (height - dh) / 2
        }
        ctx.drawImage(img, dx, dy, dw, dh)
        ctx.filter = "none"
      }
    } else {
      // Fallback fill
      ctx.fillStyle = "#1e293b"
      ctx.fillRect(0, 0, width, height)
    }
  } else {
    // For CSS gradients or solid colors, render via SVG foreignObject or CSS background snapshot
    const normalized = normalizeBackgroundCss(background)
    const svgString = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <foreignObject width="100%" height="100%">
          <div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;background:${normalized};${
            blurRadius > 0 ? `filter:blur(${blurRadius / downscaleFactor}px);` : ""
          }"></div>
        </foreignObject>
      </svg>
    `
    const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" })
    const svgUrl = URL.createObjectURL(svgBlob)
    const svgImg = new Image()
    svgImg.src = svgUrl

    await new Promise<void>((resolve) => {
      svgImg.onload = () => {
        ctx.drawImage(svgImg, 0, 0, width, height)
        URL.revokeObjectURL(svgUrl)
        resolve()
      }
      svgImg.onerror = () => {
        URL.revokeObjectURL(svgUrl)
        ctx.fillStyle = "#0f172a"
        ctx.fillRect(0, 0, width, height)
        resolve()
      }
    })
  }

  // Apply dimming overlay onto the offscreen canvas
  if (dimFactor > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${dimFactor})`
    ctx.fillRect(0, 0, width, height)
  }

  return offscreen.toDataURL("image/webp", 0.92)
}

/**
 * Hook that returns the pre-filtered background style with 0 per-frame CSS filter costs.
 */
export function usePreRenderedBackground(
  canvasConfig: TimelineCanvas | null | undefined,
  mode: BackgroundFilterOptimizationMode = "performance",
): PreRenderedBackgroundResult {
  const background = canvasConfig?.background ?? "#000000"
  const blur = canvasConfig?.backgroundBlur ?? 0
  const dim = canvasConfig?.backgroundDim ?? 0
  const fit = canvasConfig?.backgroundFit ?? "cover"
  const width = canvasConfig?.width ?? 1920
  const height = canvasConfig?.height ?? 1080

  const plan = getEffectiveBackgroundFilterPlan(background, blur, dim, width, height, mode)
  const fullCacheKey = `${plan.cacheKey}_fit_${fit}`
  const [cachedUrl, setCachedUrl] = useState<string | null>(() => {
    return plan.usePreRenderedFilter ? (backgroundCache.get(fullCacheKey) ?? null) : null
  })

  useEffect(() => {
    if (!plan.usePreRenderedFilter) {
      setCachedUrl(null)
      return
    }

    const hit = backgroundCache.get(fullCacheKey)
    if (hit) {
      setCachedUrl(hit)
      return
    }

    let isSubscribed = true
    preRenderBackgroundToUrl(
      background,
      plan.blurRadius,
      plan.dimFactor,
      width,
      height,
      plan.downscaleFactor,
      fit,
    )
      .then((dataUrl) => {
        if (isSubscribed) {
          backgroundCache.set(fullCacheKey, dataUrl)
          trimCache()
          setCachedUrl(dataUrl)
        }
      })
      .catch(() => {
        if (isSubscribed) setCachedUrl(null)
      })

    return () => {
      isSubscribed = false
    }
  }, [
    fullCacheKey,
    plan.usePreRenderedFilter,
    background,
    plan.blurRadius,
    plan.dimFactor,
    width,
    height,
    plan.downscaleFactor,
    fit,
  ])

  if (!plan.usePreRenderedFilter) {
    return {
      isPreRendered: false,
      backgroundStyle: normalizeBackgroundCss(background),
      filter: undefined,
      transform: undefined,
      overlayOpacity: undefined,
    }
  }

  if (cachedUrl) {
    return {
      isPreRendered: true,
      backgroundStyle: `url("${cachedUrl}")`,
      filter: undefined,
      transform: undefined,
      overlayOpacity: undefined,
    }
  }

  // Fallback while asynchronous pre-rendering is in flight
  return {
    isPreRendered: false,
    backgroundStyle: normalizeBackgroundCss(background),
    filter: plan.blurRadius > 0 ? `blur(${plan.blurRadius}px)` : undefined,
    transform: undefined,
    overlayOpacity: plan.dimFactor > 0 ? plan.dimFactor : undefined,
  }
}
