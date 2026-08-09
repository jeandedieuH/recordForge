import { z } from "zod"

// Typed selection state for the timeline editor.
//
// Selection is view state, not project state. It is not persisted in the
// project file, but it is serialized to the Zustand view store so the UI can
// render the inspector and timeline highlights consistently.

export const timelineSelectionKindSchema = z.enum(["clip", "range", "marker", "zoom"])
export type TimelineSelectionKind = z.infer<typeof timelineSelectionKindSchema>

export const timelineSelectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("clip"),
    /** Primary (last touched) clip id. */
    primaryClipId: z.string(),
    /** All selected clip ids. */
    clipIds: z.array(z.string()),
    /** Track id for the primary clip when known. */
    trackId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("range"),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal("marker"),
    markerId: z.string(),
  }),
  z.object({
    kind: z.literal("zoom"),
    segmentId: z.string(),
  }),
])

export type TimelineSelection = z.infer<typeof timelineSelectionSchema>
