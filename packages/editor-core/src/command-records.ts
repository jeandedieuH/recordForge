import { z } from "zod"
import {
  annotationClipSchema,
  audioRoleSchema,
  audioVolumeKeyframeSchema,
  captionCueSchema,
  captionDesignSchema,
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
  loupeSettingsSchema,
  manualZoomSegmentSchema,
  cameraLayoutKindSchema,
  cameraLayoutPipSchema,
  cameraLayoutSourceSchema,
  cameraColorSchema,
  cameraCutoutSchema,
  cameraFaceTrackingSchema,
  smartZoomSettingsSchema,
  textClipSchema,
  timelineCanvasSchema,
  timelineTrackKindSchema,
  trackUpdateSchema,
  videoClipSchema,
  zoomEasingSchema,
  zoomModeSchema,
  zoomPresetSchema,
  zoomSourceSchema,
  zoomStyleSchema,
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

// Retime a clip (or a selection of span-aligned clips) without re-cutting the
// source: duration becomes `(sourceOut − sourceIn) / speed` and everything
// downstream is remapped by the F5 time warp.
export const setClipSpeedCommandSchema = commandMetaSchema.extend({
  kind: z.literal("set-clip-speed"),
  clipIds: z.array(z.string()).min(1),
  /** Playback rate: 2 = twice as fast, 0.5 = half speed. */
  speed: z.number().min(0.1).max(16),
  /** Shift later timeline content so the edit stays gapless (default true). */
  ripple: z.boolean().default(true),
})

export type SetClipSpeedCommand = z.infer<typeof setClipSpeedCommandSchema>

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

// Clip groups: members share a groupId so selection-driven edits treat them as
// one unit. `groupId` is optional so fixtures can pin deterministic ids.
export const groupClipsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("group-clips"),
  clipIds: z.array(z.string()).min(2),
  groupId: z.string().optional(),
})

export type GroupClipsCommand = z.infer<typeof groupClipsCommandSchema>

// Removes exactly the listed clips from their groups; clips not listed keep
// their membership, so partial-selection ungroup is supported.
export const ungroupClipsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("ungroup-clips"),
  clipIds: z.array(z.string()).min(1),
})

export type UngroupClipsCommand = z.infer<typeof ungroupClipsCommandSchema>

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

// Smart Cut applies many silence removals as one command → one undo step.
export const rippleDeleteRangesCommandSchema = commandMetaSchema.extend({
  kind: z.literal("ripple-delete-ranges"),
  ranges: z
    .array(z.object({ startMs: z.number().int().min(0), endMs: z.number().int().min(0) }))
    .min(1),
})

export type RippleDeleteRangesCommand = z.infer<typeof rippleDeleteRangesCommandSchema>

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

// M4 camera effects (#4a–c). Passing `null` clears the field so a reset is one
// undoable command; omitted fields are left untouched.
export const setCameraEffectsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("set-camera-effects"),
  clipId: z.string(),
  color: cameraColorSchema.nullable().optional(),
  cutout: cameraCutoutSchema.nullable().optional(),
  faceTracking: cameraFaceTrackingSchema.nullable().optional(),
})

export type SetCameraEffectsCommand = z.infer<typeof setCameraEffectsCommandSchema>

// #4d: replace every silence-generated camera-layout segment from analysed
// dead-air ranges. Manual segments are preserved (and win on overlap).
export const generateCameraSilenceLayoutsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("generate-camera-silence-layouts"),
  ranges: z
    .array(
      z.object({
        startMs: z.number().int().min(0),
        endMs: z.number().int().min(0),
      }),
    )
    .default([]),
  minSilenceMs: z.number().int().min(500).default(2500),
  padMs: z.number().int().min(0).max(2000).default(150),
  transitionMs: z.number().int().min(0).max(10_000).default(400),
  durationMs: z.number().int().min(0),
  fps: z.number().positive().optional(),
})

export type GenerateCameraSilenceLayoutsCommand = z.infer<
  typeof generateCameraSilenceLayoutsCommandSchema
>

export const addCaptionClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-caption-clip"),
  // When omitted, the existing captions track is used or one is created.
  trackId: z.string().optional(),
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
  // null clears a per-clip placement override back to inherit — the same
  // convention `design.accentColor: null` uses on update-caption-track.
  placement: captionPlacementSchema.nullable().optional(),
  safeAreaMargin: z.number().int().min(0).max(2_000).optional(),
})

export type UpdateCaptionClipCommand = z.infer<typeof updateCaptionClipCommandSchema>

// Applies shared styling to every caption clip on a captions track so users can
// restyle an imported cue set as a single undoable command.
export const updateCaptionTrackCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-caption-track"),
  trackId: z.string(),
  style: captionStylePresetSchema.optional(),
  placement: captionPlacementSchema.optional(),
  safeAreaMargin: z.number().int().min(0).max(2_000).optional(),
  // Partial track design merged over the resolved current design. `uppercase`
  // and `accentColor` also accept null = clear back to the look default.
  design: captionDesignSchema
    .partial()
    .extend({
      uppercase: z.boolean().nullable().optional(),
      accentColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable()
        .optional(),
    })
    .optional(),
})

export type UpdateCaptionTrackCommand = z.infer<typeof updateCaptionTrackCommandSchema>

export const importCaptionCuesCommandSchema = commandMetaSchema.extend({
  kind: z.literal("import-caption-cues"),
  trackId: z.string().optional(),
  trackName: z.string().min(1).optional(),
  cues: z.array(captionCueSchema).min(1),
  mode: z.enum(["append", "replace"]).optional(),
  design: captionDesignSchema.partial().optional(),
  style: captionStylePresetSchema.optional(),
  placement: captionPlacementSchema.optional(),
  safeAreaMargin: z.number().int().min(0).max(2_000).optional(),
})

export type ImportCaptionCuesCommand = z.infer<typeof importCaptionCuesCommandSchema>

// Adjacent caption clips merged into one — keeps the first clip's id and
// per-clip overrides, joins text with a single space.
export const mergeCaptionClipsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("merge-caption-clips"),
  clipIds: z.array(z.string()).min(2).max(50),
})

export type MergeCaptionClipsCommand = z.infer<typeof mergeCaptionClipsCommandSchema>

// Find/replace over all caption clips of the (given or only) captions track.
export const replaceCaptionTextCommandSchema = commandMetaSchema.extend({
  kind: z.literal("replace-caption-text"),
  trackId: z.string().optional(),
  find: z.string().min(1).max(200),
  replace: z.string().max(200),
  matchCase: z.boolean(),
  wholeWord: z.boolean(),
})

export type ReplaceCaptionTextCommand = z.infer<typeof replaceCaptionTextCommandSchema>

// Provenance-anchored re-alignment: re-times AI captions through the current
// audio coverage without re-running whisper. Atomic — one undo step.
export const resyncCaptionTrackCommandSchema = commandMetaSchema.extend({
  kind: z.literal("resync-caption-track"),
  trackId: z.string(),
})

export type ResyncCaptionTrackCommand = z.infer<typeof resyncCaptionTrackCommandSchema>

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
  // Camera source dimensions keyed by camera clip id. When an aspect-ratio
  // change triggers the smart re-layout, the engine rebuilds each camera
  // clip's preset transform and needs real source pixels to compute the crop.
  cameraSources: z
    .record(z.string(), z.object({ width: z.number().positive(), height: z.number().positive() }))
    .optional(),
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
  followSpeed: z.enum(["relaxed", "balanced", "tight"]).optional(),
  label: z.string().optional(),
  style: zoomStyleSchema.optional(),
  loupe: loupeSettingsSchema.partial().optional(),
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
  followSpeed: z.enum(["relaxed", "balanced", "tight"]).optional(),
  label: z.string().optional(),
  style: zoomStyleSchema.optional(),
  loupe: loupeSettingsSchema.partial().optional(),
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

// Bulk delete applies as one command → one undo step (mirrors delete-clips).
export const deleteZoomSegmentsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-zoom-segments"),
  segmentIds: z.array(z.string()).min(1),
})

export type DeleteZoomSegmentsCommand = z.infer<typeof deleteZoomSegmentsCommandSchema>

export const regenerateZoomSuggestionsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("regenerate-zoom-suggestions"),
  segments: z.array(manualZoomSegmentSchema),
})

export type RegenerateZoomSuggestionsCommand = z.infer<
  typeof regenerateZoomSuggestionsCommandSchema
>

// Camera layout lane (#5). One command per gesture keeps undo granularity
// aligned with what the user sees (a drag is one resize command).
export const addCameraLayoutCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-camera-layout"),
  segmentId: z.string().optional(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  layout: cameraLayoutKindSchema,
  pip: cameraLayoutPipSchema.partial().optional(),
  transitionInMs: z.number().int().min(0).max(10_000).optional(),
  transitionOutMs: z.number().int().min(0).max(10_000).optional(),
  easing: zoomEasingSchema.optional(),
  source: cameraLayoutSourceSchema.optional(),
  label: z.string().optional(),
})

export type AddCameraLayoutCommand = z.infer<typeof addCameraLayoutCommandSchema>

export const updateCameraLayoutCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-camera-layout"),
  segmentId: z.string(),
  startMs: z.number().int().min(0).optional(),
  endMs: z.number().int().positive().optional(),
  layout: cameraLayoutKindSchema.optional(),
  pip: cameraLayoutPipSchema.partial().optional(),
  transitionInMs: z.number().int().min(0).max(10_000).optional(),
  transitionOutMs: z.number().int().min(0).max(10_000).optional(),
  easing: zoomEasingSchema.optional(),
  enabled: z.boolean().optional(),
  locked: z.boolean().optional(),
  label: z.string().optional(),
})

export type UpdateCameraLayoutCommand = z.infer<typeof updateCameraLayoutCommandSchema>

export const splitCameraLayoutCommandSchema = commandMetaSchema.extend({
  kind: z.literal("split-camera-layout"),
  segmentId: z.string(),
  splitTimeMs: z.number().int().min(0),
  leftSegmentId: z.string().optional(),
  rightSegmentId: z.string().optional(),
})

export type SplitCameraLayoutCommand = z.infer<typeof splitCameraLayoutCommandSchema>

export const resizeCameraLayoutCommandSchema = commandMetaSchema.extend({
  kind: z.literal("resize-camera-layout"),
  segmentId: z.string(),
  startMs: z.number().int().min(0).optional(),
  endMs: z.number().int().positive().optional(),
})

export type ResizeCameraLayoutCommand = z.infer<typeof resizeCameraLayoutCommandSchema>

export const deleteCameraLayoutCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-camera-layout"),
  segmentId: z.string(),
})

export type DeleteCameraLayoutCommand = z.infer<typeof deleteCameraLayoutCommandSchema>

export const deleteCameraLayoutsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-camera-layouts"),
  segmentIds: z.array(z.string()).min(1),
})

export type DeleteCameraLayoutsCommand = z.infer<typeof deleteCameraLayoutsCommandSchema>

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

// B-roll / media-track video (#13). Adds an existing project video asset as a
// composited layer; the clip's embedded audio mixes automatically.
export const addVideoClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-video-clip"),
  trackId: z.string().optional(),
  clip: videoClipSchema,
})

export type AddVideoClipCommand = z.infer<typeof addVideoClipCommandSchema>

export const updateVideoClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-video-clip"),
  clipId: z.string(),
  update: videoClipSchema.partial(),
})

export type UpdateVideoClipCommand = z.infer<typeof updateVideoClipCommandSchema>

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
  setClipSpeedCommandSchema,
  splitClipCommandSchema,
  splitAllClipsCommandSchema,
  moveClipCommandSchema,
  duplicateClipCommandSchema,
  duplicateClipsCommandSchema,
  deleteClipCommandSchema,
  moveClipsCommandSchema,
  deleteClipsCommandSchema,
  groupClipsCommandSchema,
  ungroupClipsCommandSchema,
  rippleDeleteClipCommandSchema,
  deleteRangeCommandSchema,
  rippleDeleteRangeCommandSchema,
  rippleDeleteRangesCommandSchema,
  rippleDeleteClipsCommandSchema,
  updateTrackCommandSchema,
  updateClipAudioCommandSchema,
  updateClipTransformCommandSchema,
  setCameraEffectsCommandSchema,
  generateCameraSilenceLayoutsCommandSchema,
  addCaptionClipCommandSchema,
  updateCaptionClipCommandSchema,
  updateCaptionTrackCommandSchema,
  importCaptionCuesCommandSchema,
  mergeCaptionClipsCommandSchema,
  replaceCaptionTextCommandSchema,
  resyncCaptionTrackCommandSchema,
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
  deleteZoomSegmentsCommandSchema,
  regenerateZoomSuggestionsCommandSchema,
  addCameraLayoutCommandSchema,
  updateCameraLayoutCommandSchema,
  splitCameraLayoutCommandSchema,
  resizeCameraLayoutCommandSchema,
  deleteCameraLayoutCommandSchema,
  deleteCameraLayoutsCommandSchema,
  trimTimelineEndsCommandSchema,
  addAnnotationClipCommandSchema,
  updateAnnotationClipCommandSchema,
  addTextClipCommandSchema,
  updateTextClipCommandSchema,
  addImageClipCommandSchema,
  updateImageClipCommandSchema,
  addVideoClipCommandSchema,
  updateVideoClipCommandSchema,
  addExternalAudioClipCommandSchema,
])

export type CommandRecord = z.infer<typeof commandRecordSchema>

// Caption find/replace helpers shared by the command and the UI live counter.
export interface CaptionTextReplaceOptions {
  find: string
  matchCase: boolean
  wholeWord: boolean
}

export interface CaptionTextMatchCount {
  matches: number
  cues: number
}

// The previous closure-based command interface is being replaced by the
// `CommandRecord` discriminated union. `TimelineCommand` remains as a
// backwards-compatible alias so existing consumers can migrate incrementally.
export type TimelineCommand = CommandRecord

/** Validate an arbitrary object as a command record. */
export function validateCommandRecord(value: unknown): CommandRecord | null {
  const result = commandRecordSchema.safeParse(value)
  return result.success ? result.data : null
}
