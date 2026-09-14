import type {
  Bounds,
  CameraPlacementPreset,
  CanvasAspectRatio,
  ClipTransform,
} from "@recordforge/contracts"

// Inset from the canvas edge for floating picture-in-picture presets.
const PIP_PADDING = 24

export interface CameraPresetInput {
  canvas: {
    width: number
    height: number
    padding?: number
    aspectRatio?: CanvasAspectRatio
  }
  source: { width: number; height: number }
}

// Default circular-PiP geometry per non-16:9 canvas ratio, authored against
// the nominal 1080-base canvas each ratio produces and scaled linearly for
// larger canvases (e.g. 2160-base from 4K sources). These place a prominent
// circular webcam overlapping the lower edge of the centered screen video.
interface CirclePipRatioSpec {
  canvasWidth: number
  canvasHeight: number
  diameter: number
  x: number | "center"
  y: number
}

const CIRCLE_PIP_RATIO_LAYOUTS: Partial<Record<CanvasAspectRatio, CirclePipRatioSpec>> = {
  "9:16": { canvasWidth: 1080, canvasHeight: 1920, diameter: 840, x: "center", y: 950 },
  "1:1": { canvasWidth: 1080, canvasHeight: 1080, diameter: 460, x: "center", y: 595 },
  "5:4": { canvasWidth: 1350, canvasHeight: 1080, diameter: 350, x: 975, y: 715 },
  "4:5": { canvasWidth: 1080, canvasHeight: 1350, diameter: 600, x: "center", y: 700 },
}

// Modern default styling shared by the floating PiP presets. Camera-only is
// intentionally clean: it fills the frame and locks movement.
function defaultStyle(
  preset: CameraPlacementPreset,
): Pick<
  ClipTransform,
  | "opacity"
  | "visible"
  | "borderWidth"
  | "borderColor"
  | "borderOpacity"
  | "shadowEnabled"
  | "shadowColor"
  | "shadowBlur"
  | "shadowOffsetX"
  | "shadowOffsetY"
  | "shape"
  | "preset"
  | "locked"
> {
  return {
    opacity: 1,
    visible: true,
    borderWidth: 2,
    borderColor: "#ffffff",
    borderOpacity: 1,
    shadowEnabled: true,
    shadowColor: "var(--color-pip-shadow)",
    shadowBlur: 16,
    shadowOffsetX: 0,
    shadowOffsetY: 6,
    shape: "rectangle",
    preset,
    locked: false,
  }
}

// Center-crop the camera source so it fills the target overlay without
// stretching. This is the same behavior a CSS `object-fit: cover` would give,
// but it is baked into the transform so the exporter can render it identically.
function centerCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Bounds {
  const targetAspect = targetWidth / Math.max(1, targetHeight)
  const sourceAspect = sourceWidth / Math.max(1, sourceHeight)

  let cropWidth: number
  let cropHeight: number
  let cropX: number
  let cropY: number

  if (targetAspect >= sourceAspect) {
    // The overlay is wider than the source: crop the top and bottom.
    cropWidth = sourceWidth
    cropHeight = sourceWidth / targetAspect
    cropX = 0
    cropY = (sourceHeight - cropHeight) / 2
  } else {
    // The overlay is taller than the source: crop the left and right.
    cropWidth = sourceHeight * targetAspect
    cropHeight = sourceHeight
    cropX = (sourceWidth - cropWidth) / 2
    cropY = 0
  }

  cropX = Math.max(0, Math.min(cropX, sourceWidth - 1))
  cropY = Math.max(0, Math.min(cropY, sourceHeight - 1))
  cropWidth = Math.max(1, Math.min(cropWidth, sourceWidth - cropX))
  cropHeight = Math.max(1, Math.min(cropHeight, sourceHeight - cropY))

  return {
    x: Math.round(cropX),
    y: Math.round(cropY),
    width: Math.round(cropWidth),
    height: Math.round(cropHeight),
  }
}

// Square crop centered on the source. Used for the circular overlay so the
// circle is perfectly round rather than elliptical.
function centerSquareCrop(sourceWidth: number, sourceHeight: number): Bounds {
  const side = Math.min(sourceWidth, sourceHeight)
  const x = (sourceWidth - side) / 2
  const y = (sourceHeight - side) / 2

  return {
    x: Math.round(Math.max(0, x)),
    y: Math.round(Math.max(0, y)),
    width: Math.round(side),
    height: Math.round(side),
  }
}

/**
 * Build a complete `ClipTransform` for one of the supported camera placement
 * presets. The result is clamped to the canvas and includes a source crop that
 * matches the overlay shape so the preview and the export stay pixel-identical.
 */
export function buildCameraPresetTransform(
  preset: CameraPlacementPreset,
  input: CameraPresetInput,
): ClipTransform {
  const { canvas, source } = input

  switch (preset) {
    case "camera-only": {
      return {
        ...defaultStyle(preset),
        x: 0,
        y: 0,
        width: canvas.width,
        height: canvas.height,
        shape: "rectangle",
        borderWidth: 0,
        shadowEnabled: false,
        locked: true,
        crop: centerCoverCrop(source.width, source.height, canvas.width, canvas.height),
      }
    }

    case "vertical-pip": {
      // 5:7 portrait aspect ratio (width:height = 5:7 -> height = width * 7 / 5),
      // defaulting to a compact floating size of at most 240px width.
      const width = Math.min(240, Math.max(1, Math.round(canvas.width * 0.22)))
      const height = Math.round(width * (7 / 5))
      return {
        ...defaultStyle(preset),
        x: Math.max(0, canvas.width - width - PIP_PADDING),
        y: Math.max(0, canvas.height - height - PIP_PADDING),
        width,
        height,
        crop: centerCoverCrop(source.width, source.height, width, height),
      }
    }

    case "circle-pip": {
      // On non-16:9 canvases the circle uses the per-ratio default placement;
      // on 16:9 (or when the ratio is unknown) it stays a compact bottom-right
      // overlay.
      const spec = canvas.aspectRatio ? CIRCLE_PIP_RATIO_LAYOUTS[canvas.aspectRatio] : undefined
      if (spec) {
        const scale = canvas.height / spec.canvasHeight
        const diameter = Math.max(1, Math.round(spec.diameter * scale))
        const x =
          spec.x === "center"
            ? Math.round((canvas.width - diameter) / 2)
            : Math.round(spec.x * scale)
        const y = Math.round(spec.y * scale)
        return {
          ...defaultStyle(preset),
          x,
          y,
          width: diameter,
          height: diameter,
          shape: "circle",
          crop: centerSquareCrop(source.width, source.height),
        }
      }
      const diameter = Math.round(canvas.height * 0.28)
      return {
        ...defaultStyle(preset),
        x: Math.max(0, canvas.width - diameter - PIP_PADDING),
        y: Math.max(0, canvas.height - diameter - PIP_PADDING),
        width: diameter,
        height: diameter,
        shape: "circle",
        crop: centerSquareCrop(source.width, source.height),
      }
    }

    case "side-by-side": {
      // Side-by-side is laid out inside the visible padded video area, giving the
      // recorded screen maximum prominence (~76% width) with a 5:7 portrait camera
      // box on the right, separated by a 2% gap and vertically centered.
      const padding = canvas.padding ?? 0
      const usableWidth = Math.max(1, canvas.width - padding * 2)
      const usableHeight = Math.max(1, canvas.height - padding * 2)
      const screenWidth = Math.round(usableWidth * 0.76)
      const gap = Math.round(usableWidth * 0.02)
      const width = Math.max(1, usableWidth - screenWidth - gap)
      // Camera aspect ratio is 5:7 (width:height = 5:7 -> height = width * 7 / 5)
      const rawHeight = Math.round(width * (7 / 5))
      const overlayHeight = Math.min(rawHeight, usableHeight)
      const x = padding + screenWidth + gap
      const y = padding + Math.max(0, Math.round((usableHeight - overlayHeight) / 2))
      return {
        ...defaultStyle(preset),
        x,
        y,
        width,
        height: overlayHeight,
        locked: true,
        crop: centerCoverCrop(source.width, source.height, width, overlayHeight),
      }
    }
  }
}
