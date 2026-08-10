import { z } from "zod"
import { boundsSchema } from "./recording"
import {
  cursorEffectSettingsSchema,
  cursorIconPresetSchema,
  cursorSettingsSchema,
  cursorSmoothingSchema,
  defaultCursorSettings,
} from "./cursor"
import { timelineSelectionSchema } from "./selection"
import {
  captionPlacementSchema,
  captionStylePresetSchema,
  renderCaptionModeSchema,
} from "./captions"

// Output framing presets are intentionally explicit so preview and export can
// reject unsupported aspect ratios instead of silently cropping the recording.
export const canvasAspectRatioSchema = z.enum(["16:9", "1:1", "9:16", "custom"])
export type CanvasAspectRatio = z.infer<typeof canvasAspectRatioSchema>

export const zoomEasingSchema = z.enum(["linear", "ease-in", "ease-out", "ease-in-out"])
export type ZoomEasing = z.infer<typeof zoomEasingSchema>

export const zoomTargetSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
})
export type ZoomTarget = z.infer<typeof zoomTargetSchema>

// Canvas settings shared by the timeline, the preview, and the final render.
export const timelineCanvasSchema = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  fps: z.number().int().min(1),
  background: z.string().default("#000000"),
  padding: z.number().min(0).default(0),
  borderRadius: z.number().min(0).default(0),
  shadow: z.boolean().default(false),
  // These fields are optional for backwards-compatible v1 project files. New
  // canvas edits persist them, and render helpers apply safe defaults when absent.
  aspectRatio: canvasAspectRatioSchema.optional(),
  shadowColor: z.string().optional(),
  shadowBlur: z.number().min(0).optional(),
  shadowOffsetX: z.number().optional(),
  shadowOffsetY: z.number().optional(),
  cursorSettings: cursorSettingsSchema.default(defaultCursorSettings),
})

export type TimelineCanvas = z.infer<typeof timelineCanvasSchema>

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
  shadowEnabled: z.boolean().optional(),
  shadowColor: z.string().optional(),
  shadowBlur: z.number().min(0).optional(),
  shadowOffsetX: z.number().optional(),
  shadowOffsetY: z.number().optional(),
})

export type ClipTransform = z.infer<typeof clipTransformSchema>

// Manual zoom ranges are timeline effects rather than media clips. The target
// is clamped to the canvas before it reaches either the preview or the exporter.
export const manualZoomSegmentSchema = z.object({
  id: z.string(),
  startMs: z.number().int().min(0),
  durationMs: z.number().int().min(1),
  target: zoomTargetSchema,
  scale: z.number().min(1).max(8).default(1),
  easing: zoomEasingSchema.default("ease-in-out"),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
})

export type ManualZoomSegment = z.infer<typeof manualZoomSegmentSchema>

// Core clip fields. Clips are non-destructive references into source media.
export const timelineClipBaseSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  // Stream index keeps multiplexed video and audio sources independently editable.
  streamIndex: z.number().int().min(0).optional(),
  startMs: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  sourceInMs: z.number().int().min(0),
  sourceOutMs: z.number().int().min(0),
  speed: z.number().positive().default(1),
})

export type TimelineClipBase = z.infer<typeof timelineClipBaseSchema>

// Screen clip: a slice of the captured display/window/region source.
export const screenClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("screen"),
})

export type ScreenClip = z.infer<typeof screenClipSchema>

// Camera clip: a picture-in-picture webcam slice with position, size, and shape.
export const cameraClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("camera"),
  transform: clipTransformSchema.default({}),
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

// Audio clip: an audio source slice with volume and fade controls.
export const audioClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("audio"),
  role: audioRoleSchema.optional(),
  volume: z.number().min(0).max(2).default(1),
  fadeInMs: z.number().min(0).default(0),
  fadeOutMs: z.number().min(0).default(0),
})

export type AudioClip = z.infer<typeof audioClipSchema>

// Caption clip: a timed text cue on the captions track.
export const captionClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("caption"),
  text: z.string().min(1),
  style: captionStylePresetSchema.default("default"),
  placement: captionPlacementSchema.optional(),
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
  startMs: z.number().int().min(0),
  durationMs: z.number().int().min(1),
  sourceInMs: z.number().int().min(0).default(0),
  sourceOutMs: z.number().int().min(0).default(0),
  speed: z.number().positive().default(1),
  presetId: cursorIconPresetSchema.default("modern-neon"),
  scale: z.number().min(0.2).max(5).default(1),
  smoothing: cursorSmoothingSchema.default("smooth"),
  settings: cursorEffectSettingsSchema.default({}),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
})

export type CursorEffectClip = z.infer<typeof cursorEffectClipSchema>

// Discriminated union of all clip kinds.
export const timelineClipSchema = z.discriminatedUnion("kind", [
  screenClipSchema,
  cameraClipSchema,
  audioClipSchema,
  captionClipSchema,
  maskClipSchema,
  cursorEffectClipSchema,
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
})

export type TimelineTrack = z.infer<typeof timelineTrackSchema>

// Marker / chapter point on the timeline.
export const timelineMarkerSchema = z.object({
  id: z.string(),
  timeMs: z.number().int().min(0),
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
  // manual zoom ranges durable as soon as the user creates one.
  zoomSegments: z.array(manualZoomSegmentSchema).optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
})

export type TimelineState = z.infer<typeof timelineStateSchema>

// UI-only view state (zoom, scroll, playhead). Not persisted in the project file.
export const timelineViewStateSchema = z.object({
  zoom: z.number().min(0.0001),
  scrollMs: z.number().default(0),
  playheadMs: z.number().default(0),
  isPlaying: z.boolean().default(false),
  playbackRate: z.number().min(0.25).max(4).default(1),
  durationMs: z.number().default(0),
  selection: timelineSelectionSchema.nullable().default(null),
  snapEnabled: z.boolean().default(true),
  snapThresholdMs: z.number().int().min(1).max(5_000).default(120),
  collapsedTrackIds: z.array(z.string()).default([]),
  trackHeights: z.record(z.number().int().min(28).max(240)).default({}),
})

export type TimelineViewState = z.infer<typeof timelineViewStateSchema>

// A single continuous segment in the final render plan.
export const renderSegmentSchema = z.object({
  assetId: z.string(),
  streamIndex: z.number().int().min(0).optional(),
  volume: z.number().min(0).max(2).optional(),
  fadeInMs: z.number().min(0).optional(),
  fadeOutMs: z.number().min(0).optional(),
  speed: z.number().min(0).default(1),
  sourceInMs: z.number().int().min(0),
  sourceOutMs: z.number().int().min(0),
  outputStartMs: z.number().int().min(0),
  outputEndMs: z.number().int().min(0),
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

// Picture-in-picture overlay settings for the final render.
export const renderPlanOverlaySchema = z.object({
  assetId: z.string(),
  streamIndex: z.number().int().min(0).optional(),
  sourceInMs: z.number().int().min(0),
  sourceOutMs: z.number().int().min(0),
  outputStartMs: z.number().int().min(0),
  outputEndMs: z.number().int().min(0),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  crop: boundsSchema.optional(),
  opacity: z.number().min(0).max(1).default(1),
  visible: z.boolean().default(true),
  shape: z.enum(["rectangle", "rounded", "circle"]).default("rectangle"),
  borderWidth: z.number().min(0).optional(),
  borderColor: z.string().optional(),
  borderOpacity: z.number().min(0).max(1).optional(),
  shadowEnabled: z.boolean().optional(),
  shadowColor: z.string().optional(),
  shadowBlur: z.number().min(0).optional(),
  shadowOffsetX: z.number().optional(),
  shadowOffsetY: z.number().optional(),
})

export type RenderPlanOverlay = z.infer<typeof renderPlanOverlaySchema>

export const renderPlanCaptionSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  style: captionStylePresetSchema.default("default"),
  placement: captionPlacementSchema.default("bottom"),
  safeAreaMargin: z.number().int().min(0).max(2_000).default(48),
})

export type RenderPlanCaption = z.infer<typeof renderPlanCaptionSchema>

export const renderPlanMaskSchema = z.object({
  id: z.string(),
  assetId: z.string().optional(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  mode: maskModeSchema,
  rect: maskRectSchema,
  blurRadius: z.number().min(1).max(128).default(24),
  pixelSize: z.number().int().min(2).max(128).default(12),
  redactColor: maskColorSchema.default("black"),
  enabled: z.boolean().default(true),
})

export type RenderPlanMask = z.infer<typeof renderPlanMaskSchema>

export const renderPlanZoomSegmentSchema = z.object({
  id: z.string(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  target: zoomTargetSchema,
  scale: z.number().min(1).max(8).default(1),
  easing: zoomEasingSchema.default("ease-in-out"),
  enabled: z.boolean().default(true),
})

export type RenderPlanZoomSegment = z.infer<typeof renderPlanZoomSegmentSchema>

// Cursor effects are sent as IDs and validated settings. Rust resolves the
// telemetry path from the registered project asset instead of accepting a path.
export const renderPlanCursorEffectSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  enabled: z.boolean().default(true),
  presetId: cursorIconPresetSchema.default("modern-neon"),
  scale: z.number().min(0.2).max(5).default(1),
  smoothing: cursorSmoothingSchema.default("smooth"),
  settings: cursorEffectSettingsSchema.default({}),
})

export type RenderPlanCursorEffect = z.infer<typeof renderPlanCursorEffectSchema>

// Render plan produced by media-core from a timeline.
export const renderPlanSchema = z.object({
  recordingId: z.string(),
  canvas: timelineCanvasSchema,
  durationMs: z.number().int().min(0),
  segments: z.array(renderSegmentSchema),
  // `audio` remains for backwards-compatible consumers; new exports use all tracks.
  audio: renderPlanAudioSchema.optional(),
  audioTracks: z.array(renderPlanAudioSchema).default([]),
  overlays: z.array(renderPlanOverlaySchema).default([]),
  captions: z.array(renderPlanCaptionSchema).default([]),
  captionMode: renderCaptionModeSchema.default("burn-in"),
  masks: z.array(renderPlanMaskSchema).default([]),
  zoomSegments: z.array(renderPlanZoomSegmentSchema).default([]),
  cursorEffects: z.array(renderPlanCursorEffectSchema).default([]),
})

export type RenderPlan = z.infer<typeof renderPlanSchema>

// Options submitted to the Rust export command.
export const exportTimelineOptionsSchema = z.object({
  recordingId: z.string(),
  outputPath: z.string(),
  plan: renderPlanSchema,
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
