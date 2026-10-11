import type { CanvasAspectRatio } from "@recordforge/contracts"

// Per-aspect-ratio sizing. fontScale is relative to the canvas SHORT edge —
// the renderer's canvas tiers (canvasSizeForAspectRatio) always share the same
// short edge (1080/1440/2160), so font size stays consistent across ratios
// while width budget and insets adapt to the shape.
export interface CaptionAspectProfile {
  /** e.g. "16:9" */
  ratio: CanvasAspectRatio
  /** × canvas short edge → base caption font size (CSS em px). */
  fontScale: number
  /** × canvas width → longest allowed text line. */
  maxTextWidth: number
  maxLines: number
  /** × canvas height → distance of the outer box from the bottom edge. */
  bottomInset: number
  /** × canvas height → distance of the outer box from the top edge. */
  topInset: number
}

const PROFILES: Record<CanvasAspectRatio, CaptionAspectProfile> = {
  "16:9": {
    ratio: "16:9",
    fontScale: 0.0425,
    maxTextWidth: 0.62,
    maxLines: 2,
    bottomInset: 0.08,
    topInset: 0.08,
  },
  "5:4": {
    ratio: "5:4",
    fontScale: 0.045,
    maxTextWidth: 0.78,
    maxLines: 2,
    bottomInset: 0.09,
    topInset: 0.09,
  },
  "1:1": {
    ratio: "1:1",
    fontScale: 0.048,
    maxTextWidth: 0.82,
    maxLines: 2,
    bottomInset: 0.1,
    topInset: 0.1,
  },
  "4:5": {
    ratio: "4:5",
    fontScale: 0.052,
    maxTextWidth: 0.84,
    maxLines: 2,
    bottomInset: 0.13,
    topInset: 0.09,
  },
  "9:16": {
    ratio: "9:16",
    fontScale: 0.056,
    maxTextWidth: 0.84,
    maxLines: 2,
    bottomInset: 0.17,
    topInset: 0.11,
  },
}

const RATIO_VALUES: Record<CanvasAspectRatio, number> = {
  "16:9": 16 / 9,
  "5:4": 5 / 4,
  "1:1": 1,
  "4:5": 4 / 5,
  "9:16": 9 / 16,
}

/**
 * Profile for a canvas. `aspectRatio` wins when set; otherwise the canvas's
 * width/height picks the nearest supported ratio (free-form canvases included).
 */
export function profileForCanvas(canvas: {
  width: number
  height: number
  aspectRatio?: CanvasAspectRatio
}): CaptionAspectProfile {
  const ratio = canvas.aspectRatio ?? nearestRatio(canvas.width, canvas.height)
  return PROFILES[ratio]
}

function nearestRatio(width: number, height: number): CanvasAspectRatio {
  const actual = height > 0 ? width / height : 16 / 9
  let best: CanvasAspectRatio = "16:9"
  let bestDistance = Infinity
  for (const ratio of Object.keys(RATIO_VALUES) as CanvasAspectRatio[]) {
    const distance = Math.abs(actual - RATIO_VALUES[ratio])
    if (distance < bestDistance) {
      bestDistance = distance
      best = ratio
    }
  }
  return best
}
