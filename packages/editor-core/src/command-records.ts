import { z } from "zod"
import {
  clipTransformSchema,
  cursorSettingsSchema,
  timelineCanvasSchema,
  timelineTrackKindSchema,
  trackUpdateSchema,
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
  timeMs: z.number().int().min(0),
  label: z.string(),
  color: z.string().default("#f59e0b"),
})

export type AddMarkerCommand = z.infer<typeof addMarkerCommandSchema>

export const deleteMarkerCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-marker"),
  markerId: z.string(),
})

export type DeleteMarkerCommand = z.infer<typeof deleteMarkerCommandSchema>

export const addTrackCommandSchema = commandMetaSchema.extend({
  kind: z.literal("add-track"),
  trackKind: timelineTrackKindSchema,
  trackName: z.string().optional(),
})

export type AddTrackCommand = z.infer<typeof addTrackCommandSchema>

export const deleteTrackCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-track"),
  trackId: z.string(),
})

export type DeleteTrackCommand = z.infer<typeof deleteTrackCommandSchema>

export const trimClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("trim-clip"),
  clipId: z.string(),
  sourceInMs: z.number().int().min(0),
  sourceOutMs: z.number().int().min(0),
})

export type TrimClipCommand = z.infer<typeof trimClipCommandSchema>

export const splitClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("split-clip"),
  clipId: z.string(),
  splitTimeMs: z.number().int().min(0),
})

export type SplitClipCommand = z.infer<typeof splitClipCommandSchema>

export const moveClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("move-clip"),
  clipId: z.string(),
  newStartMs: z.number().int().min(0),
  newTrackId: z.string().optional(),
})

export type MoveClipCommand = z.infer<typeof moveClipCommandSchema>

export const deleteClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("delete-clip"),
  clipId: z.string(),
})

export type DeleteClipCommand = z.infer<typeof deleteClipCommandSchema>

export const rippleDeleteClipCommandSchema = commandMetaSchema.extend({
  kind: z.literal("ripple-delete-clip"),
  clipId: z.string(),
})

export type RippleDeleteClipCommand = z.infer<typeof rippleDeleteClipCommandSchema>

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
  text: z.string(),
  startMs: z.number().int().min(0),
  durationMs: z.number().int().min(0),
})

export type AddCaptionClipCommand = z.infer<typeof addCaptionClipCommandSchema>

export const updateCanvasCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-canvas"),
  canvas: timelineCanvasSchema.partial(),
})

export type UpdateCanvasCommand = z.infer<typeof updateCanvasCommandSchema>

export const updateCursorSettingsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("update-cursor-settings"),
  cursorSettings: cursorSettingsSchema.partial(),
})

export type UpdateCursorSettingsCommand = z.infer<typeof updateCursorSettingsCommandSchema>

export const trimTimelineEndsCommandSchema = commandMetaSchema.extend({
  kind: z.literal("trim-timeline-ends"),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
})

export type TrimTimelineEndsCommand = z.infer<typeof trimTimelineEndsCommandSchema>

export const commandRecordSchema = z.discriminatedUnion("kind", [
  addMarkerCommandSchema,
  deleteMarkerCommandSchema,
  addTrackCommandSchema,
  deleteTrackCommandSchema,
  trimClipCommandSchema,
  splitClipCommandSchema,
  moveClipCommandSchema,
  deleteClipCommandSchema,
  rippleDeleteClipCommandSchema,
  updateTrackCommandSchema,
  updateClipAudioCommandSchema,
  updateClipTransformCommandSchema,
  addCaptionClipCommandSchema,
  updateCanvasCommandSchema,
  updateCursorSettingsCommandSchema,
  trimTimelineEndsCommandSchema,
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
