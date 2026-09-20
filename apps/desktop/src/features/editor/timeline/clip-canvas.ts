// Shared canvas plumbing for timeline derivative renderers.

// WebView2/Chromium refuse canvases beyond ~16k px per axis; the visible
// window normally stays far below that, but the cap keeps extreme zoom safe.
const MAX_CANVAS_PX = 16_384

/**
 * Size a canvas backing store to a CSS box at device pixel ratio, clamped to
 * what the webview can allocate, and return a context pre-scaled so callers
 * draw in CSS pixels.
 */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1
  const scale = Math.min(
    dpr,
    MAX_CANVAS_PX / Math.max(1, cssWidth),
    MAX_CANVAS_PX / Math.max(1, cssHeight),
  )
  canvas.width = Math.max(1, Math.round(cssWidth * scale))
  canvas.height = Math.max(1, Math.round(cssHeight * scale))
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  return ctx
}

export type RgbColor = [number, number, number]

// Resolve a design token (e.g. "--color-track-mic") to RGB components so
// canvas fills stay driven by the theme instead of hardcoded literals.
export function resolveThemeColor(element: HTMLElement, varName: string): RgbColor | null {
  const raw = getComputedStyle(element).getPropertyValue(varName).trim()
  if (!raw) return null

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw)
  if (hex) {
    let digits = hex[1]
    if (digits.length === 3) {
      digits = digits
        .split("")
        .map((c) => c + c)
        .join("")
    }
    const value = Number.parseInt(digits, 16)
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(raw)
  if (rgb) {
    const parts = rgb[1].split(",").map((part) => Number.parseFloat(part))
    if (parts.length >= 3 && parts.every((part) => Number.isFinite(part))) {
      return [parts[0], parts[1], parts[2]]
    }
  }
  return null
}

export function rgba([r, g, b]: RgbColor, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
