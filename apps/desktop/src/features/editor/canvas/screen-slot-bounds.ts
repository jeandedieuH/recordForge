/**
 * Screen-video fitting for the preview (ADR 023). The resolver's screen slot
 * is a canvas-px rect; the preview letterboxes the source inside it and the
 * exported render does the same, so preview and export agree on where the
 * screen lands for clip-level splits and layout-lane windows alike.
 */

export interface ScreenSlotRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenFitBounds {
  left: number
  top: number
  width: number
  height: number
  scale: number
}

/**
 * The resolver's default screen slot — the content rect (canvas inset by
 * padding). A resolved `screen` equal to this means "no split", so the view
 * keeps the plain fit path (and its `scale`).
 */
export function contentRect(canvas: {
  width: number
  height: number
  padding?: number
}): ScreenSlotRect {
  const padding = Math.max(0, canvas.padding ?? 0)
  return {
    x: padding,
    y: padding,
    width: Math.max(1, canvas.width - padding * 2),
    height: Math.max(1, canvas.height - padding * 2),
  }
}

/** Slot comparison tolerant to the sub-px drift of lane transition lerps. */
export function sameScreenSlot(
  a: ScreenSlotRect | null,
  b: ScreenSlotRect | null,
  tolerance = 0.5,
): boolean {
  if (!a || !b) return a === b
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  )
}

/**
 * Fit the screen video inside `slot` (canvas px), letterboxed and vertically
 * placed by `positionY` — the same arithmetic the exporter's screen fit uses.
 * `canvasScale` is CSS px per canvas px; `scale` in the result is CSS px per
 * source px (consumers map source-space coordinates through it).
 */
export function fitScreenInSlot(input: {
  slot: ScreenSlotRect
  canvasWidth: number
  sourceWidth: number
  sourceHeight: number
  canvasScale: number
  positionY: number
}): ScreenFitBounds {
  const { slot, canvasWidth, sourceWidth, sourceHeight, canvasScale, positionY } = input
  const slotWidthCss = slot.width * canvasScale
  const slotHeightCss = slot.height * canvasScale
  const screenScale = Math.min(slotWidthCss / sourceWidth, slotHeightCss / sourceHeight)
  const screenWidth = sourceWidth * screenScale
  const screenHeight = sourceHeight * screenScale
  return {
    left: slot.x * canvasScale + (slotWidthCss - screenWidth) / 2,
    top: slot.y * canvasScale + (slotHeightCss - screenHeight) * positionY,
    width: screenWidth,
    height: screenHeight,
    scale: canvasScale * (slot.width / Math.max(1, canvasWidth)),
  }
}

/**
 * The no-slot path: fit the source inside the whole content rect, centred
 * horizontally, `positionY`-placed vertically. `canvasCssWidth` is the canvas
 * element's CSS width so the centring matches the DOM exactly.
 */
export function fitScreenDefault(input: {
  canvas: { width: number; height: number; padding?: number }
  sourceWidth: number
  sourceHeight: number
  canvasScale: number
  canvasCssWidth: number
  positionY: number
}): ScreenFitBounds {
  const { canvas, sourceWidth, sourceHeight, canvasScale, canvasCssWidth, positionY } = input
  const padding = canvas.padding ?? 0
  const maxScreenWidth = Math.max(1, (canvas.width - padding * 2) * canvasScale)
  const maxScreenHeight = Math.max(1, (canvas.height - padding * 2) * canvasScale)
  const screenScale = Math.min(maxScreenWidth / sourceWidth, maxScreenHeight / sourceHeight)
  const screenWidth = sourceWidth * screenScale
  const screenHeight = sourceHeight * screenScale
  return {
    left: (canvasCssWidth - screenWidth) / 2,
    top: padding * canvasScale + (maxScreenHeight - screenHeight) * positionY,
    width: screenWidth,
    height: screenHeight,
    scale: canvasScale,
  }
}
