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

// Canvas settings shared by the timeline, the preview, and the final render.
export const timelineCanvasSchema = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  fps: z.number().int().min(1),
  background: z.string().default("#000000"),
  padding: z.number().min(0).default(0),
  borderRadius: z.number().min(0).default(0),
  shadow: z.boolean().default(false),
  cursorSettings: cursorSettingsSchema.default(defaultCursorSettings),
})

export type TimelineCanvas = z.infer<typeof timelineCanvasSchema>

// Visual transform for a picture-in-picture camera clip.
export const clipTransformSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().min(0).default(0),
  height: z.number().min(0).default(0),
  crop: boundsSchema.optional(),
  opacity: z.number().min(0).max(1).default(1),
  shape: z.enum(["rectangle", "rounded", "circle"]).default("rectangle"),
})

export type ClipTransform = z.infer<typeof clipTransformSchema>

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

// Audio clip: an audio source slice with volume and fade controls.
export const audioClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("audio"),
  volume: z.number().min(0).max(2).default(1),
  fadeInMs: z.number().min(0).default(0),
  fadeOutMs: z.number().min(0).default(0),
})

export type AudioClip = z.infer<typeof audioClipSchema>

// Caption clip: a timed text cue on the captions track.
export const captionClipSchema = timelineClipBaseSchema.extend({
  kind: z.literal("caption"),
  text: z.string(),
  style: z.string().default("default"),
})

export type CaptionClip = z.infer<typeof captionClipSchema>

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
  muted: z.boolean().default(false),
  volume: z.number().min(0).max(2).default(1),
  segments: z.array(renderSegmentSchema).default([]),
})

export type RenderPlanAudio = z.infer<typeof renderPlanAudioSchema>

// Picture-in-picture overlay settings for the final render.
export const renderPlanOverlaySchema = z.object({
  assetId: z.string(),
  sourceInMs: z.number().int().min(0),
  sourceOutMs: z.number().int().min(0),
  outputStartMs: z.number().int().min(0),
  outputEndMs: z.number().int().min(0),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  opacity: z.number().min(0).max(1).default(1),
})

export type RenderPlanOverlay = z.infer<typeof renderPlanOverlaySchema>

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
