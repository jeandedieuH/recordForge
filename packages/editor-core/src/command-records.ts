import { z } from "zod"
import {
  annotationClipSchema,
  audioRoleSchema,
  audioVolumeKeyframeSchema,
  captionCueSchema,
  captionPlacementSchema,
  captionStylePresetSchema,
  clipTransformSchema,
  cursorEffectSettingsSchema,
  imageClipSchema,
  maskColorSchema,
  overlayAnimationSchema,
  maskModeSchema,
  maskRectSchema,
  cursorIconPresetSchema,
  cursorSettingsSchema,
  cursorSmoothingSchema,
  manualZoomSegmentSchema,
  smartZoomSettingsSchema,
  textClipSchema,
  timelineCanvasSchema,
  timelineTrackKindSchema,
  trackUpdateSchema,
  zoomEasingSchema,
  zoomModeSchema,
  zoomPresetSchema,
  zoomSourceSchema,
  zoomTargetSchema,
} from "@recordforge/contracts"

// Serializable, discriminated command records for the timeline command engine.
//
// Every command has a stable `kind`, a human-readable `name`, optional
// `coalesce` flag and a `coalesceKey` for high-frequency gestures, and the
// arguments needed to deterministically apply and undo the command.
//
// `id` and `coalesce` are optional on input; the engine assigns a command id
// and a default `coalesce: false` before the command is recorded in history.
//
// These records are designed to be serializable so a command sequence can be
// stored in a fixture and replayed for tests. They are not persisted in the
// project file; the project file stores the resulting timeline state.

export const commandMetaSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  coalesce: z.boolean().optional(),
  coalesceKey: z.string().optional(),
})

export type CommandMeta = z.infer<typeof commandMetaSchema>

export const addMarkerCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-marker"),
  markerId: z.string().optional(),
  timeMs: z.number().int().min(0),
  label: z.string(),
  color: z.string().default("#f59e0b"),
})

export type AddMarkerCommand = z.infer<typeof addMarkerCommandSchema>

export const updateMarkerCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-marker"),
  markerId: z.string(),
  timeMs: z.number().int().min(0).optional(),
  label: z.string().optional(),
  color: z.string().optional(),
})

export type UpdateMarkerCommand = z.infer<typeof updateMarkerCommandSchema>

export const deleteMarkerCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-marker"),
  markerId: z.string(),
})

export type DeleteMarkerCommand = z.infer<typeof deleteMarkerCommandSchema>

export const addTrackCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-track"),
  trackId: z.string().optional(),
  trackKind: timelineTrackKindSchema,
  trackName: z.string().optional(),
})

export type AddTrackCommand = z.infer<typeof addTrackCommandSchema>

export const deleteTrackCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-track"),
  trackId: z.string(),
})

export type DeleteTrackCommand = z.infer<typeof deleteTrackCommandSchema>

export const moveTrackCommandSchema = commandMetaSchema.extend({
  kind: z.literal("move-track"),
  trackId: z.string(),
  newIndex: z.number().int().min(0),
})

export type MoveTrackCommand = z.infer<typeof moveTrackCommandSchema>

export const reorderTracksCommandSchema = commandMetaSchema.extend({
  kind: z.literal("reorder-tracks"),
  trackIds: z.array(z.string()),
})

export type ReorderTracksCommand = z.infer<typeof reorderTracksCommandSchema>

export const trimClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("trim-clip"),
  clipId: z.string(),
  /** Optional timeline start used by direct left-edge trims. */
  startMs: z.number().int().min(0).optional(),
  sourceInMs: z.number().int().min(0),
  sourceOutMs: z.number().int().min(0),
})

export type TrimClipCommand = z.infer<typeof trimClipCommandSchema>

export const splitClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("split-clip"),
  clipId: z.string(),
  splitTimeMs: z.number().int().min(0),
  leftClipId: z.string().optional(),
  rightClipId: z.string().optional(),
})

export type SplitClipCommand = z.infer<typeof splitClipCommandSchema>

export const splitAllClipsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("split-all-clips"),
  splitTimeMs: z.number().int().min(0),
  trackIds: z.array(z.string()).optional(),
})

export type SplitAllClipsCommand = z.infer<typeof splitAllClipsCommandSchema>

export const moveClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("move-clip"),
  clipId: z.string(),
  newStartMs: z.number().int().min(0),
  newTrackId: z.string().optional(),
})

export type MoveClipCommand = z.infer<typeof moveClipCommandSchema>

export const duplicateClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("duplicate-clip"),
  clipId: z.string(),
  /** Optional explicit start time; defaults to one frame after the original clip ends. */
  newStartMs: z.number().int().min(0).optional(),
  newClipId: z.string().optional(),
})

export type DuplicateClipCommand = z.infer<typeof duplicateClipCommandSchema>

export const duplicateClipsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("duplicate-clips"),
  clipIds: z.array(z.string()).min(1),
  /** Offset applied to every selected clip. Defaults to one frame after the rightmost selection ends. */
  deltaMs: z.number().int().optional(),
})

export type DuplicateClipsCommand = z.infer<typeof duplicateClipsCommandSchema>

export const deleteClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-clip"),
  clipId: z.string(),
})

export type DeleteClipCommand = z.infer<typeof deleteClipCommandSchema>

export const moveClipsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("move-clips"),
  clipIds: z.array(z.string()).min(1),
  deltaMs: z.number().int(),
})

export type MoveClipsCommand = z.infer<typeof moveClipsCommandSchema>

export const deleteClipsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-clips"),
  clipIds: z.array(z.string()).min(1),
})

export type DeleteClipsCommand = z.infer<typeof deleteClipsCommandSchema>

export const rippleDeleteClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("ripple-delete-clip"),
  clipId: z.string(),
})

export type RippleDeleteClipCommand = z.infer<typeof rippleDeleteClipCommandSchema>

export const deleteRangeCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-range"),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
})

export type DeleteRangeCommand = z.infer<typeof deleteRangeCommandSchema>

export const rippleDeleteRangeCommandSchema = commandMetaSchema.extend({
  kind: z.literal("ripple-delete-range"),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
})

export type RippleDeleteRangeCommand = z.infer<typeof rippleDeleteRangeCommandSchema>

export const rippleDeleteClipsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("ripple-delete-clips"),
  clipIds: z.array(z.string()).min(1),
})

export type RippleDeleteClipsCommand = z.infer<typeof rippleDeleteClipsCommandSchema>

export const updateTrackCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-track"),
  trackId: z.string(),
  update: trackUpdateSchema,
})

export type UpdateTrackCommand = z.infer<typeof updateTrackCommandSchema>

export const updateClipAudioCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-clip-audio"),
  clipId: z.string(),
  volume: z.number().min(0).max(2).optional(),
  fadeInMs: z.number().min(0).optional(),
  fadeOutMs: z.number().min(0).optional(),
  volumeKeyframes: z.array(audioVolumeKeyframeSchema).optional(),
})

export type UpdateClipAudioCommand = z.infer<typeof updateClipAudioCommandSchema>

export const updateClipTransformCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-clip-transform"),
  clipId: z.string(),
  transform: clipTransformSchema,
})

export type UpdateClipTransformCommand = z.infer<typeof updateClipTransformCommandSchema>

export const addCaptionClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-caption-clip"),
  trackId: z.string(),
  clipId: z.string().optional(),
  text: z.string().min(1),
  startMs: z.number().int().min(0),
  durationMs: z.number().int().positive(),
  style: captionStylePresetSchema.optional(),
  placement: captionPlacementSchema.optional(),
  safeAreaMargin: z.number().int().min(0).max(2_000).optional(),
})

export type AddCaptionClipCommand = z.infer<typeof addCaptionClipCommandSchema>

export const updateCaptionClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-caption-clip"),
  clipId: z.string(),
  text: z.string().min(1).optional(),
  style: captionStylePresetSchema.optional(),
  placement: captionPlacementSchema.optional(),
  safeAreaMargin: z.number().int().min(0).max(2_000).optional(),
})

export type UpdateCaptionClipCommand = z.infer<typeof updateCaptionClipCommandSchema>

export const importCaptionCuesCommandSchema = commandMetaSchema.extend({
  kind: z.literal("import-caption-cues"),
  trackId: z.string().optional(),
  trackName: z.string().min(1).optional(),
  cues: z.array(captionCueSchema).min(1),
  style: captionStylePresetSchema.optional(),
  placement: captionPlacementSchema.optional(),
  safeAreaMargin: z.number().int().min(0).max(2_000).optional(),
})

export type ImportCaptionCuesCommand = z.infer<typeof importCaptionCuesCommandSchema>

export const addMaskClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-mask-clip"),
  trackId: z.string().optional(),
  clipId: z.string().optional(),
  assetId: z.string(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  mode: maskModeSchema,
  rect: maskRectSchema,
  blurRadius: z.number().min(1).max(128).optional(),
  pixelSize: z.number().int().min(2).max(128).optional(),
  redactColor: maskColorSchema.optional(),
})

export type AddMaskClipCommand = z.infer<typeof addMaskClipCommandSchema>

export const updateMaskClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-mask-clip"),
  clipId: z.string(),
  mode: maskModeSchema.optional(),
  rect: maskRectSchema.partial().optional(),
  blurRadius: z.number().min(1).max(128).optional(),
  pixelSize: z.number().int().min(2).max(128).optional(),
  redactColor: maskColorSchema.optional(),
  enabled: z.boolean().optional(),
})

export type UpdateMaskClipCommand = z.infer<typeof updateMaskClipCommandSchema>

export const updateCanvasCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-canvas"),
  canvas: timelineCanvasSchema.partial(),
})

export type UpdateCanvasCommand = z.infer<typeof updateCanvasCommandSchema>

export const updateSmartZoomSettingsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-smart-zoom-settings"),
  settings: smartZoomSettingsSchema.partial(),
})

export type UpdateSmartZoomSettingsCommand = z.infer<typeof updateSmartZoomSettingsCommandSchema>

export const updateCursorSettingsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-cursor-settings"),
  cursorSettings: cursorSettingsSchema.partial(),
})

export type UpdateCursorSettingsCommand = z.infer<typeof updateCursorSettingsCommandSchema>

export const addCursorRangeCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-cursor-range"),
  trackId: z.string().optional(),
  rangeId: z.string().optional(),
  assetId: z.string(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  presetId: cursorIconPresetSchema.optional(),
  scale: z.number().min(0.2).max(5).optional(),
  smoothing: cursorSmoothingSchema.optional(),
  settings: cursorEffectSettingsSchema.optional(),
})

export type AddCursorRangeCommand = z.infer<typeof addCursorRangeCommandSchema>

export const splitCursorRangeCommandSchema = commandMetaSchema.extend({
  kind: z.literal("split-cursor-range"),
  rangeId: z.string(),
  splitTimeMs: z.number().int().min(0),
  leftRangeId: z.string().optional(),
  rightRangeId: z.string().optional(),
})

export type SplitCursorRangeCommand = z.infer<typeof splitCursorRangeCommandSchema>

export const resizeCursorRangeCommandSchema = commandMetaSchema.extend({
  kind: z.literal("resize-cursor-range"),
  rangeId: z.string(),
  startMs: z.number().int().min(0).optional(),
  endMs: z.number().int().positive().optional(),
})

export type ResizeCursorRangeCommand = z.infer<typeof resizeCursorRangeCommandSchema>

export const updateCursorRangeCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-cursor-range"),
  rangeId: z.string(),
  enabled: z.boolean().optional(),
  locked: z.boolean().optional(),
  presetId: cursorIconPresetSchema.optional(),
  scale: z.number().min(0.2).max(5).optional(),
  smoothing: cursorSmoothingSchema.optional(),
  settings: cursorEffectSettingsSchema.optional(),
  // Phase 8: when true, command.settings replaces the range's stored settings
  // instead of being merged. This lets a range reset to the project profile.
  replaceSettings: z.boolean().optional(),
})

export type UpdateCursorRangeCommand = z.infer<typeof updateCursorRangeCommandSchema>

export const deleteCursorRangeCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-cursor-range"),
  rangeId: z.string(),
})

export type DeleteCursorRangeCommand = z.infer<typeof deleteCursorRangeCommandSchema>

export const addZoomSegmentCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-zoom-segment"),
  segmentId: z.string().optional(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  target: zoomTargetSchema,
  scale: z.number().min(1).max(8).optional(),
  easing: zoomEasingSchema.optional(),
  transitionInMs: z.number().int().min(0).max(10_000).optional(),
  transitionOutMs: z.number().int().min(0).max(10_000).optional(),
  mode: zoomModeSchema.optional(),
  source: zoomSourceSchema.optional(),
  preset: zoomPresetSchema.optional(),
  followDeadzonePercent: z.number().min(0.01).max(0.5).optional(),
  followSmoothingAlpha: z.number().min(0.05).max(1.0).optional(),
  label: z.string().optional(),
})

export type AddZoomSegmentCommand = z.infer<typeof addZoomSegmentCommandSchema>

export const updateZoomSegmentCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-zoom-segment"),
  segmentId: z.string(),
  startMs: z.number().int().min(0).optional(),
  endMs: z.number().int().positive().optional(),
  target: zoomTargetSchema.partial().optional(),
  scale: z.number().min(1).max(8).optional(),
  easing: zoomEasingSchema.optional(),
  transitionInMs: z.number().int().min(0).max(10_000).optional(),
  transitionOutMs: z.number().int().min(0).max(10_000).optional(),
  enabled: z.boolean().optional(),
  locked: z.boolean().optional(),
  mode: zoomModeSchema.optional(),
  source: zoomSourceSchema.optional(),
  preset: zoomPresetSchema.optional(),
  followDeadzonePercent: z.number().min(0.01).max(0.5).optional(),
  followSmoothingAlpha: z.number().min(0.05).max(1.0).optional(),
  label: z.string().optional(),
})

export type UpdateZoomSegmentCommand = z.infer<typeof updateZoomSegmentCommandSchema>

export const splitZoomSegmentCommandSchema = commandMetaSchema.extend({
  kind: z.literal("split-zoom-segment"),
  segmentId: z.string(),
  splitTimeMs: z.number().int().min(0),
  leftSegmentId: z.string().optional(),
  rightSegmentId: z.string().optional(),
})

export type SplitZoomSegmentCommand = z.infer<typeof splitZoomSegmentCommandSchema>

export const resizeZoomSegmentCommandSchema = commandMetaSchema.extend({
  kind: z.literal("resize-zoom-segment"),
  segmentId: z.string(),
  startMs: z.number().int().min(0).optional(),
  endMs: z.number().int().positive().optional(),
})

export type ResizeZoomSegmentCommand = z.infer<typeof resizeZoomSegmentCommandSchema>

export const deleteZoomSegmentCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-zoom-segment"),
  segmentId: z.string(),
})

export type DeleteZoomSegmentCommand = z.infer<typeof deleteZoomSegmentCommandSchema>

export const regenerateZoomSuggestionsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("regenerate-zoom-suggestions"),
  segments: z.array(manualZoomSegmentSchema),
})

export type RegenerateZoomSuggestionsCommand = z.infer<
  typeof regenerateZoomSuggestionsCommandSchema
>

export const trimTimelineEndsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("trim-timeline-ends"),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
})

export type TrimTimelineEndsCommand = z.infer<typeof trimTimelineEndsCommandSchema>

export const addAnnotationClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-annotation-clip"),
  trackId: z.string().optional(),
  clip: annotationClipSchema,
})

export type AddAnnotationClipCommand = z.infer<typeof addAnnotationClipCommandSchema>

export const updateAnnotationClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-annotation-clip"),
  clipId: z.string(),
  update: annotationClipSchema.partial().extend({
    overlayAnimation: overlayAnimationSchema.partial().optional(),
  }),
})

export type UpdateAnnotationClipCommand = z.infer<typeof updateAnnotationClipCommandSchema>

export const addTextClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-text-clip"),
  trackId: z.string().optional(),
  clip: textClipSchema,
})

export type AddTextClipCommand = z.infer<typeof addTextClipCommandSchema>

export const updateTextClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-text-clip"),
  clipId: z.string(),
  update: textClipSchema.partial().extend({
    overlayAnimation: overlayAnimationSchema.partial().optional(),
  }),
})

export type UpdateTextClipCommand = z.infer<typeof updateTextClipCommandSchema>

export const addImageClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-image-clip"),
  trackId: z.string().optional(),
  clip: imageClipSchema,
})

export type AddImageClipCommand = z.infer<typeof addImageClipCommandSchema>

export const updateImageClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-image-clip"),
  clipId: z.string(),
  update: imageClipSchema.partial().extend({
    overlayAnimation: overlayAnimationSchema.partial().optional(),
  }),
})

export type UpdateImageClipCommand = z.infer<typeof updateImageClipCommandSchema>

export const addExternalAudioClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-external-audio-clip"),
  trackId: z.string().optional(),
  clipId: z.string().optional(),
  assetId: z.string(),
  startMs: z.number().int().min(0),
  durationMs: z.number().int().positive(),
  sourceInMs: z.number().int().min(0).default(0),
  sourceOutMs: z.number().int().positive(),
  volume: z.number().min(0).max(2).optional(),
  role: audioRoleSchema.optional(),
  trackName: z.string().optional(),
})

export type AddExternalAudioClipCommand = z.infer<typeof addExternalAudioClipCommandSchema>

export const commandRecordSchema = z.discriminatedUnion("kind", [
  addMarkerCommandSchema,
  updateMarkerCommandSchema,
  deleteMarkerCommandSchema,
  addTrackCommandSchema,
  deleteTrackCommandSchema,
  moveTrackCommandSchema,
  reorderTracksCommandSchema,
  trimClipCommandSchema,
  splitClipCommandSchema,
  splitAllClipsCommandSchema,
  moveClipCommandSchema,
  duplicateClipCommandSchema,
  duplicateClipsCommandSchema,
  deleteClipCommandSchema,
  moveClipsCommandSchema,
  deleteClipsCommandSchema,
  rippleDeleteClipCommandSchema,
  deleteRangeCommandSchema,
  rippleDeleteRangeCommandSchema,
  rippleDeleteClipsCommandSchema,
  updateTrackCommandSchema,
  updateClipAudioCommandSchema,
  updateClipTransformCommandSchema,
  addCaptionClipCommandSchema,
  updateCaptionClipCommandSchema,
  importCaptionCuesCommandSchema,
  addMaskClipCommandSchema,
  updateMaskClipCommandSchema,
  updateCanvasCommandSchema,
  updateSmartZoomSettingsCommandSchema,
  updateCursorSettingsCommandSchema,
  addCursorRangeCommandSchema,
  splitCursorRangeCommandSchema,
  resizeCursorRangeCommandSchema,
  updateCursorRangeCommandSchema,
  deleteCursorRangeCommandSchema,
  addZoomSegmentCommandSchema,
  updateZoomSegmentCommandSchema,
  splitZoomSegmentCommandSchema,
  resizeZoomSegmentCommandSchema,
  deleteZoomSegmentCommandSchema,
  regenerateZoomSuggestionsCommandSchema,
  trimTimelineEndsCommandSchema,
  addAnnotationClipCommandSchema,
  updateAnnotationClipCommandSchema,
  addTextClipCommandSchema,
  updateTextClipCommandSchema,
  addImageClipCommandSchema,
  updateImageClipCommandSchema,
  addExternalAudioClipCommandSchema,
])

export type CommandRecord = z.infer<typeof commandRecordSchema>

// The previous closure-based command interface is being replaced by the
// `CommandRecord` discriminated union. `TimelineCommand` remains as a
// backwards-compatible alias so existing consumers can migrate incrementally.
export type TimelineCommand = CommandRecord

/** Validate an arbitrary object as a command record. */
export function validateCommandRecord(value: unknown): CommandRecord | null {
  const result = commandRecordSchema.safeParse(value)
  return result.success ? result.data : null
}
