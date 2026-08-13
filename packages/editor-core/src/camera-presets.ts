import type { Bounds, CameraPlacementPreset, ClipTransform } from "@recordforge/domain"

// Inset from the canvas edge for floating picture-in-picture presets.
const PIP_PADDING = 24

export interface CameraPresetInput {
  canvas: { width: number; height: number; padding?: number }
  source: { width: number; height: number }
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
      const width = Math.round(canvas.width * 0.22)
      const height = Math.round(canvas.height * 0.42)
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
      // Side-by-side is laid out inside the visible padded video area, not the
      // full canvas wrapper, so the camera strip lines up with the screen edges
      // and leaves the canvas background visible on all four sides.
      const padding = canvas.padding ?? 0
      const usableWidth = canvas.width - padding * 2
      const usableHeight = canvas.height - padding * 2
      const screenWidth = Math.round(usableWidth * 0.68)
      const gap = Math.round(usableWidth * 0.02)
      const width = Math.round(usableWidth * 0.3)
      // Height is derived from the canvas aspect as if the screen were scaled
      // to 68% of the usable width. This keeps both rectangles the same height
      // and leaves visible background on the top and bottom.
      const overlayHeight = Math.round((screenWidth / canvas.width) * canvas.height)
      const x = padding + screenWidth + gap
      const y = padding + (usableHeight - overlayHeight) / 2
      return {
        ...defaultStyle(preset),
        x,
        y,
        width,
        height: overlayHeight,
        crop: centerCoverCrop(source.width, source.height, width, overlayHeight),
      }
    }
  }
}
