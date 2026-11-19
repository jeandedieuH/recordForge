import { z } from "zod"
import { titleDesignSchema } from "./title-design"
import { boundsSchema, recordingSmartZoomPresetSchema } from "./recording"
import {
  cursorEffectSettingsSchema,
  cursorIconPresetSchema,
  cursorSettingsSchema,
  cursorSmoothingSchema,
  defaultCursorSettings,
} from "./cursor"
import { timelineSelectionSchema } from "./selection"
import {
  captionDesignSchema,
  captionPlacementSchema,
  captionStylePresetSchema,
  captionWordTimingSchema,
  renderCaptionModeSchema,
} from "./captions"
import type { OverlayRenderPlan } from "./overlay"
import { keystrokeOverlaySettingsSchema } from "./keystrokes"
import { youtubePrivacySchema } from "./publish"

// Output framing presets are intentionally explicit so preview and export can
// reject unsupported aspect ratios instead of silently cropping the recording.
export const canvasAspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "5:4", "4:5"])
export type CanvasAspectRatio = z.infer<typeof canvasAspectRatioSchema>

export const zoomEasingSchema = z.enum([
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "smooth",
  "cinematic",
  "snappy",
  "spring",
])
export type ZoomEasing = z.infer<typeof zoomEasingSchema>

export const zoomTargetSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
})
export type ZoomTarget = z.infer<typeof zoomTargetSchema>

export const zoomModeSchema = z.enum(["auto", "manual", "static", "follow-cursor", "smooth-pan"])
export type ZoomMode = z.infer<typeof zoomModeSchema>

export const zoomSourceSchema = z.enum([
  "click",
  "dwell",
  "movement",
  "manual",
  "follow",
  "cluster",
])
export type ZoomSource = z.infer<typeof zoomSourceSchema>

export const zoomPresetSchema = recordingSmartZoomPresetSchema
export type ZoomPreset = z.infer<typeof zoomPresetSchema>

// ---------------------------------------------------------------------------
// Zoom clarity (detail plane + sharpening) and Glass Loupe
// ---------------------------------------------------------------------------

/**
 * How a zoom segment presents its magnification.
 *
 * - `frame` (default, every v1 segment) zooms the whole frame.
 * - `loupe` leaves the frame at its current zoom and magnifies the target
 *   inside a lens that floats over the recording.
 */
export const zoomStyleSchema = z.enum(["frame", "loupe"])
export type ZoomStyle = z.infer<typeof zoomStyleSchema>

/**
 * Sharpening applied when a zoomed crop still has to be upscaled past the
 * source resolution. `auto` derives the strength from the remaining upscale,
 * `strong` doubles it, `off` keeps the plain resample.
 */
export const zoomSharpeningSchema = z.enum(["off", "auto", "strong"]).default("auto")
export type ZoomSharpening = z.infer<typeof zoomSharpeningSchema>

export const loupeShapeSchema = z.enum(["circle", "rounded-rect"])
export type LoupeShape = z.infer<typeof loupeShapeSchema>

/**
 * Glass Loupe presentation. All lengths are canvas pixels except `size`,
 * which is the lens diameter as a fraction of the canvas short edge, and
 * `cornerRadius`, which is a fraction of the lens size.
 */
export const loupeSettingsSchema = z.object({
  shape: loupeShapeSchema.default("circle"),
  size: z.number().min(0.08).max(1).default(0.34),
  cornerRadius: z.number().min(0).max(0.5).default(0.24),
  ringWidth: z.number().min(0).max(64).default(6),
  ringColor: z.string().default("#ffffff"),
  ringOpacity: z.number().min(0).max(1).default(0.9),
  /** Inner highlight plus rim refraction; off renders a flat ring. */
  glass: z.boolean().default(true),
  shadowBlur: z.number().min(0).max(200).default(36),
  shadowOpacity: z.number().min(0).max(1).default(0.35),
  /** Reserved: the lens always rides the cursor while a cursor point exists;
      a parked-lens toggle would gate on this. Currently ignored. */
  followCursor: z.boolean().default(false),
  /** Lens centre in canvas pixels; defaults to the segment target centre.
      The magnified region still centres on the segment target — moving the
      parked lens does not move what it magnifies. */
  center: z.object({ x: z.number(), y: z.number() }).optional(),
  /** Nudge from the resolved centre (target centre or `center`). */
  offset: z.object({ x: z.number().default(0), y: z.number().default(0) }).optional(),
})
export type LoupeSettings = z.infer<typeof loupeSettingsSchema>

/**
 * Per-motion-source shutter fractions. A frame interval is
 * `1000 / canvas.fps` ms; `0.5` is a 180° cinema shutter (half a frame
 * interval), `1` blurs across the full frame interval (360° shutter), and `0`
 * disables blur for that source. Looks carry these too.
 */
export const motionBlurSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  cursor: z.number().min(0).max(1).default(0.5),
  zoom: z.number().min(0).max(1).default(0.5),
  pan: z.number().min(0).max(1).default(0.5),
})
export type MotionBlurSettings = z.infer<typeof motionBlurSettingsSchema>
export const defaultMotionBlurSettings: MotionBlurSettings = motionBlurSettingsSchema.parse({
  enabled: true,
})

// Smart zoom settings for AI/deterministic suggestion generation from telemetry.
export const smartZoomSettingsSchema = z.object({
  preset: zoomPresetSchema.default("product-demo"),
  minDwellMs: z.number().int().min(100).max(10_000).default(700),
  dwellTolerancePx: z.number().min(0).max(500).default(12),
  clickLeadInMs: z.number().int().min(0).max(5_000).default(500),
  clickDurationMs: z.number().int().min(100).max(10_000).default(1_400),
  dwellLeadInMs: z.number().int().min(0).max(5_000).default(350),
  dwellTailMs: z.number().int().min(0).max(10_000).default(700),
  minSegmentDurationMs: z.number().int().min(100).max(10_000).default(600),
  maxSegmentDurationMs: z.number().int().min(100).max(30_000).default(10_000),
  clusterToleranceMs: z.number().int().min(100).max(10_000).default(2_000),
  safeEdgePadding: z.number().min(0).max(1_000).default(32),
  targetScale: z.number().min(1.05).max(4).default(1.5),
  includeClicks: z.boolean().default(true),
  includeDwells: z.boolean().default(false),
  defaultTransitionInMs: z.number().int().min(0).max(5_000).default(380),
  defaultTransitionOutMs: z.number().int().min(0).max(5_000).default(380),
})

export type SmartZoomSettings = z.infer<typeof smartZoomSettingsSchema>
export const defaultSmartZoomSettings: SmartZoomSettings = smartZoomSettingsSchema.parse({})

// Canvas settings shared by the timeline, the preview, and the final render.
export const DEFAULT_CANVAS_BACKGROUND =
  "linear-gradient(135deg, #10b981 0%, #06b6d4 50%, #3b82f6 100%)"
export const backgroundFitSchema = z.enum(["cover", "contain", "fill"]).default("cover")
export type BackgroundFit = z.infer<typeof backgroundFitSchema>

// Frame border treatments (spec-010 canvas styles). `solid` is the plain stroke
// the camera bubble has always had; `gradient` ramps `borderGradient` around the
// ring; `double` paints two concentric strokes with a gap; `glass` paints a
// translucent rim with a bright inner highlight.
export const borderStyleSchema = z.enum(["solid", "gradient", "double", "glass"])
export type BorderStyle = z.infer<typeof borderStyleSchema>

// Two-colour ramp for `borderStyle: "gradient"`, measured in degrees clockwise
// from the top of the frame (135° runs top-left → bottom-right, matching the
// default background gradient).
export const borderGradientSchema = z.object({
  from: z.string(),
  to: z.string(),
  angle: z.number().min(0).max(360).default(135),
})
export type BorderGradient = z.infer<typeof borderGradientSchema>

export const timelineCanvasSchema = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  fps: z.number().int().min(1),
  background: z.string().default(DEFAULT_CANVAS_BACKGROUND),
  padding: z.number().min(0).default(0),
  borderRadius: z.number().min(0).default(0),
  shadow: z.boolean().default(false),
  // These fields are optional for backwards-compatible v1 project files. New
  // canvas edits persist them, and render helpers apply safe defaults when absent.
  aspectRatio: canvasAspectRatioSchema.optional(),
  videoPositionY: z.number().min(0).max(1).default(0.5).optional(),
  shadowColor: z.string().optional(),
  shadowBlur: z.number().min(0).optional(),
  shadowOffsetX: z.number().optional(),
  shadowOffsetY: z.number().optional(),
  backgroundBlur: z.number().min(0).max(100).optional(),
  backgroundDim: z.number().min(0).max(1).optional(),
  backgroundFit: backgroundFitSchema.optional(),
  // Frame border. Like the other canvas styling fields these stay optional so
  // v1 project files load unchanged and the render helpers apply defaults.
  borderWidth: z.number().min(0).max(200).optional(),
  borderColor: z.string().optional(),
  borderOpacity: z.number().min(0).max(1).optional(),
  borderStyle: borderStyleSchema.optional(),
  borderGradient: borderGradientSchema.optional(),
  // Zoom clarity (M2 #3): sharpening for the source-resolution detail plane,
  // and cinematic motion blur for zoom/pan/cursor movement (Pro).
  zoomSharpening: zoomSharpeningSchema.optional(),
  motionBlur: motionBlurSettingsSchema.optional(),
  cursorSettings: cursorSettingsSchema.default(defaultCursorSettings),
})

export type TimelineCanvas = z.infer<typeof timelineCanvasSchema>

// Defined camera placement presets. These make it easy to switch between common
// picture-in-picture layouts without manual coordinate entry.
export const cameraPlacementPresetSchema = z.enum([
  "camera-only",
  "vertical-pip",
  "circle-pip",
  "side-by-side",
])
export type CameraPlacementPreset = z.infer<typeof cameraPlacementPresetSchema>

// Visual transform for a picture-in-picture camera clip. Crop coordinates are
// expressed in source pixels, while x/y/width/height are canvas pixels.
export const clipTransformSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().min(0).default(0),
  height: z.number().min(0).default(0),
  crop: boundsSchema.optional(),
  opacity: z.number().min(0).max(1).default(1),
  shape: z.enum(["rectangle", "rounded", "circle"]).default("rectangle"),
  visible: z.boolean().optional(),
  borderWidth: z.number().min(0).optional(),
  borderColor: z.string().optional(),
  borderOpacity: z.number().min(0).max(1).optional(),
  borderStyle: borderStyleSchema.optional(),
  borderGradient: borderGradientSchema.optional(),
  shadowEnabled: z.boolean().optional(),
  shadowColor: z.string().optional(),
  shadowBlur: z.number().min(0).optional(),
  shadowOffsetX: z.number().optional(),
  shadowOffsetY: z.number().optional(),
  preset: cameraPlacementPresetSchema.optional(),
  locked: z.boolean().optional(),
})

export type ClipTransform = z.infer<typeof clipTransformSchema>

// Camera colour grade (#4a). Adjustments and an optional 3D LUT are composed
// into one cube by the overlay engine, so the preview (WASM/WebGL2) and both
// export renderers sample exactly the same table. `lutId` is either a bundled
// look id (`look:<name>`) or a project asset id imported from a `.cube` file.
export const BUNDLED_CAMERA_LUT_IDS = [
  "look:warm",
  "look:cool",
  "look:film",
  "look:teal-orange",
  "look:mono",
  "look:vivid",
  "look:matte",
] as const
export type BundledCameraLutId = (typeof BUNDLED_CAMERA_LUT_IDS)[number]

export const BUNDLED_CAMERA_LUTS: ReadonlyArray<{ id: BundledCameraLutId; label: string }> = [
  { id: "look:warm", label: "Warm" },
  { id: "look:cool", label: "Cool" },
  { id: "look:film", label: "Film" },
  { id: "look:teal-orange", label: "Teal & Orange" },
  { id: "look:mono", label: "Mono" },
  { id: "look:vivid", label: "Vivid" },
  { id: "look:matte", label: "Matte" },
]

export const cameraColorSchema = z.object({
  /** Exposure in stops (-2…+2). */
  exposure: z.number().min(-2).max(2).default(0),
  /** -1 flattest, +1 punchiest. */
  contrast: z.number().min(-1).max(1).default(0),
  /** -1 monochrome, +1 vivid. */
  saturation: z.number().min(-1).max(1).default(0),
  /** -1 cooler/blue, +1 warmer/amber. */
  temperature: z.number().min(-1).max(1).default(0),
  /** -1 green, +1 magenta. */
  tint: z.number().min(-1).max(1).default(0),
  /** Bundled `look:*` id or a project `.cube` asset id. */
  lutId: z.string().optional(),
  lutIntensity: z.number().min(0).max(1).default(1),
})
export type CameraColor = z.infer<typeof cameraColorSchema>

export const cameraCutoutBackgroundSchema = z.enum(["none", "blur", "color", "image"])
export type CameraCutoutBackground = z.infer<typeof cameraCutoutBackgroundSchema>

// Portrait cutout (#4b). The matte itself is an offline derivative job; these
// fields only describe how the derived alpha is composited.
export const cameraCutoutSchema = z.object({
  enabled: z.boolean().default(false),
  background: cameraCutoutBackgroundSchema.default("none"),
  blurRadius: z.number().min(0).max(100).default(18),
  color: z.string().default("#0f172a"),
  imageAssetId: z.string().optional(),
  /** Matte edge softening in matte pixels (0…16). */
  edgeSoftness: z.number().min(0).max(16).default(2),
  /** Pulls the matte in (positive) or expands it (negative), in matte pixels. */
  edgeShrink: z.number().min(-8).max(8).default(0),
})
export type CameraCutout = z.infer<typeof cameraCutoutSchema>

export const cameraFaceFramingSchema = z.enum(["tight", "medium", "wide"])
export type CameraFaceFraming = z.infer<typeof cameraFaceFramingSchema>

// Face-tracked framing (#4c). The face detector runs offline at ~8 Hz; the
// resolver turns its boxes into a smoothed, fixed-size source crop.
export const cameraFaceTrackingSchema = z.object({
  enabled: z.boolean().default(false),
  framing: cameraFaceFramingSchema.default("medium"),
  /** One-Euro smoothing strength, 0…1 (higher = calmer). */
  smoothness: z.number().min(0).max(1).default(0.6),
  /** Headroom above the face box, as a fraction of the crop height. */
  headroom: z.number().min(0).max(1).default(0.12),
})
export type CameraFaceTracking = z.infer<typeof cameraFaceTrackingSchema>

// Zoom ranges are timeline effects rather than media clips. The target is
// clamped to the canvas before it reaches either the preview or the exporter.
// Optional Phase 9 metadata keeps v1 manual zooms readable while distinguishing
// generated suggestions from user-authored ranges.
export const manualZoomSegmentSchema = z.object({
  id: z.string(),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  durationMs: z.number().transform(Math.round).pipe(z.number().int().min(1)),
  target: zoomTargetSchema,
  scale: z.number().min(1).max(8).default(1.5),
  easing: zoomEasingSchema.default("smooth"),
  transitionInMs: z.number().int().min(0).max(10_000).optional(),
  transitionOutMs: z.number().int().min(0).max(10_000).optional(),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
  mode: zoomModeSchema.optional(),
  source: zoomSourceSchema.optional(),
  preset: zoomPresetSchema.optional(),
  followDeadzonePercent: z.number().min(0.01).max(0.5).optional(),
  followSmoothingAlpha: z.number().min(0.05).max(1.0).optional(),
  // Named follow-camera speed; mirrors cursor-core's followSpeedSchemaValues.
  // Legacy segments may carry followSmoothingAlpha instead — the camera maps
  // it to a smooth time. Deliberately absent from the render-plan schema:
  // export consumes the baked motion plan only.
  followSpeed: z.enum(["relaxed", "balanced", "tight"]).optional(),
  label: z.string().optional(),
  // Glass Loupe (#2). Absent/`frame` keeps every v1 segment zooming the frame.
  style: zoomStyleSchema.optional(),
  loupe: loupeSettingsSchema.optional(),
})

export type ManualZoomSegment = z.infer<typeof manualZoomSegmentSchema>
export const zoomSegmentSchema = manualZoomSegmentSchema
export type ZoomSegment = ManualZoomSegment

// Camera layouts (modern-features #5) are a timeline-effect lane like zoom
// segments: outside every segment the clip transform is the base layout, and a
// segment animates the camera between layouts. Rects, radius and opacity are
// interpolated so a circle can morph into a rectangle through the radius.
export const cameraLayoutKindSchema = z.enum(["pip", "fullscreen", "hidden", "side-by-side"])
export type CameraLayoutKind = z.infer<typeof cameraLayoutKindSchema>

export const cameraLayoutCornerSchema = z.enum(["tl", "tr", "bl", "br", "custom"])
export type CameraLayoutCorner = z.infer<typeof cameraLayoutCornerSchema>

export const cameraLayoutPipSchema = z.object({
  corner: cameraLayoutCornerSchema.default("br"),
  // Camera height as a fraction of the canvas height (0.24 ≈ a classic PiP).
  sizeFraction: z.number().min(0.05).max(0.6).default(0.24),
  shape: z.enum(["rectangle", "rounded", "circle"]).default("rounded"),
  // Canvas-fraction pin for `corner: "custom"`; ignored otherwise.
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
})
export type CameraLayoutPip = z.infer<typeof cameraLayoutPipSchema>

export const cameraLayoutSourceSchema = z.enum(["manual", "silence"])
export type CameraLayoutSource = z.infer<typeof cameraLayoutSourceSchema>

export const cameraLayoutSegmentSchema = z.object({
  id: z.string(),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  durationMs: z.number().transform(Math.round).pipe(z.number().int().min(1)),
  layout: cameraLayoutKindSchema,
  pip: cameraLayoutPipSchema.optional(),
  transitionInMs: z.number().int().min(0).max(10_000).default(400),
  transitionOutMs: z.number().int().min(0).max(10_000).default(400),
  easing: zoomEasingSchema.default("smooth"),
  // `silence` segments come from hide-during-silence generation (#4d).
  source: cameraLayoutSourceSchema.default("manual"),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
  label: z.string().optional(),
})
export type CameraLayoutSegment = z.infer<typeof cameraLayoutSegmentSchema>

// Core clip fields. Clips are non-destructive references into source media.
export const timelineClipBaseSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  // Stream index keeps multiplexed video and audio sources independently editable.
  streamIndex: z.number().int().min(0).optional(),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  durationMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  sourceInMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  sourceOutMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  speed: z.number().positive().default(1),
  // Optional clip-group membership. Clips sharing a groupId select and edit as
  // one unit; optional so v1 projects load unchanged.
  groupId: z.string().optional(),
})

export type TimelineClipBase = z.infer<typeof timelineClipBaseSchema>

// Screen clip: a slice of the captured display/window/region source.
export const screenClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("screen"),
})

export type ScreenClip = z.infer<typeof screenClipSchema>

// ---------------------------------------------------------------------------
// Camera frame model (ADR 023)
// ---------------------------------------------------------------------------

/**
 * Corner radius as a fraction of the frame's shorter side. This is the single
 * canonical value: the editor-core resolver emits px radii derived from it and
 * every surface (preview, both exporters, mask generation) consumes those px
 * values instead of re-deriving the fraction.
 */
export const CAMERA_CORNER_RADIUS_FRACTION = 0.12

export const cameraFrameModeSchema = z.enum(["overlay", "split", "full"])
export type CameraFrameMode = z.infer<typeof cameraFrameModeSchema>

export const cameraFrameShapeSchema = z.enum(["rectangle", "rounded", "circle"])
export type CameraFrameShape = z.infer<typeof cameraFrameShapeSchema>

/**
 * Frame aspect as width/height. `source` tracks the camera source aspect; a
 * named ratio or a positive number pins the box. `circle` shapes and `full`
 * placements ignore it (forced to 1:1 and the canvas aspect respectively).
 */
export const cameraFrameAspectSchema = z.union([
  z.enum(["source", "1:1", "4:3", "3:4", "5:7", "16:9", "9:16"]),
  z.number().positive(),
])
export type CameraFrameAspect = z.infer<typeof cameraFrameAspectSchema>

export const cameraFrameSideSchema = z.enum(["left", "right", "top", "bottom"])
export type CameraFrameSide = z.infer<typeof cameraFrameSideSchema>

export const cameraFrameAlignSchema = z.object({
  x: z.number().min(0).max(1).default(1),
  y: z.number().min(0).max(1).default(1),
})
export type CameraFrameAlign = z.infer<typeof cameraFrameAlignSchema>

// Side-by-side split. `ratio` is the screen slot's share of the anchor area,
// `gap` the spacing between the slots (both fractions of the area), and `fit`
// chooses a canvas-aspect "frame" slot or a full-height/-width "column" slot.
export const cameraFrameSplitSchema = z.object({
  side: cameraFrameSideSchema.default("right"),
  ratio: z.number().min(0).max(1).default(0.76),
  gap: z.number().min(0).max(1).default(0.02),
  fit: z.enum(["frame", "column"]).default("frame"),
})
export type CameraFrameSplit = z.infer<typeof cameraFrameSplitSchema>

// Resolution-independent placement. `size` and `margin` are fractions of the
// canvas SHORT edge; `align` positions the frame inside the margin-inset
// anchor area ((1,1) = bottom-right). `origin` records whether the placement
// came from the auto policy ("auto" — rebuilt on ratio changes) or a manual
// pin ("pinned" — keeps its fractions).
export const cameraFramePlacementSchema = z.object({
  mode: cameraFrameModeSchema.default("overlay"),
  align: cameraFrameAlignSchema.default(() => cameraFrameAlignSchema.parse({})),
  size: z.number().positive().default(0.311),
  margin: z.number().min(0).default(0.022),
  anchorTo: z.enum(["content", "canvas"]).default("canvas"),
  split: cameraFrameSplitSchema.default(() => cameraFrameSplitSchema.parse({})),
  origin: z.enum(["auto", "pinned"]).default("auto"),
})
export type CameraFramePlacement = z.infer<typeof cameraFramePlacementSchema>

// Frame chrome. Lengths are DESIGN UNITS: px on a 1080-short-edge canvas,
// multiplied by `shortEdge / 1080` when the frame is resolved.
export const cameraFrameStyleSchema = z.object({
  opacity: z.number().min(0).max(1).default(1),
  borderWidth: z.number().min(0).default(2),
  borderColor: z.string().default("#ffffff"),
  borderOpacity: z.number().min(0).max(1).default(1),
  borderStyle: borderStyleSchema.optional(),
  borderGradient: borderGradientSchema.optional(),
  shadowEnabled: z.boolean().default(true),
  shadowColor: z.string().default("var(--color-pip-shadow)"),
  shadowBlur: z.number().min(0).default(16),
  shadowOffsetX: z.number().default(0),
  shadowOffsetY: z.number().default(6),
})
export type CameraFrameStyle = z.infer<typeof cameraFrameStyleSchema>

// Source-window framing inside the cover crop: `focus` positions the crop
// centre (0.5 = centred) and `zoom >= 1` shrinks the crop around it.
export const cameraFrameFramingSchema = z.object({
  focusX: z.number().min(0).max(1).default(0.5),
  focusY: z.number().min(0).max(1).default(0.5),
  zoom: z.number().min(1).default(1),
})
export type CameraFrameFraming = z.infer<typeof cameraFrameFramingSchema>

// One resolution-independent camera spec (ADR 023). Additive on camera clips:
// when present it wins over the pixel `transform`, which is kept in sync for
// older app versions.
export const cameraFrameSchema = z.object({
  placement: cameraFramePlacementSchema.default(() => cameraFramePlacementSchema.parse({})),
  shape: cameraFrameShapeSchema.default("rounded"),
  aspect: cameraFrameAspectSchema.default("5:7"),
  cornerRadius: z.number().min(0).max(0.5).default(CAMERA_CORNER_RADIUS_FRACTION),
  style: cameraFrameStyleSchema.default(() => cameraFrameStyleSchema.parse({})),
  framing: cameraFrameFramingSchema.default(() => cameraFrameFramingSchema.parse({})),
  preset: cameraPlacementPresetSchema.optional(),
  visible: z.boolean().optional(),
})
export type CameraFrame = z.infer<typeof cameraFrameSchema>

// Camera clip: a picture-in-picture webcam slice with position, size, and shape.
export const cameraClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("camera"),
  transform: clipTransformSchema.default(() => clipTransformSchema.parse({})),
  // ADR 023: resolution-independent frame spec; wins over `transform` when set.
  frame: cameraFrameSchema.optional(),
  // M4 camera effects. All optional so v1 projects load unchanged.
  color: cameraColorSchema.optional(),
  cutout: cameraCutoutSchema.optional(),
  faceTracking: cameraFaceTrackingSchema.optional(),
})

export type CameraClip = z.infer<typeof cameraClipSchema>

export const audioRoleSchema = z.enum(["microphone", "system_audio", "music", "other"])
export type AudioRole = z.infer<typeof audioRoleSchema>

export const maskModeSchema = z.enum(["blur", "pixelate", "redact"])
export type MaskMode = z.infer<typeof maskModeSchema>

export const maskColorSchema = z
  .string()
  .regex(/^(?:#[0-9a-fA-F]{6}|[a-zA-Z]+)$/, "Mask color must be a hex or named color")
export type MaskColor = z.infer<typeof maskColorSchema>

export const maskRectSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
})
export type MaskRect = z.infer<typeof maskRectSchema>

// Audio volume keyframe: a point in the clip's dynamic volume envelope.
export const audioVolumeKeyframeSchema = z.object({
  id: z.string(),
  timeMs: z.number().min(0),
  volume: z.number().min(0).max(2),
})

export type AudioVolumeKeyframe = z.infer<typeof audioVolumeKeyframeSchema>

// Audio clip: an audio source slice with volume and fade controls.
export const audioClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("audio"),
  role: audioRoleSchema.optional(),
  volume: z.number().min(0).max(2).default(1),
  fadeInMs: z.number().min(0).default(0),
  fadeOutMs: z.number().min(0).default(0),
  volumeKeyframes: z.array(audioVolumeKeyframeSchema).optional(),
})

export type AudioClip = z.infer<typeof audioClipSchema>

// Caption clip: a timed text cue on the captions track.
export const captionClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("caption"),
  text: z.string().min(1),
  style: captionStylePresetSchema.default("default"),
  placement: captionPlacementSchema.optional(),
  // Measured per-display-token timings (AI transcripts), RELATIVE to
  // clip.startMs — relative storage means move-clips needs no changes.
  // Absent → the layout engine falls back to proportional weighting.
  words: z.array(captionWordTimingSchema).optional(),
  // Container-time provenance for each display token (absolute ms in the
  // recording asset). Present iff the cue is an unedited AI-derived caption;
  // cleared together with `words` on text edits. Resync re-maps these
  // through the current audio coverage instead of re-running whisper.
  sourceWords: z.array(captionWordTimingSchema).optional(),
  // Absolute ffprobe stream index the cue was transcribed from.
  sourceStreamIndex: z.number().int().min(0).nullish(),
  // Deprecated: kept for project-file compatibility; the caption layout
  // engine derives margins from the aspect-ratio profile instead.
  safeAreaMargin: z.number().int().min(0).max(2_000).optional(),
})

export type CaptionClip = z.infer<typeof captionClipSchema>

// Static privacy mask clip. Coordinates are in output-canvas pixels so the
// preview and exporter can apply the same rectangle without source-frame IPC.
export const maskClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("mask"),
  mode: maskModeSchema,
  rect: maskRectSchema,
  blurRadius: z.number().min(1).max(128).default(24),
  pixelSize: z.number().int().min(2).max(128).default(12),
  redactColor: maskColorSchema.default("black"),
  enabled: z.boolean().default(true),
})

export type MaskClip = z.infer<typeof maskClipSchema>

// Cursor effects are timeline ranges rather than source-media clips. The
// source fields stay optional-compatible with the existing clip engine so
// generic selection, movement, and persistence code can handle the range.
export const cursorEffectClipSchema = z.object({
  id: z.string(),
  kind: z.literal("cursor-effect"),
  assetId: z.string(),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  durationMs: z.number().transform(Math.round).pipe(z.number().int().min(1)),
  sourceInMs: z.number().transform(Math.round).pipe(z.number().int().min(0)).default(0),
  sourceOutMs: z.number().transform(Math.round).pipe(z.number().int().min(0)).default(0),
  speed: z.number().positive().default(1),
  presetId: cursorIconPresetSchema.default("recorded-system"),
  scale: z.number().min(0.2).max(5).default(1),
  smoothing: cursorSmoothingSchema.default("smooth"),
  settings: cursorEffectSettingsSchema.default({}),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
  // Cursor ranges can join clip groups so a range moves with its media clips.
  groupId: z.string().optional(),
})

export type CursorEffectClip = z.infer<typeof cursorEffectClipSchema>

export const overlayAnimationTypeSchema = z.enum([
  "none",
  "fade",
  "scale-up",
  "scale-down",
  "slide-up",
  "slide-down",
  "slide-left",
  "slide-right",
  "pop-in",
  "bounce",
  "draw",
  "typewriter",
])
export type OverlayAnimationType = z.infer<typeof overlayAnimationTypeSchema>

export const overlayAnimationOutTypeSchema = z.enum([
  "none",
  "fade",
  "scale-up",
  "scale-down",
  "slide-up",
  "slide-down",
  "slide-left",
  "slide-right",
])
export type OverlayAnimationOutType = z.infer<typeof overlayAnimationOutTypeSchema>

export const overlayEasingSchema = z.enum([
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "expo-out",
])
export type OverlayEasing = z.infer<typeof overlayEasingSchema>

export const overlayAnimationSchema = z.object({
  inType: overlayAnimationTypeSchema.default("fade"),
  outType: overlayAnimationOutTypeSchema.default("fade"),
  inDurationMs: z.number().int().min(0).default(350),
  outDurationMs: z.number().int().min(0).default(350),
  easing: overlayEasingSchema.default("expo-out"),
})
export type OverlayAnimation = z.infer<typeof overlayAnimationSchema>

// Annotation clip: on-canvas shapes, arrows, lines, callouts, spotlights, and badges.
export const annotationTypeSchema = z.enum([
  "rectangle",
  "rounded-rect",
  "circle",
  "arrow",
  "line",
  "callout",
  "spotlight",
  "badge",
])
export type AnnotationType = z.infer<typeof annotationTypeSchema>

export const annotationStrokeStyleSchema = z.enum(["solid", "dashed", "dotted"])
export type AnnotationStrokeStyle = z.infer<typeof annotationStrokeStyleSchema>

export const annotationHeadSchema = z.enum(["none", "arrow", "circle", "diamond"])
export type AnnotationHead = z.infer<typeof annotationHeadSchema>

// Connector routing for arrow/line strokes and callout leader lines.
export const annotationArrowStyleSchema = z.enum(["straight", "elbow", "curved"])
export type AnnotationArrowStyle = z.infer<typeof annotationArrowStyleSchema>

export const annotationAnimationSchema = z.enum([
  "none",
  "fade",
  "scale-up",
  "draw",
  "slide-up",
  "scale-down",
  "slide-down",
])
export type AnnotationAnimation = z.infer<typeof annotationAnimationSchema>

export const annotationClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("annotation"),
  annotationType: annotationTypeSchema.default("rectangle"),
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().min(0).default(240),
  height: z.number().min(0).default(140),
  rotation: z.number().default(0),
  anchorX: z.number().min(0).max(1).default(0.5),
  anchorY: z.number().min(0).max(1).default(0.5),
  zIndex: z.number().int().default(0),
  opacity: z.number().min(0).max(1).default(1),
  endX: z.number().optional(),
  endY: z.number().optional(),
  strokeColor: z.string().default("#38bdf8"),
  strokeWidth: z.number().min(0).max(64).default(4),
  strokeStyle: annotationStrokeStyleSchema.default("solid"),
  fillColor: z.string().default("#38bdf8"),
  fillOpacity: z.number().min(0).max(1).default(0),
  cornerRadius: z.number().min(0).max(100).default(8),
  arrowEndHead: annotationHeadSchema.default("arrow"),
  arrowStartHead: annotationHeadSchema.default("none"),
  arrowStyle: annotationArrowStyleSchema.default("straight"),
  shadowEnabled: z.boolean().default(false),
  shadowColor: z.string().default("rgba(0, 0, 0, 0.5)"),
  shadowBlur: z.number().min(0).max(100).default(8),
  text: z.string().optional(),
  textColor: z.string().default("#ffffff"),
  fontSize: z.number().min(8).max(120).default(16),
  animationIn: annotationAnimationSchema.default("fade"),
  animationOut: annotationAnimationSchema.default("fade"),
  overlayAnimation: overlayAnimationSchema.default(() => overlayAnimationSchema.parse({})),
  presetId: z.string().default(""),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
})

export type AnnotationClip = z.infer<typeof annotationClipSchema>

// Text / Title preset categories and backdrop styling options. The v2 browser
// groups presets into openers/social/tutorial/data/outro; the original values
// stay valid so custom presets saved before M5 keep loading.
export const titlePresetCategorySchema = z.enum([
  "title",
  "lower-third",
  "callout",
  "badge",
  "minimal",
  "openers",
  "social",
  "tutorial",
  "data",
  "outro",
])
export type TitlePresetCategory = z.infer<typeof titlePresetCategorySchema>

export const textBackdropStyleSchema = z.enum([
  "none",
  "solid",
  "glass",
  "accent-bar",
  "pill",
  "gradient",
  "outline",
])
export type TextBackdropStyle = z.infer<typeof textBackdropStyleSchema>

export const textFontFamilySchema = z.enum(["sans", "serif", "mono", "heading", "inter", "outfit"])
export type TextFontFamily = z.infer<typeof textFontFamilySchema>

const FONT_WEIGHT_MAP: Record<string, string> = {
  normal: "400",
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  extrabold: "800",
  black: "900",
}

export const textFontWeightSchema = z.preprocess(
  (val) => {
    if (typeof val === "number") {
      return String(val)
    }
    if (typeof val === "string") {
      const lower = val.toLowerCase()
      if (FONT_WEIGHT_MAP[lower]) return FONT_WEIGHT_MAP[lower]
    }
    return val
  },
  z.enum(["400", "500", "600", "700", "800", "900"]),
)
export type TextFontWeight = z.infer<typeof textFontWeightSchema>

export const textAlignmentSchema = z.enum(["left", "center", "right"])
export type TextAlignment = z.infer<typeof textAlignmentSchema>

export const textAnimationSchema = z.enum([
  "none",
  "fade",
  "slide-up",
  "slide-down",
  "slide-left",
  "slide-right",
  "typewriter",
  "zoom-punch",
  "expand-bar",
  "pop-in",
  "bounce",
])
export type TextAnimation = z.infer<typeof textAnimationSchema>

export const textClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("text"),
  presetId: z.string().default("title-modern"),
  titleDesign: titleDesignSchema.optional(),
  category: titlePresetCategorySchema.default("title"),
  primaryText: z.string().min(1).default("Title Text"),
  secondaryText: z.string().optional(),
  tagText: z.string().optional(),
  x: z.number().default(60),
  y: z.number().default(60),
  width: z.number().min(20).default(460),
  height: z.number().min(20).default(160),
  rotation: z.number().default(0),
  anchorX: z.number().min(0).max(1).default(0.5),
  anchorY: z.number().min(0).max(1).default(0.5),
  zIndex: z.number().int().default(0),
  opacity: z.number().min(0).max(1).default(1),
  alignment: textAlignmentSchema.default("left"),
  fontFamily: textFontFamilySchema.default("sans"),
  fontSize: z.number().min(8).max(200).default(36),
  fontWeight: textFontWeightSchema.default("700"),
  textColor: z.string().default("#ffffff"),
  secondaryTextColor: z.string().default("#94a3b8"),
  accentColor: z.string().default("#38bdf8"),
  backdropStyle: textBackdropStyleSchema.default("none"),
  backdropColor: z.string().default("#0f172a"),
  backdropOpacity: z.number().min(0).max(1).default(0.8),
  backdropBlur: z.number().min(0).max(64).default(12),
  backdropBorderRadius: z.number().min(0).max(100).default(8),
  backdropPaddingX: z.number().min(0).max(200).default(24),
  backdropPaddingY: z.number().min(0).max(200).default(16),
  shadowEnabled: z.boolean().default(false),
  shadowColor: z.string().default("rgba(0, 0, 0, 0.5)"),
  shadowBlur: z.number().min(0).max(100).default(10),
  animationIn: textAnimationSchema.default("fade"),
  animationOut: textAnimationSchema.default("fade"),
  overlayAnimation: overlayAnimationSchema.default(() => overlayAnimationSchema.parse({})),
  autoScaleText: z.boolean().default(true),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
})

export type TextClip = z.infer<typeof textClipSchema>

// External image / graphic overlay clip.
export const imageFitSchema = z.enum(["contain", "cover", "fill"])
export type ImageFit = z.infer<typeof imageFitSchema>

export const imageClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("image"),
  x: z.number().default(60),
  y: z.number().default(60),
  width: z.number().min(10).default(320),
  height: z.number().min(10).default(200),
  rotation: z.number().default(0),
  anchorX: z.number().min(0).max(1).default(0.5),
  anchorY: z.number().min(0).max(1).default(0.5),
  zIndex: z.number().int().default(0),
  opacity: z.number().min(0).max(1).default(1),
  borderRadius: z.number().min(0).max(200).default(0),
  borderWidth: z.number().min(0).max(64).default(0),
  borderColor: z.string().default("#ffffff"),
  shadowEnabled: z.boolean().default(false),
  shadowColor: z.string().default("rgba(0, 0, 0, 0.5)"),
  shadowBlur: z.number().min(0).max(100).default(10),
  fit: imageFitSchema.default("contain"),
  animationIn: z.enum(["none", "fade", "scale-up", "slide-up"]).default("fade"),
  animationOut: z.enum(["none", "fade", "scale-down"]).default("fade"),
  overlayAnimation: overlayAnimationSchema.default(() => overlayAnimationSchema.parse({})),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
})

export type ImageClip = z.infer<typeof imageClipSchema>

// Video b-roll (modern-features #13): an external video asset composited over
// the screen (or covering it in `fullscreen` mode). Embedded audio is mixed
// from the same asset's audio stream.
export const videoLayoutModeSchema = z.enum(["overlay", "fullscreen"])
export type VideoLayoutMode = z.infer<typeof videoLayoutModeSchema>

export const videoAnimationSchema = z.enum(["none", "fade", "scale", "slide"])
export type VideoAnimation = z.infer<typeof videoAnimationSchema>

export const videoClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("video"),
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().min(10).default(1280),
  height: z.number().min(10).default(720),
  rotation: z.number().default(0),
  anchorX: z.number().min(0).max(1).default(0.5),
  anchorY: z.number().min(0).max(1).default(0.5),
  zIndex: z.number().int().default(0),
  opacity: z.number().min(0).max(1).default(1),
  borderRadius: z.number().min(0).max(200).default(0),
  borderWidth: z.number().min(0).max(64).default(0),
  borderColor: z.string().default("#ffffff"),
  borderStyle: borderStyleSchema.optional(),
  borderGradient: borderGradientSchema.optional(),
  shadowEnabled: z.boolean().default(false),
  shadowColor: z.string().default("rgba(0, 0, 0, 0.5)"),
  shadowBlur: z.number().min(0).max(100).default(10),
  fit: imageFitSchema.default("contain"),
  // Source-pixel crop applied before the fit (rotation metadata is honoured by
  // the decode pass, so this is always in display orientation).
  crop: boundsSchema.optional(),
  layoutMode: videoLayoutModeSchema.default("overlay"),
  animationIn: videoAnimationSchema.default("fade"),
  animationOut: videoAnimationSchema.default("fade"),
  // Animation ramp lengths; 0 disables the animated rect/opacity keyframes.
  animationMs: z.number().int().min(0).max(10_000).default(400),
  volume: z.number().min(0).max(2).default(1),
  audioMuted: z.boolean().default(false),
  fadeInMs: z.number().min(0).default(0),
  fadeOutMs: z.number().min(0).default(0),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
})

export type VideoClip = z.infer<typeof videoClipSchema>

// Discriminated union of all clip kinds.
export const timelineClipSchema = z.discriminatedUnion("kind", [
  screenClipSchema,
  cameraClipSchema,
  audioClipSchema,
  captionClipSchema,
  maskClipSchema,
  cursorEffectClipSchema,
  annotationClipSchema,
  textClipSchema,
  imageClipSchema,
  videoClipSchema,
])

export type TimelineClip = z.infer<typeof timelineClipSchema>

// Track kind determines how the track is rendered and exported.
export const timelineTrackKindSchema = z.enum([
  "screen",
  "camera",
  "audio",
  "captions",
  "cursor",
  "effects",
  "zoom",
  "annotations",
  "titles",
  "graphics",
  "overlay",
  // Custom media tracks (modern-features #14) accept video/image/audio clips and
  // composite in track order.
  "media",
  // Camera layout lane (#5). A virtual track that anchors the lane row; the
  // segments live in `TimelineState.cameraLayouts` exactly like zoom segments.
  "camera-layouts",
])

export type TimelineTrackKind = z.infer<typeof timelineTrackKindSchema>

// A track is a vertical lane of clips with shared controls.
export const timelineTrackSchema = z.object({
  id: z.string(),
  kind: timelineTrackKindSchema,
  name: z.string(),
  muted: z.boolean().default(false),
  locked: z.boolean().default(false),
  solo: z.boolean().default(false),
  volume: z.number().min(0).max(2).default(1),
  clips: z.array(timelineClipSchema),
  // Track-level caption look — only meaningful on kind "captions"; optional
  // so projects saved before the caption overhaul load unchanged.
  captionDesign: captionDesignSchema.optional(),
})

export type TimelineTrack = z.infer<typeof timelineTrackSchema>

// Marker / chapter point on the timeline.
export const timelineMarkerSchema = z.object({
  id: z.string(),
  timeMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  label: z.string(),
  color: z.string().default("#f59e0b"),
})

export type TimelineMarker = z.infer<typeof timelineMarkerSchema>

// Runtime timeline state. This is the editable project in memory.
export const timelineStateSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  recordingId: z.string(),
  canvas: timelineCanvasSchema,
  tracks: z.array(timelineTrackSchema),
  markers: z.array(timelineMarkerSchema),
  // Optional keeps projects created before Phase 6 valid while still making
  // manual and generated zoom ranges durable as soon as the user creates one.
  zoomSegments: z.array(manualZoomSegmentSchema).optional(),
  // Camera layout lane (#5). Optional so projects saved before the lane existed
  // keep loading with today's clip-transform layout.
  cameraLayouts: z.array(cameraLayoutSegmentSchema).optional(),
  smartZoomSettings: smartZoomSettingsSchema.optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
})

export type TimelineState = z.infer<typeof timelineStateSchema>

// UI-only view state (zoom, scroll, playhead). Not persisted in the project file.
export const timelineViewStateSchema = z.object({
  zoom: z.number().min(0).default(0),
  scrollMs: z.number().default(0),
  playheadMs: z.number().default(0),
  isPlaying: z.boolean().default(false),
  playbackRate: z.number().min(0.25).max(4).default(1),
  previewQuality: z.enum(["quality", "performance", "power"]).default("quality"),
  durationMs: z.number().default(0),
  selection: timelineSelectionSchema.nullable().default(null),
  snapEnabled: z.boolean().default(true),
  snapThresholdMs: z.number().int().min(1).max(5_000).default(120),
  collapsedTrackIds: z.array(z.string()).default([]),
  trackHeights: z.record(z.string(), z.number().int().min(28).max(240)).default({}),
})

export type TimelineViewState = z.infer<typeof timelineViewStateSchema>

export const exportPresetSchema = z.enum([
  "default-mp4",
  "fast-share",
  "balanced",
  "high-quality",
  "smooth-60fps",
  "ultra-4k",
  "ultra-4k-60",
  "vertical",
  "square",
  "selected-range",
  "gif-balanced",
  "gif-high-quality",
  "gif-fast",
  "webp-balanced",
  "webp-high-quality",
  "webp-fast",
  "webp-lossless",
])
export type ExportPreset = z.infer<typeof exportPresetSchema>

export const exportRangeSchema = z.object({
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
})
export type ExportRange = z.infer<typeof exportRangeSchema>

// Output raster tier. `canvas` keeps the project canvas; the other tiers scale
// the composed frame down to the requested short edge (never up), so a 1080p
// canvas offers 720p and 1080p but not 1440p. Animated GIF/WebP exports keep
// their preset scaling and ignore this field.
export const exportResolutionSchema = z.enum(["canvas", "720p", "1080p", "1440p", "2160p"])
export type ExportResolution = z.infer<typeof exportResolutionSchema>

// ProRes mastering profiles; `hq` is Apple's standard delivery profile.
export const proresProfileSchema = z.enum(["proxy", "lt", "standard", "hq"])
export type ProresProfile = z.infer<typeof proresProfileSchema>

// Output frame rate. `project` follows the canvas grid; the numeric tiers
// re-grid the whole composition (decode, zoom, cursor and plates all render at
// the requested rate) instead of letting the encoder duplicate frames.
export const exportFrameRateSchema = z.enum(["project", "24", "30", "60"])
export type ExportFrameRate = z.infer<typeof exportFrameRateSchema>

// Short edge of each resolution tier in pixels (`null` = the project canvas).
export const EXPORT_RESOLUTION_EDGE: Record<ExportResolution, number | null> = {
  canvas: null,
  "720p": 720,
  "1080p": 1080,
  "1440p": 1440,
  "2160p": 2160,
}

// Frame rate of each tier in fps (`null` = the project canvas rate).
export const EXPORT_FRAME_RATE_VALUE: Record<ExportFrameRate, number | null> = {
  project: null,
  "24": 24,
  "30": 30,
  "60": 60,
}

// What each preset prefills in the output format fields. Presets stay the
// starting point — the user can override either field afterwards, and the
// renderer reads only the fields themselves.
export function exportPresetFormat(preset: ExportPreset): {
  resolution: ExportResolution
  frameRate: ExportFrameRate
} {
  if (preset === "smooth-60fps") return { resolution: "canvas", frameRate: "60" }
  if (preset === "ultra-4k") return { resolution: "2160p", frameRate: "project" }
  if (preset === "ultra-4k-60") return { resolution: "2160p", frameRate: "60" }
  return { resolution: "canvas", frameRate: "project" }
}

/**
 * Delivered raster for a resolution tier. Mirrors `resolution_dimensions` in
 * Rust: fit the requested short edge, even dimensions, never upscale.
 */
export function resolveOutputDimensions(
  width: number,
  height: number,
  resolution: ExportResolution,
): { width: number; height: number } {
  const edge = EXPORT_RESOLUTION_EDGE[resolution]
  const current = Math.min(width, height)
  if (!edge || edge >= current) return { width, height }
  const scale = edge / current
  return {
    width: Math.max(2, Math.floor(Math.round(width * scale) / 2) * 2),
    height: Math.max(2, Math.floor(Math.round(height * scale) / 2) * 2),
  }
}

/** Delivered frame rate for a tier; `project` keeps the canvas rate. */
export function resolveOutputFrameRate(frameRate: ExportFrameRate, canvasFps: number): number {
  return EXPORT_FRAME_RATE_VALUE[frameRate] ?? canvasFps
}

// Export settings are sent with the job so Rust renders the settings shown by the UI.
// `encoder` selects hardware acceleration: auto prefers the best detected
// hardware encoder (NVENC/QSV/AMF/Media Foundation) and falls back to software.
export const exportEncoderSchema = z.enum(["auto", "software"])
export type ExportEncoderPreference = z.infer<typeof exportEncoderSchema>

// Compositor selection (ADR 018). `auto` uses the native GPU compositor when the
// plan and adapter support it and the FFmpeg graph otherwise (including after
// repeated GPU failures in one session); `gpu` asks for the GPU path explicitly
// and still degrades per-feature, and `compatibility` pins the FFmpeg renderer.
export const exportRendererSchema = z.enum(["auto", "gpu", "compatibility"])
export type ExportRendererPreference = z.infer<typeof exportRendererSchema>

// Chapter export mode for embedding MP4 chapters or writing a YouTube timestamp sidecar.
export const renderChapterModeSchema = z.enum(["embed", "sidecar", "both", "none"])
export type RenderChapterMode = z.infer<typeof renderChapterModeSchema>
export const exportChapterModeSchema = renderChapterModeSchema
export type ExportChapterMode = RenderChapterMode

export const renderPlanChapterSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
})
export type RenderPlanChapter = z.infer<typeof renderPlanChapterSchema>

// Delivery codec/container pairs. ProRes is MOV-only; GIF/WebP are the
// animated containers their presets pick.
export const exportCodecSchema = z.enum(["h264", "hevc", "gif", "webp", "prores"])
export type ExportCodec = z.infer<typeof exportCodecSchema>

export const exportContainerSchema = z.enum(["mp4", "gif", "webp", "mov"])
export type ExportContainer = z.infer<typeof exportContainerSchema>

export const exportSettingsSchema = z.object({
  preset: exportPresetSchema.default("default-mp4"),
  codec: exportCodecSchema.default("h264"),
  encoder: exportEncoderSchema.default("auto"),
  renderer: exportRendererSchema.default("auto"),
  container: exportContainerSchema.default("mp4"),
  // ProRes mastering profile (only meaningful with codec `prores`).
  proresProfile: proresProfileSchema.default("hq"),
  // Output format. Both default to the project canvas; presets prefill them
  // (`exportPresetFormat`) but never override the stored values.
  resolution: exportResolutionSchema.default("canvas"),
  frameRate: exportFrameRateSchema.default("project"),
  captionMode: renderCaptionModeSchema.default("burn-in"),
  chapterMode: renderChapterModeSchema.default("embed"),
  range: exportRangeSchema.nullish(),
  // Keystroke overlay (Pro) — keycap badges for modifier combos captured
  // during recording. Style fields feed the editor preview and the export
  // rasterizer alike (WYSIWYG).
  keystrokeOverlay: keystrokeOverlaySettingsSchema.default({
    enabled: false,
    position: "bottom-center",
    theme: "dark",
    scale: 1,
    maxStack: 3,
    holdMs: 2200,
    modifierStyle: "symbols",
  }),
})
export type ExportSettings = z.infer<typeof exportSettingsSchema>

export const renderPlanGapSchema = z.object({
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
})
export type RenderPlanGap = z.infer<typeof renderPlanGapSchema>

// A single continuous segment in the final render plan.
export const renderSegmentSchema = z.object({
  assetId: z.string(),
  streamIndex: z.number().int().min(0).optional(),
  volume: z.number().min(0).max(2).optional(),
  fadeInMs: z.number().min(0).optional(),
  fadeOutMs: z.number().min(0).optional(),
  volumeKeyframes: z.array(audioVolumeKeyframeSchema).optional(),
  audioFilter: z.string().optional(),
  speed: z.number().positive().default(1),
  sourceInMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  sourceOutMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  outputStartMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  outputEndMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  // Native source dimensions, when known, so the export can fit the recorded
  // video precisely instead of guessing from the padded content area.
  sourceWidth: z.number().int().positive().optional(),
  sourceHeight: z.number().int().positive().optional(),
})

export type RenderSegment = z.infer<typeof renderSegmentSchema>

// Audio mix settings for the final render.
export const renderPlanAudioSchema = z.object({
  assetId: z.string(),
  streamIndex: z.number().int().min(0).optional(),
  role: audioRoleSchema.optional(),
  muted: z.boolean().default(false),
  volume: z.number().min(0).max(2).default(1),
  segments: z.array(renderSegmentSchema).default([]),
})

export type RenderPlanAudio = z.infer<typeof renderPlanAudioSchema>

// One sampled layout pose in absolute output time. Renderers interpolate
// linearly between adjacent keyframes, so a transition is a short run of
// keyframes and a hold is two equal poses.
export const renderPlanLayoutKeyframeSchema = z.object({
  timeMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  x: z.number(),
  y: z.number(),
  width: z.number().min(0),
  height: z.number().min(0),
  radius: z.number().min(0).default(0),
  opacity: z.number().min(0).max(1).default(1),
})

export type RenderPlanLayoutKeyframe = z.infer<typeof renderPlanLayoutKeyframeSchema>

// One sampled source crop for face-tracked framing (#4c), in absolute output
// ms. Width/height stay fixed within a clip; the renderer interpolates x/y.
export const renderPlanCropKeyframeSchema = z.object({
  timeMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(2),
  height: z.number().int().min(2),
})

export type RenderPlanCropKeyframe = z.infer<typeof renderPlanCropKeyframeSchema>

// Camera colour resolution carried into the plan. `lutAssetId` names a project
// `.cube` asset; `lutId` keeps the bundled look id so Rust can generate it.
export const renderPlanCameraColorSchema = z.object({
  exposure: z.number().min(-2).max(2).default(0),
  contrast: z.number().min(-1).max(1).default(0),
  saturation: z.number().min(-1).max(1).default(0),
  temperature: z.number().min(-1).max(1).default(0),
  tint: z.number().min(-1).max(1).default(0),
  lutId: z.string().optional(),
  lutAssetId: z.string().optional(),
  lutIntensity: z.number().min(0).max(1).default(1),
})

export type RenderPlanCameraColor = z.infer<typeof renderPlanCameraColorSchema>

export const renderPlanCameraCutoutSchema = z.object({
  background: cameraCutoutBackgroundSchema.default("none"),
  blurRadius: z.number().min(0).max(100).default(18),
  color: z.string().default("#0f172a"),
  imageAssetId: z.string().optional(),
  edgeSoftness: z.number().min(0).max(16).default(2),
  edgeShrink: z.number().min(-8).max(8).default(0),
  /** Absolute path of the derived grayscale matte, validated by Rust. */
  mattePath: z.string().optional(),
})

export type RenderPlanCameraCutout = z.infer<typeof renderPlanCameraCutoutSchema>

// Picture-in-picture overlay settings for the final render. This is the unified
// video-layer record (F3): the camera bubble, b-roll video clips and media-track
// video all cross the plan boundary through it.
export const renderPlanOverlaySchema = z.object({
  id: z.string().optional(),
  assetId: z.string(),
  streamIndex: z.number().int().min(0).optional(),
  sourceInMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  sourceOutMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  outputStartMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  outputEndMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  speed: z.number().positive().default(1),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  crop: boundsSchema.optional(),
  opacity: z.number().min(0).max(1).default(1),
  visible: z.boolean().default(true),
  shape: z.enum(["rectangle", "rounded", "circle"]).default("rectangle"),
  // Corner radius in canvas px for `shape: "rounded"`. Always emitted for
  // `role: "camera"` (ADR 023: the resolver is authoritative).
  radius: z.number().min(0).optional(),
  // Camera placement mode from the frame resolver; `split` carries `screen`.
  mode: z.enum(["overlay", "split", "full"]).optional(),
  // Static screen slot in canvas px for `mode: "split"` camera layers.
  screen: boundsSchema.optional(),
  // How the source fills the layer rect. Camera bubbles use `cover` (today's
  // behaviour); b-roll defaults to `contain`.
  fit: z.enum(["contain", "cover", "fill"]).optional(),
  // Animated pose (fade/scale/slide in and out). When present the renderer uses
  // these instead of the static x/y/width/height/opacity above.
  keyframes: z.array(renderPlanLayoutKeyframeSchema).optional(),
  // `camera` layers follow the camera layout lane; `video` layers are b-roll.
  role: z.enum(["camera", "video", "image"]).optional(),
  borderWidth: z.number().min(0).optional(),
  borderColor: z.string().optional(),
  borderOpacity: z.number().min(0).max(1).optional(),
  borderStyle: borderStyleSchema.optional(),
  borderGradient: borderGradientSchema.optional(),
  shadowEnabled: z.boolean().optional(),
  shadowColor: z.string().optional(),
  shadowBlur: z.number().min(0).optional(),
  shadowOffsetX: z.number().optional(),
  shadowOffsetY: z.number().optional(),
  preset: cameraPlacementPresetSchema.optional(),
  // M4 camera effects (camera layers only).
  color: renderPlanCameraColorSchema.optional(),
  cutout: renderPlanCameraCutoutSchema.optional(),
  // Face-tracked framing: fixed-size source crop with a moving centre.
  cropKeyframes: z.array(renderPlanCropKeyframeSchema).optional(),
})

export type RenderPlanOverlay = z.infer<typeof renderPlanOverlaySchema>

// One camera-layout window (#5): the camera pose and (for side-by-side) the
// screen pose across the segment. Poses are interpolated per frame.
export const renderPlanCameraLayoutSchema = z.object({
  id: z.string(),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
  camera: z.array(renderPlanLayoutKeyframeSchema).min(1),
  screen: z.array(renderPlanLayoutKeyframeSchema).min(1).optional(),
  // `silence` marks a hide-during-silence segment (#4d, Pro) so Rust can gate
  // it without re-reading the timeline.
  source: cameraLayoutSourceSchema.optional(),
})

export type RenderPlanCameraLayout = z.infer<typeof renderPlanCameraLayoutSchema>

// Unified visual layer stack (F4). Screen is pinned to the bottom and captions
// and cursor stay on top; this records the order the renderers draw the middle
// band in (video layers and the camera bubble alternate by track order).
export const renderPlanLayerEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("camera"), id: z.string() }),
  z.object({ kind: z.literal("video"), id: z.string() }),
])

export type RenderPlanLayerEntry = z.infer<typeof renderPlanLayerEntrySchema>

const captionLayoutHexSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)

// Px-resolved caption layout emitted by the editor-core layout engine —
// fully self-contained so the Rust ASS writer never needs the look catalogue.
// All pixel values are in output-canvas space; all times in output ms.
export const renderPlanCaptionLayoutSchema = z.object({
  lookId: captionStylePresetSchema,
  fontPx: z.number().min(8).max(600),
  lineHeightPx: z.number().min(8).max(900),
  fontWeight: z.union([z.literal(600), z.literal(700), z.literal(800)]),
  letterSpacingPx: z.number().min(-20).max(40),
  textColor: captionLayoutHexSchema,
  chip: z
    .object({
      color: captionLayoutHexSchema,
      opacity: z.number().min(0).max(1),
      radiusPx: z.number().min(0),
      padXPx: z.number().min(0),
      padYPx: z.number().min(0),
    })
    .nullable(),
  outline: z
    .object({
      color: captionLayoutHexSchema,
      opacity: z.number().min(0).max(1),
      widthPx: z.number().min(0),
    })
    .nullable(),
  shadow: z
    .object({
      color: captionLayoutHexSchema,
      opacity: z.number().min(0).max(1),
      blurPx: z.number().min(0),
      offsetYPx: z.number(),
    })
    .nullable(),
  highlight: z
    .object({
      mode: z.enum(["word", "focus"]),
      activeColor: captionLayoutHexSchema,
      inactiveOpacity: z.number().min(0).max(1),
    })
    .nullable(),
  animation: z.object({
    inMs: z.number().int().min(0),
    outMs: z.number().int().min(0),
    fromScale: z.number().min(0.5).max(1),
  }),
  pages: z
    .array(
      z.object({
        startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
        endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
        animateIn: z.boolean(),
        animateOut: z.boolean(),
        lines: z.array(
          z.object({
            text: z.string().min(1),
            // Word-level timing windows — populated only for highlight looks.
            words: z.array(
              z.object({
                text: z.string().min(1),
                startMs: z.number().int().min(0),
                endMs: z.number().int().min(0),
              }),
            ),
          }),
        ),
        // Text block center + height in canvas px; chip padding excluded.
        block: z.object({
          centerX: z.number(),
          centerY: z.number(),
          height: z.number(),
        }),
      }),
    )
    .min(1),
})

export type CaptionLayout = z.infer<typeof renderPlanCaptionLayoutSchema>

export const renderPlanCaptionSchema = z.object({
  id: z.string(),
  // Original cue timing/text — the SRT sidecar is unaffected by the layout.
  text: z.string().min(1),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
  style: captionStylePresetSchema.default("default"),
  placement: captionPlacementSchema.default("bottom"),
  safeAreaMargin: z.number().int().min(0).max(2_000).default(48),
  layout: renderPlanCaptionLayoutSchema.optional(),
})

export type RenderPlanCaption = z.infer<typeof renderPlanCaptionSchema>

export const renderPlanMaskSchema = z.object({
  id: z.string(),
  assetId: z.string().optional(),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
  mode: maskModeSchema,
  rect: maskRectSchema,
  blurRadius: z.number().min(1).max(128).default(24),
  pixelSize: z.number().int().min(2).max(128).default(12),
  redactColor: maskColorSchema.default("black"),
  enabled: z.boolean().default(true),
})

export type RenderPlanMask = z.infer<typeof renderPlanMaskSchema>

export const renderPlanZoomKeyframeSchema = z.object({
  timeMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  target: zoomTargetSchema,
})

export type RenderPlanZoomKeyframe = z.infer<typeof renderPlanZoomKeyframeSchema>

// Compact follow-camera paths store cubic Bézier control points for the crop
// center. Crop dimensions remain on the parent zoom segment, avoiding repeated
// rectangles for every motion sample.
export const renderPlanZoomMotionPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

export type RenderPlanZoomMotionPoint = z.infer<typeof renderPlanZoomMotionPointSchema>

export const renderPlanZoomMotionSegmentSchema = z.object({
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
  start: renderPlanZoomMotionPointSchema,
  control1: renderPlanZoomMotionPointSchema,
  control2: renderPlanZoomMotionPointSchema,
  end: renderPlanZoomMotionPointSchema,
})

export type RenderPlanZoomMotionSegment = z.infer<typeof renderPlanZoomMotionSegmentSchema>

export const renderPlanZoomMotionPlanSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("cubic-bezier"),
    segments: z.array(renderPlanZoomMotionSegmentSchema).min(1),
  })
  .superRefine((plan, context) => {
    plan.segments.forEach((segment, index) => {
      const previous = plan.segments[index - 1]
      if (previous && previous.endMs !== segment.startMs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["segments", index, "startMs"],
          message: "Motion-plan segments must be contiguous",
        })
      }
      if (segment.endMs <= segment.startMs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["segments", index],
          message: "Motion-plan segment must have a positive duration",
        })
      }
    })
  })

export type RenderPlanZoomMotionPlan = z.infer<typeof renderPlanZoomMotionPlanSchema>

export const renderPlanZoomSegmentSchema = z
  .object({
    id: z.string(),
    startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
    endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
    target: zoomTargetSchema,
    scale: z.number().min(1).max(8).default(1.5),
    easing: zoomEasingSchema.default("smooth"),
    transitionInMs: z
      .number()
      .transform(Math.round)
      .pipe(z.number().int().min(0).max(10_000))
      .default(400),
    transitionOutMs: z
      .number()
      .transform(Math.round)
      .pipe(z.number().int().min(0).max(10_000))
      .default(400),
    enabled: z.boolean().default(true),
    mode: zoomModeSchema.optional(),
    source: zoomSourceSchema.optional(),
    preset: zoomPresetSchema.optional(),
    followDeadzonePercent: z.number().min(0.01).max(0.5).optional(),
    followSmoothingAlpha: z.number().min(0.05).max(1.0).optional(),
    label: z.string().optional(),
    fromTarget: zoomTargetSchema.optional(),
    fromScale: z.number().min(1).max(8).optional(),
    // Glass Loupe (#2): `loupe` segments are resolved by `resolveLoupes` in the
    // preview and by the loupe pass in both renderers, never as frame zooms.
    style: zoomStyleSchema.optional(),
    loupe: loupeSettingsSchema.optional(),
    // New follow-cursor exports prefer this compact path. `keyframes` remains
    // accepted for render-plan compatibility with older projects and callers.
    keyframes: z.array(renderPlanZoomKeyframeSchema).optional(),
    motionPlan: renderPlanZoomMotionPlanSchema.optional(),
  })
  .superRefine((segment, context) => {
    const motionSegments = segment.motionPlan?.segments
    if (!motionSegments) return

    if (motionSegments[0]?.startMs !== segment.startMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["motionPlan", "segments", 0, "startMs"],
        message: "Motion plan must start at the zoom segment start",
      })
    }
    if (motionSegments[motionSegments.length - 1]?.endMs !== segment.endMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["motionPlan", "segments", motionSegments.length - 1, "endMs"],
        message: "Motion plan must end at the zoom segment end",
      })
    }
  })

export type RenderPlanZoomSegment = z.infer<typeof renderPlanZoomSegmentSchema>

// Cursor effects are sent as IDs and validated settings. Rust resolves the
// telemetry path from the registered project asset instead of accepting a path.
export const renderPlanCursorEffectSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
  enabled: z.boolean().default(true),
  presetId: cursorIconPresetSchema.default("recorded-system"),
  scale: z.number().min(0.2).max(5).default(1),
  smoothing: cursorSmoothingSchema.default("smooth"),
  settings: cursorEffectSettingsSchema.default({}),
})

export type RenderPlanCursorEffect = z.infer<typeof renderPlanCursorEffectSchema>

export const renderPlanAnnotationSchema = z.object({
  id: z.string(),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
  annotationType: annotationTypeSchema,
  x: z.number(),
  y: z.number(),
  width: z.number().min(0),
  height: z.number().min(0),
  endX: z.number().optional(),
  endY: z.number().optional(),
  strokeColor: z.string(),
  strokeWidth: z.number().min(0),
  strokeStyle: annotationStrokeStyleSchema,
  fillColor: z.string(),
  fillOpacity: z.number().min(0).max(1),
  cornerRadius: z.number().min(0),
  arrowEndHead: annotationHeadSchema,
  arrowStartHead: annotationHeadSchema,
  arrowStyle: annotationArrowStyleSchema.default("straight"),
  shadowEnabled: z.boolean(),
  shadowColor: z.string(),
  shadowBlur: z.number().min(0),
  text: z.string().optional(),
  textColor: z.string(),
  fontSize: z.number().min(8),
  animationIn: annotationAnimationSchema,
  animationOut: annotationAnimationSchema,
  enabled: z.boolean().default(true),
})

export type RenderPlanAnnotation = z.infer<typeof renderPlanAnnotationSchema>

export const renderPlanTextSchema = z.object({
  id: z.string(),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
  presetId: z.string(),
  titleDesign: titleDesignSchema.optional(),
  category: titlePresetCategorySchema,
  primaryText: z.string().min(1),
  secondaryText: z.string().optional(),
  tagText: z.string().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().min(20),
  height: z.number().min(20),
  alignment: textAlignmentSchema,
  fontFamily: textFontFamilySchema,
  fontSize: z.number().min(8),
  fontWeight: textFontWeightSchema,
  textColor: z.string(),
  secondaryTextColor: z.string(),
  accentColor: z.string(),
  backdropStyle: textBackdropStyleSchema,
  backdropColor: z.string(),
  backdropOpacity: z.number().min(0).max(1),
  backdropBlur: z.number().min(0),
  backdropBorderRadius: z.number().min(0),
  backdropPaddingX: z.number().min(0),
  backdropPaddingY: z.number().min(0),
  shadowEnabled: z.boolean(),
  shadowColor: z.string(),
  shadowBlur: z.number().min(0),
  animationIn: textAnimationSchema,
  animationOut: textAnimationSchema,
  autoScaleText: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

export type RenderPlanText = z.infer<typeof renderPlanTextSchema>

export const renderPlanImageSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
  x: z.number(),
  y: z.number(),
  width: z.number().min(10),
  height: z.number().min(10),
  opacity: z.number().min(0).max(1),
  borderRadius: z.number().min(0),
  borderWidth: z.number().min(0),
  borderColor: z.string(),
  shadowEnabled: z.boolean(),
  shadowColor: z.string(),
  shadowBlur: z.number().min(0),
  fit: imageFitSchema,
  animationIn: z.enum(["none", "fade", "scale-up", "slide-up"]),
  animationOut: z.enum(["none", "fade", "scale-down"]),
  enabled: z.boolean().default(true),
})

export type RenderPlanImage = z.infer<typeof renderPlanImageSchema>

// Render plan produced by media-core from a saved project timeline.
export const renderPlanSchema = z
  .object({
    projectId: z.string().min(1),
    canvas: timelineCanvasSchema,
    durationMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
    segments: z.array(renderSegmentSchema).min(1),
    gaps: z.array(renderPlanGapSchema).default([]),
    // `audio` remains for backwards-compatible consumers; new exports use all tracks.
    audio: renderPlanAudioSchema.optional(),
    audioTracks: z.array(renderPlanAudioSchema).default([]),
    overlays: z.array(renderPlanOverlaySchema).default([]),
    captions: z.array(renderPlanCaptionSchema).default([]),
    captionMode: renderCaptionModeSchema.default("burn-in"),
    chapters: z.array(renderPlanChapterSchema).default([]),
    chapterMode: renderChapterModeSchema.default("embed"),
    masks: z.array(renderPlanMaskSchema).default([]),
    zoomSegments: z.array(renderPlanZoomSegmentSchema).default([]),
    // Camera layout lane (#5): per-frame camera/screen poses.
    cameraLayouts: z.array(renderPlanCameraLayoutSchema).default([]),
    // Draw order for the middle band (F3/F4): video layers and the camera
    // bubble in track order. Absent means "camera first, then overlays".
    layerOrder: z.array(renderPlanLayerEntrySchema).default([]),
    cursorEffects: z.array(renderPlanCursorEffectSchema).default([]),
    overlayRenderPlan: z.custom<OverlayRenderPlan>().optional(),
    annotations: z.array(renderPlanAnnotationSchema).default([]),
    texts: z.array(renderPlanTextSchema).default([]),
    images: z.array(renderPlanImageSchema).default([]),
  })
  .superRefine((plan, context) => {
    let cursorMs = 0
    const expectedGaps: Array<{ startMs: number; endMs: number }> = []
    for (const [index, segment] of plan.segments.entries()) {
      if (segment.sourceOutMs <= segment.sourceInMs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["segments", index, "sourceOutMs"],
          message: "Render segment source range must be positive",
        })
      }
      if (segment.outputEndMs <= segment.outputStartMs || segment.outputEndMs > plan.durationMs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["segments", index, "outputEndMs"],
          message: "Render segment output range is invalid",
        })
      }
      if (segment.outputStartMs < cursorMs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["segments", index, "outputStartMs"],
          message: "Render segments cannot overlap",
        })
      }
      if (segment.outputStartMs > cursorMs) {
        expectedGaps.push({ startMs: cursorMs, endMs: segment.outputStartMs })
      }
      cursorMs = Math.max(cursorMs, segment.outputEndMs)
    }
    if (cursorMs < plan.durationMs) expectedGaps.push({ startMs: cursorMs, endMs: plan.durationMs })
    if (JSON.stringify(expectedGaps) !== JSON.stringify(plan.gaps)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gaps"],
        message: "Render gaps must match segment output timing",
      })
    }
    for (const [index, gap] of plan.gaps.entries()) {
      if (gap.endMs <= gap.startMs || gap.endMs > plan.durationMs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["gaps", index],
          message: "Render gap range is invalid",
        })
      }
    }
    for (const [key, effects] of [
      ["captions", plan.captions],
      ["chapters", plan.chapters],
      ["masks", plan.masks],
      ["zoomSegments", plan.zoomSegments],
      ["cameraLayouts", plan.cameraLayouts],
    ] as const) {
      effects.forEach((effect, index) => {
        if (effect.endMs > plan.durationMs || effect.endMs <= effect.startMs) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, index, "endMs"],
            message: "Render effect range is invalid",
          })
        }
      })
    }
    plan.overlays.forEach((overlay, index) => {
      if (
        overlay.sourceOutMs <= overlay.sourceInMs ||
        overlay.outputEndMs <= overlay.outputStartMs ||
        overlay.outputEndMs > plan.durationMs
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["overlays", index],
          message: "Camera overlay range is invalid",
        })
      }
    })
  })

export type RenderPlan = z.infer<typeof renderPlanSchema>

// Post-export Instant Share delivery. `target` is "hosted" or an S3 storage
// profile id; `password` is transient — Rust moves it into the OS credential
// vault before the request is persisted, so it never lands in SQLite.
export const shareDeliverySpecSchema = z.object({
  target: z.string().min(1),
  title: z.string().min(1).max(200),
  allowDownload: z.boolean().default(true),
  allowEmbed: z.boolean().default(true),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  password: z.string().max(128).optional(),
})
export type ShareDeliverySpec = z.infer<typeof shareDeliverySpecSchema>

// Post-export YouTube auto-publish (Pro). Title/description ship with the
// job; the worker resolves the captions sidecar from the finished output.
export const youtubeDeliverySpecSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(5000).default(""),
  privacy: youtubePrivacySchema.default("unlisted"),
  tags: z.array(z.string()).max(50).default([]),
  attachCaptions: z.boolean().default(true),
  captionsLanguage: z.string().min(2).max(20).default("en"),
})
export type YouTubeDeliverySpec = z.infer<typeof youtubeDeliverySpecSchema>

// Deliveries travel with the durable export request so a share/publish
// survives app restarts and re-runs on job retry.
export const exportDeliveriesSchema = z.object({
  share: shareDeliverySpecSchema.optional(),
  youtube: youtubeDeliverySpecSchema.optional(),
})
export type ExportDeliveries = z.infer<typeof exportDeliveriesSchema>

// Options submitted to the Rust export command. `outputPath` is a validated
// destination selected by the user, never a source-media path.
export const exportTimelineOptionsSchema = z
  .object({
    projectId: z.string().min(1),
    outputPath: z.string().min(1),
    plan: renderPlanSchema,
    settings: exportSettingsSchema,
    deliveries: exportDeliveriesSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.plan.projectId !== value.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["plan", "projectId"],
        message: "Render plan project must match export project",
      })
    }

    if (value.settings.preset === "selected-range" && !value.settings.range) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["settings", "range"],
        message: "Selected-range export requires a range",
      })
    }
  })

export type ExportTimelineOptions = z.infer<typeof exportTimelineOptionsSchema>

// Update shape for track controls.
export const trackUpdateSchema = z.object({
  muted: z.boolean().optional(),
  locked: z.boolean().optional(),
  solo: z.boolean().optional(),
  volume: z.number().min(0).max(2).optional(),
  name: z.string().optional(),
})

export type TrackUpdate = z.infer<typeof trackUpdateSchema>
