import {
  CAMERA_CORNER_RADIUS_FRACTION,
  cameraFrameSchema,
  type Bounds,
  type CameraClip,
  type CameraFrame,
  type CameraFrameSplit,
  type CameraLayoutKind,
  type CameraLayoutPip,
  type CameraLayoutSegment,
  type CameraPlacementPreset,
  type CanvasAspectRatio,
  type ClipTransform,
} from "@recordforge/contracts"
import { buildCameraPresetTransform } from "@recordforge/domain"
import {
  CAMERA_LAYOUT_MARGIN_FRACTION,
  evaluateCameraLayoutWindow,
  resolveCameraLayoutWindows,
  screenContentRect,
  type CameraLayoutPose,
} from "./camera-layouts"
import type { CanvasRect } from "./composition"

/**
 * Camera frame model (ADR 023) — the single resolver every camera surface
 * consumes. A `CameraFrame` stores placement, shape, style and framing in
 * resolution-independent fractions/design units; `resolveCameraFrame` turns it
 * into canvas-pixel geometry, applies the active layout-lane window, and emits
 * the px radius/style and source crop both renderers need.
 *
 * Migration helpers convert between the frame spec and the legacy pixel
 * `ClipTransform` so v1 project files load and save unchanged.
 */

export interface CameraFrameCanvas {
  width: number
  height: number
  padding?: number
  /** Drives the per-ratio circle-PiP table in `autoCameraFrame`. */
  aspectRatio?: CanvasAspectRatio
}

export interface CameraSourceSize {
  width: number
  height: number
}

/** Frame style with design-unit lengths resolved to canvas px. */
export interface ResolvedCameraStyle {
  opacity: number
  borderWidth: number
  borderColor: string
  borderOpacity: number
  borderStyle?: CameraFrame["style"]["borderStyle"]
  borderGradient?: CameraFrame["style"]["borderGradient"]
  shadowEnabled: boolean
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
}

export interface ResolvedCameraFrame {
  /** Camera rect on the canvas, in canvas px. */
  rect: CanvasRect
  /** Screen slot on the canvas (split layouts shrink it). */
  screen: CanvasRect
  radius: number
  opacity: number
  shape: "rectangle" | "rounded" | "circle"
  visible: boolean
  crop?: Bounds
  style: ResolvedCameraStyle
  mode: "overlay" | "split" | "full"
  /** Active layout-lane kind, or "base" when no window applies. */
  layout: CameraLayoutKind | "base"
  segmentId: string | null
}

export interface ResolveCameraFrameInput {
  frame: CameraFrame
  canvas: CameraFrameCanvas
  source?: CameraSourceSize
  segments?: CameraLayoutSegment[]
  timeMs?: number
}

/** Placement minus `origin` — what a lane override or clip placement needs. */
export type CameraPlacementSpec = Omit<CameraFrame["placement"], "origin">

export function cameraShortEdge(canvas: Pick<CameraFrameCanvas, "width" | "height">): number {
  return Math.min(canvas.width, canvas.height)
}

/** Design-unit → px scale: style lengths are authored on a 1080 short edge. */
export function cameraStyleScale(canvas: Pick<CameraFrameCanvas, "width" | "height">): number {
  return cameraShortEdge(canvas) / 1080
}

function clampRectToCanvas(rect: CanvasRect, canvas: CameraFrameCanvas): CanvasRect {
  const width = Math.max(0, Math.min(rect.width, canvas.width))
  const height = Math.max(0, Math.min(rect.height, canvas.height))
  return {
    x: Math.max(0, Math.min(rect.x, Math.max(0, canvas.width - width))),
    y: Math.max(0, Math.min(rect.y, Math.max(0, canvas.height - height))),
    width,
    height,
  }
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

const NAMED_FRAME_ASPECTS: Record<string, number> = {
  "1:1": 1,
  "4:3": 4 / 3,
  "3:4": 3 / 4,
  "5:7": 5 / 7,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
}

const FALLBACK_FRAME_ASPECT = 16 / 9

/** Aspect (width/height) a frame resolves to, honouring shape and mode. */
export function effectiveFrameAspect(
  frame: Pick<CameraFrame, "shape" | "aspect" | "placement">,
  canvas: CameraFrameCanvas,
  source?: CameraSourceSize,
): number {
  if (frame.placement.mode === "full") return canvas.width / Math.max(1, canvas.height)
  if (frame.shape === "circle") return 1
  const aspect = frame.aspect
  if (typeof aspect === "number") return aspect
  if (aspect === "source") {
    return source && source.width > 0 && source.height > 0
      ? source.width / source.height
      : FALLBACK_FRAME_ASPECT
  }
  return NAMED_FRAME_ASPECTS[aspect] ?? FALLBACK_FRAME_ASPECT
}

/**
 * One split-layout implementation shared by the clip-level `split` placement
 * (0.76/0.02, `fit: "frame"`, content-anchored) and the layout lane's
 * side-by-side (0.5/0, `fit: "column"`, canvas-anchored).
 *
 * `side` names the camera column; the screen slot takes the rest. With
 * `fit: "frame"` the slot is a canvas-aspect box centred inside the area —
 * the same inputs Rust's `video_screen_rect(.., is_side_by_side = true)`
 * resolves (TS does not need its even-integer YUV rounding). With
 * `fit: "column"` the slot fills the column edge-to-edge.
 */
export function computeSplit(
  canvas: CameraFrameCanvas,
  split: CameraFrameSplit,
  area: CanvasRect,
): { screen: CanvasRect; column: CanvasRect } {
  const canvasAspect = canvas.width / Math.max(1, canvas.height)
  const vertical = split.side === "top" || split.side === "bottom"

  if (!vertical) {
    const slotWidth = Math.max(0, Math.round(area.width * split.ratio))
    const slotHeight = split.fit === "column" ? area.height : Math.round(slotWidth / canvasAspect)
    const gap = Math.round(area.width * split.gap)
    const slotY = area.y + Math.round((area.height - slotHeight) / 2)
    if (split.side === "left") {
      const columnWidth = Math.max(0, area.width - slotWidth - gap)
      return {
        column: { x: area.x, y: area.y, width: columnWidth, height: area.height },
        screen: {
          x: area.x + columnWidth + gap,
          y: slotY,
          width: slotWidth,
          height: slotHeight,
        },
      }
    }
    return {
      screen: { x: area.x, y: slotY, width: slotWidth, height: slotHeight },
      column: {
        x: area.x + slotWidth + gap,
        y: area.y,
        width: Math.max(0, area.width - slotWidth - gap),
        height: area.height,
      },
    }
  }

  const slotHeight = Math.max(0, Math.round(area.height * split.ratio))
  const slotWidth = split.fit === "column" ? area.width : Math.round(slotHeight * canvasAspect)
  const gap = Math.round(area.height * split.gap)
  const slotX = area.x + Math.round((area.width - slotWidth) / 2)
  if (split.side === "top") {
    const columnHeight = Math.max(0, area.height - slotHeight - gap)
    return {
      column: { x: area.x, y: area.y, width: area.width, height: columnHeight },
      screen: {
        x: slotX,
        y: area.y + columnHeight + gap,
        width: slotWidth,
        height: slotHeight,
      },
    }
  }
  return {
    screen: { x: slotX, y: area.y, width: slotWidth, height: slotHeight },
    column: {
      x: area.x,
      y: area.y + slotHeight + gap,
      width: area.width,
      height: Math.max(0, area.height - slotHeight - gap),
    },
  }
}

/**
 * Frame-aspect box inside a split column: the column edge drives the wide
 * dimension, the height/width is aspect-derived and capped by the column
 * (matching the domain `side-by-side` preset, which keeps the column width
 * when the height clamps).
 */
function fitFrameInColumn(
  column: CanvasRect,
  aspect: number,
  side: CameraFrameSplit["side"],
): CanvasRect {
  const safeAspect = Math.max(0.01, aspect)
  if (side === "left" || side === "right") {
    const width = Math.max(0, column.width)
    const height = Math.min(Math.round(width / safeAspect), Math.max(0, column.height))
    return {
      x: column.x,
      y: column.y + Math.max(0, Math.round((column.height - height) / 2)),
      width,
      height,
    }
  }
  const height = Math.max(0, column.height)
  const width = Math.min(Math.round(height * safeAspect), Math.max(0, column.width))
  return {
    x: column.x + Math.max(0, Math.round((column.width - width) / 2)),
    y: column.y,
    width,
    height,
  }
}

/**
 * Resolve a placement spec plus an effective aspect into the camera rect and
 * the screen slot. `full` covers the canvas; `split` divides the anchor area;
 * `overlay` positions a `size`-fraction box by `align` inside the margin-inset
 * anchor area. Rects are integer-rounded and clamped to the canvas.
 */
export function resolvePlacementRect(
  placement: CameraPlacementSpec,
  aspect: number,
  canvas: CameraFrameCanvas,
): { camera: CanvasRect; screen: CanvasRect } {
  const content = screenContentRect(canvas)
  const area =
    placement.anchorTo === "content"
      ? content
      : { x: 0, y: 0, width: canvas.width, height: canvas.height }

  if (placement.mode === "full") {
    return {
      camera: { x: 0, y: 0, width: canvas.width, height: canvas.height },
      screen: content,
    }
  }

  if (placement.mode === "split") {
    const { screen, column } = computeSplit(canvas, placement.split, area)
    const camera =
      placement.split.fit === "column"
        ? column
        : fitFrameInColumn(column, aspect, placement.split.side)
    return { camera: clampRectToCanvas(camera, canvas), screen }
  }

  const short = cameraShortEdge(canvas)
  const margin = Math.round(placement.margin * short)
  const height = Math.max(2, Math.round(placement.size * short))
  const width = Math.max(2, Math.round(height * Math.max(0.01, aspect)))
  const x = area.x + margin + placement.align.x * (area.width - margin * 2 - width)
  const y = area.y + margin + placement.align.y * (area.height - margin * 2 - height)
  return {
    camera: clampRectToCanvas({ x: Math.round(x), y: Math.round(y), width, height }, canvas),
    screen: content,
  }
}

/** Resolve a frame's placement into the camera rect and screen slot. */
export function resolveFramePlacement(
  frame: CameraFrame,
  canvas: CameraFrameCanvas,
  source?: CameraSourceSize,
): { rect: CanvasRect; screen: CanvasRect } {
  const { camera, screen } = resolvePlacementRect(
    frame.placement,
    effectiveFrameAspect(frame, canvas, source),
    canvas,
  )
  return { rect: camera, screen }
}

/**
 * Source-window crop: cover the frame aspect inside the source, shrink it by
 * `framing.zoom` and recentre it on `framing.focus` (0.5 = centred, clamped so
 * the crop stays inside the source). Returns `undefined` when the source size
 * is unknown — the caller renders the uncropped source.
 */
export function cameraCoverCrop(
  source: CameraSourceSize | undefined,
  aspect: number,
  framing: Pick<CameraFrame["framing"], "focusX" | "focusY" | "zoom">,
): Bounds | undefined {
  if (!source || source.width <= 0 || source.height <= 0) return undefined
  const sourceAspect = source.width / source.height
  const targetAspect = Math.max(0.01, aspect)
  let cropWidth: number
  let cropHeight: number
  if (targetAspect >= sourceAspect) {
    cropWidth = source.width
    cropHeight = source.width / targetAspect
  } else {
    cropWidth = source.height * targetAspect
    cropHeight = source.height
  }
  const zoom = Math.max(1, framing.zoom)
  cropWidth /= zoom
  cropHeight /= zoom
  let cropX = framing.focusX * source.width - cropWidth / 2
  let cropY = framing.focusY * source.height - cropHeight / 2
  // Same clamp+round as the domain cover crop so migrated crops round-trip.
  cropX = Math.max(0, Math.min(cropX, source.width - cropWidth))
  cropY = Math.max(0, Math.min(cropY, source.height - cropHeight))
  cropX = Math.max(0, Math.min(cropX, source.width - 1))
  cropY = Math.max(0, Math.min(cropY, source.height - 1))
  cropWidth = Math.max(1, Math.min(cropWidth, source.width - cropX))
  cropHeight = Math.max(1, Math.min(cropHeight, source.height - cropY))
  return {
    x: Math.round(cropX),
    y: Math.round(cropY),
    width: Math.round(cropWidth),
    height: Math.round(cropHeight),
  }
}

/** Corner radius in px — the single formula ADR 023 mandates everywhere. */
export function cameraFrameRadius(
  rect: CanvasRect,
  shape: "rectangle" | "rounded" | "circle",
  cornerRadius: number = CAMERA_CORNER_RADIUS_FRACTION,
): number {
  if (shape === "circle") return Math.min(rect.width, rect.height) / 2
  if (shape === "rounded") {
    return Math.round(Math.min(rect.width, rect.height) * cornerRadius)
  }
  return 0
}

const LANE_CORNER_ALIGN: Record<"tl" | "tr" | "bl" | "br", { x: number; y: number }> = {
  tl: { x: 0, y: 0 },
  tr: { x: 1, y: 0 },
  bl: { x: 0, y: 1 },
  br: { x: 1, y: 1 },
}

/**
 * Lane `pip` rect expressed through the overlay placement path: `sizeFraction`
 * is a fraction of the canvas HEIGHT (lane semantics), converted to the
 * short-edge `size` the frame model uses; the lane margin stays
 * `CAMERA_LAYOUT_MARGIN_FRACTION` of the canvas height. `custom` keeps its
 * canvas-fraction pin.
 */
export function lanePipCameraRect(
  pip: CameraLayoutPip | undefined,
  canvas: CameraFrameCanvas,
  baseAspect: number,
): CanvasRect {
  const corner = pip?.corner ?? "br"
  const short = cameraShortEdge(canvas)
  const fraction = Math.min(0.6, Math.max(0.05, pip?.sizeFraction ?? 0.24))
  const height = Math.max(2, Math.round(fraction * canvas.height))
  const width = Math.max(2, Math.round(height * Math.max(0.01, baseAspect)))
  if (corner === "custom") {
    return clampRectToCanvas(
      {
        x: Math.round((pip?.x ?? 0.7) * canvas.width),
        y: Math.round((pip?.y ?? 0.7) * canvas.height),
        width,
        height,
      },
      canvas,
    )
  }
  const { camera } = resolvePlacementRect(
    {
      mode: "overlay",
      align: LANE_CORNER_ALIGN[corner],
      size: height / short,
      margin: (canvas.height * CAMERA_LAYOUT_MARGIN_FRACTION) / short,
      anchorTo: "canvas",
      split: { side: "right", ratio: 0.76, gap: 0.02, fit: "frame" },
    },
    baseAspect,
    canvas,
  )
  return camera
}

/**
 * Lane side-by-side spec (50/50, no gap, full columns) — reproduces the
 * legacy lane geometry `{0,0,round(W/2),H}` / `{round(W/2),0,W-round(W/2),H}`.
 */
export const LANE_SIDE_BY_SIDE_SPLIT: CameraFrameSplit = {
  side: "right",
  ratio: 0.5,
  gap: 0,
  fit: "column",
}

// ---------------------------------------------------------------------------
// Auto placement policy
// ---------------------------------------------------------------------------

// Per-ratio circle-PiP defaults converted from the domain pixel table:
// `size` is the table diameter as a fraction of the nominal short edge;
// `align` reproduces the table's x/y inside the margin-free canvas area.
//
// ADR 023: this is the authoritative per-ratio circle-PiP table going forward
// (all new geometry resolves through `autoCameraFrame`). Domain's
// `CIRCLE_PIP_RATIO_LAYOUTS` remains only as the legacy pixel builder for
// `createTimelineFromRecording` and the migration reference — keep them in
// sync if either ever changes.
const CIRCLE_PIP_FRAME_LAYOUTS: Partial<
  Record<CanvasAspectRatio, { size: number; alignX: number; alignY: number }>
> = {
  "9:16": { size: 840 / 1080, alignX: 0.5, alignY: 950 / (1920 - 840) },
  "1:1": { size: 460 / 1080, alignX: 0.5, alignY: 595 / (1080 - 460) },
  "5:4": {
    size: 350 / 1080,
    alignX: 975 / (1350 - 350),
    alignY: 715 / (1080 - 350),
  },
  "4:5": { size: 600 / 1080, alignX: 0.5, alignY: 700 / (1350 - 600) },
}

/**
 * The frame a smart-default policy produces for a preset at a canvas ratio —
 * `origin: "auto"`, `preset` set, geometry expressed as fractions so a
 * resolution change rescales it while a ratio change rebuilds it.
 */
export function autoCameraFrame(input: {
  preset: CameraPlacementPreset
  aspectRatio?: CanvasAspectRatio
}): CameraFrame {
  switch (input.preset) {
    case "camera-only":
      return cameraFrameSchema.parse({
        placement: { mode: "full" },
        shape: "rectangle",
        aspect: "source",
        // The domain preset keeps camera-only clean: no ring, no shadow.
        style: { borderWidth: 0, shadowEnabled: false },
        preset: "camera-only",
      })
    case "vertical-pip":
      return cameraFrameSchema.parse({
        placement: {
          align: { x: 1, y: 1 },
          // 240x336 px on a 1080-short-edge canvas, 24 px from the corner.
          size: 336 / 1080,
          margin: 24 / 1080,
          anchorTo: "canvas",
        },
        shape: "rectangle",
        aspect: "5:7",
        preset: "vertical-pip",
      })
    case "circle-pip": {
      const spec = input.aspectRatio ? CIRCLE_PIP_FRAME_LAYOUTS[input.aspectRatio] : undefined
      if (spec) {
        return cameraFrameSchema.parse({
          placement: {
            align: { x: spec.alignX, y: spec.alignY },
            size: spec.size,
            margin: 0,
            anchorTo: "canvas",
          },
          shape: "circle",
          aspect: "1:1",
          preset: "circle-pip",
        })
      }
      // 16:9 (and unknown ratios): compact bottom-right circle, 24 px margin.
      return cameraFrameSchema.parse({
        placement: {
          align: { x: 1, y: 1 },
          size: 0.28,
          margin: 24 / 1080,
          anchorTo: "canvas",
        },
        shape: "circle",
        aspect: "1:1",
        preset: "circle-pip",
      })
    }
    case "side-by-side":
      return cameraFrameSchema.parse({
        placement: {
          mode: "split",
          anchorTo: "content",
          split: { side: "right", ratio: 0.76, gap: 0.02, fit: "frame" },
        },
        shape: "rectangle",
        aspect: "5:7",
        preset: "side-by-side",
      })
  }
}

/** The smart-default preset an aspect-ratio switch rebuilds auto frames with. */
export function autoPresetForAspectRatio(
  aspectRatio: CanvasAspectRatio | undefined,
): CameraPlacementPreset {
  return aspectRatio === "16:9" ? "side-by-side" : "circle-pip"
}

// ---------------------------------------------------------------------------
// Legacy ClipTransform <-> CameraFrame migration
// ---------------------------------------------------------------------------

// The 720p webcam assumption for migration/mirroring when the real camera
// source size is unknown — preset geometry never depends on it, only crops do.
const FALLBACK_CAMERA_SOURCE: CameraSourceSize = { width: 1280, height: 720 }

// Geometry match tolerance between a stored transform and its preset rebuild.
const PRESET_GEOMETRY_TOLERANCE_PX = 1
// Named-aspect snap tolerance for pinned frames (relative, not px).
const FRAME_ASPECT_SNAP_TOLERANCE = 0.01

function snapFrameAspect(aspect: number): CameraFrame["aspect"] {
  for (const [name, value] of Object.entries(NAMED_FRAME_ASPECTS)) {
    if (Math.abs(aspect - value) / value <= FRAME_ASPECT_SNAP_TOLERANCE) {
      return name as CameraFrame["aspect"]
    }
  }
  return aspect
}

function styleFromTransform(transform: ClipTransform, scale: number): CameraFrame["style"] {
  return {
    opacity: transform.opacity,
    borderWidth: (transform.borderWidth ?? 2) / scale,
    borderColor: transform.borderColor ?? "#ffffff",
    borderOpacity: transform.borderOpacity ?? 1,
    borderStyle: transform.borderStyle,
    borderGradient: transform.borderGradient,
    shadowEnabled: transform.shadowEnabled ?? true,
    shadowColor: transform.shadowColor ?? "var(--color-pip-shadow)",
    shadowBlur: (transform.shadowBlur ?? 16) / scale,
    shadowOffsetX: (transform.shadowOffsetX ?? 0) / scale,
    shadowOffsetY: (transform.shadowOffsetY ?? 6) / scale,
  }
}

/**
 * Recover `framing` from a legacy source crop: the zoom is how far the crop
 * shrank inside the aspect's cover crop, the focus its normalised centre.
 */
function framingFromCrop(
  transform: ClipTransform,
  aspect: number,
  source?: CameraSourceSize,
): CameraFrame["framing"] {
  const fallback = { focusX: 0.5, focusY: 0.5, zoom: 1 }
  const crop = transform.crop
  if (!source || !crop || crop.width <= 0 || crop.height <= 0) return fallback
  const sourceAspect = source.width / source.height
  const targetAspect = Math.max(0.01, aspect)
  let coverWidth: number
  let coverHeight: number
  if (targetAspect >= sourceAspect) {
    coverWidth = source.width
    coverHeight = source.width / targetAspect
  } else {
    coverWidth = source.height * targetAspect
    coverHeight = source.height
  }
  const zoom = Math.max(1, Math.min(coverWidth / crop.width, coverHeight / crop.height))
  return {
    focusX: clampUnit((crop.x + crop.width / 2) / source.width),
    focusY: clampUnit((crop.y + crop.height / 2) / source.height),
    zoom,
  }
}

/**
 * Migrate a pixel `ClipTransform` into a `CameraFrame`. A transform whose
 * `preset` still matches the preset's rebuild becomes `origin: "auto"`;
 * anything else is `pinned` so it keeps its fractions across canvas changes.
 */
export function cameraFrameFromLegacyTransform(
  transform: ClipTransform,
  canvas: CameraFrameCanvas,
  source?: CameraSourceSize,
): CameraFrame {
  const scale = cameraStyleScale(canvas)
  const style = styleFromTransform(transform, scale)
  const preset = transform.preset

  if (preset) {
    const expected = buildCameraPresetTransform(preset, {
      canvas,
      source: source ?? FALLBACK_CAMERA_SOURCE,
    })
    const matches =
      Math.abs(transform.x - expected.x) <= PRESET_GEOMETRY_TOLERANCE_PX &&
      Math.abs(transform.y - expected.y) <= PRESET_GEOMETRY_TOLERANCE_PX &&
      Math.abs(transform.width - expected.width) <= PRESET_GEOMETRY_TOLERANCE_PX &&
      Math.abs(transform.height - expected.height) <= PRESET_GEOMETRY_TOLERANCE_PX &&
      transform.shape === expected.shape
    if (matches) {
      const frame = autoCameraFrame({ preset, aspectRatio: canvas.aspectRatio })
      const aspect = effectiveFrameAspect(frame, canvas, source)
      return {
        ...frame,
        style,
        framing: framingFromCrop(transform, aspect, source),
        visible: transform.visible,
      }
    }
  }

  const short = cameraShortEdge(canvas)
  const coversCanvas =
    transform.x <= 0 &&
    transform.y <= 0 &&
    transform.x + transform.width >= canvas.width &&
    transform.y + transform.height >= canvas.height
  const rectAspect =
    transform.width > 0 && transform.height > 0
      ? transform.width / transform.height
      : FALLBACK_FRAME_ASPECT
  const freeWidth = Math.max(1, canvas.width - transform.width)
  const freeHeight = Math.max(1, canvas.height - transform.height)
  const snappedAspect: CameraFrame["aspect"] = coversCanvas ? "source" : snapFrameAspect(rectAspect)
  const effectiveAspect = coversCanvas
    ? canvas.width / Math.max(1, canvas.height)
    : typeof snappedAspect === "number"
      ? snappedAspect
      : snappedAspect === "source"
        ? source && source.height > 0
          ? source.width / source.height
          : rectAspect
        : (NAMED_FRAME_ASPECTS[snappedAspect] ?? rectAspect)

  return cameraFrameSchema.parse({
    placement: coversCanvas
      ? { mode: "full", origin: "pinned" }
      : {
          mode: "overlay",
          origin: "pinned",
          anchorTo: "canvas",
          margin: 0,
          align: {
            x: clampUnit(transform.x / freeWidth),
            y: clampUnit(transform.y / freeHeight),
          },
          size: Math.max(0.01, transform.height / short),
        },
    shape: transform.shape,
    aspect: snappedAspect,
    style,
    framing: framingFromCrop(transform, effectiveAspect, source),
    preset,
    visible: transform.visible,
  })
}

/**
 * Mirror a `CameraFrame` back into a pixel `ClipTransform` so older app
 * versions keep reading the camera. `origin: "auto"` + `preset` mirrors the
 * preset's own pixel geometry (what the legacy canvas rebuild produced);
 * pinned frames are resolved at the given canvas.
 */
export function legacyTransformFromFrame(
  frame: CameraFrame,
  canvas: CameraFrameCanvas,
  source?: CameraSourceSize,
): ClipTransform {
  const scale = cameraStyleScale(canvas)

  if (frame.placement.origin === "auto" && frame.preset) {
    const transform = buildCameraPresetTransform(frame.preset, {
      canvas,
      source: source ?? FALLBACK_CAMERA_SOURCE,
    })
    return {
      ...transform,
      crop: source
        ? cameraCoverCrop(source, transform.width / Math.max(1, transform.height), frame.framing)
        : transform.crop,
      opacity: frame.style.opacity,
      shape: frame.shape,
      visible: frame.visible,
      borderWidth: frame.style.borderWidth * scale,
      borderColor: frame.style.borderColor,
      borderOpacity: frame.style.borderOpacity,
      borderStyle: frame.style.borderStyle,
      borderGradient: frame.style.borderGradient,
      shadowEnabled: frame.style.shadowEnabled,
      shadowColor: frame.style.shadowColor,
      shadowBlur: frame.style.shadowBlur * scale,
      shadowOffsetX: frame.style.shadowOffsetX * scale,
      shadowOffsetY: frame.style.shadowOffsetY * scale,
    }
  }

  const { camera } = resolvePlacementRect(
    frame.placement,
    effectiveFrameAspect(frame, canvas, source),
    canvas,
  )
  const rect = {
    x: Math.round(camera.x),
    y: Math.round(camera.y),
    width: Math.round(camera.width),
    height: Math.round(camera.height),
  }
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    crop: cameraCoverCrop(source, rect.width / Math.max(1, rect.height), frame.framing),
    opacity: frame.style.opacity,
    shape: frame.shape,
    visible: frame.visible,
    borderWidth: frame.style.borderWidth * scale,
    borderColor: frame.style.borderColor,
    borderOpacity: frame.style.borderOpacity,
    borderStyle: frame.style.borderStyle,
    borderGradient: frame.style.borderGradient,
    shadowEnabled: frame.style.shadowEnabled,
    shadowColor: frame.style.shadowColor,
    shadowBlur: frame.style.shadowBlur * scale,
    shadowOffsetX: frame.style.shadowOffsetX * scale,
    shadowOffsetY: frame.style.shadowOffsetY * scale,
    preset: frame.preset,
    locked: false,
  }
}

/**
 * Whether `framing` equals the centred cover default — the same crop Rust's
 * `fit: cover` produces, so the render plan needn't serialize it.
 */
export function cameraFramingIsDefault(framing: CameraFrame["framing"]): boolean {
  return framing.focusX === 0.5 && framing.focusY === 0.5 && framing.zoom === 1
}

/** The clip's frame when present, else migrated from its legacy transform. */
export function getCameraFrame(
  clip: Pick<CameraClip, "transform"> & { frame?: CameraFrame },
  canvas: CameraFrameCanvas,
  source?: CameraSourceSize,
): CameraFrame {
  return clip.frame ?? cameraFrameFromLegacyTransform(clip.transform, canvas, source)
}

/**
 * Resolve a frame to canvas px, then apply the active layout-lane window.
 * Lane kinds map onto the same placements: `pip` overrides the overlay,
 * `fullscreen` covers the canvas, `side-by-side` uses the lane split spec and
 * `hidden` fades the base rect to opacity 0 — all inside the existing
 * windows/evaluate/blend machinery, so transitions are unchanged.
 */
export function resolveCameraFrame(input: ResolveCameraFrameInput): ResolvedCameraFrame {
  const { frame, canvas, source } = input
  const scale = cameraStyleScale(canvas)
  const { rect, screen } = resolveFramePlacement(frame, canvas, source)
  const basePose: CameraLayoutPose = {
    camera: rect,
    screen,
    radius: cameraFrameRadius(rect, frame.shape, frame.cornerRadius),
    opacity: frame.style.opacity,
    shape: frame.shape,
  }

  let pose = basePose
  let layout: CameraLayoutKind | "base" = "base"
  let segmentId: string | null = null
  const segments = input.segments ?? []
  const timeMs = input.timeMs
  if (segments.length > 0 && timeMs !== undefined) {
    const windows = resolveCameraLayoutWindows(canvas, segments, { base: basePose })
    const window = windows
      .filter((candidate) => timeMs >= candidate.startMs && timeMs < candidate.endMs)
      .pop()
    if (window) {
      pose = evaluateCameraLayoutWindow(window, timeMs)
      layout = window.segment.layout
      segmentId = window.segment.id
    }
  }

  const mode =
    layout === "fullscreen"
      ? "full"
      : layout === "side-by-side"
        ? "split"
        : layout === "pip"
          ? "overlay"
          : frame.placement.mode

  const rectAspect =
    pose.camera.width > 0 && pose.camera.height > 0
      ? pose.camera.width / pose.camera.height
      : FALLBACK_FRAME_ASPECT

  return {
    rect: pose.camera,
    screen: pose.screen,
    radius: pose.radius,
    opacity: pose.opacity,
    shape: pose.shape,
    visible: frame.visible ?? true,
    crop: cameraCoverCrop(source, rectAspect, frame.framing),
    style: {
      opacity: frame.style.opacity,
      borderWidth: frame.style.borderWidth * scale,
      borderColor: frame.style.borderColor,
      borderOpacity: frame.style.borderOpacity,
      borderStyle: frame.style.borderStyle,
      borderGradient: frame.style.borderGradient,
      shadowEnabled: frame.style.shadowEnabled,
      shadowColor: frame.style.shadowColor,
      shadowBlur: frame.style.shadowBlur * scale,
      shadowOffsetX: frame.style.shadowOffsetX * scale,
      shadowOffsetY: frame.style.shadowOffsetY * scale,
    },
    mode,
    layout,
    segmentId,
  }
}
