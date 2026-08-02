import { z } from "zod"

// Canvas settings for the timeline and final export.
export const canvasSettingsSchema = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  fps: z.number().int().min(1),
  background: z.string(),
  padding: z.number().min(0).default(0),
  borderRadius: z.number().min(0).default(0),
  shadow: z.boolean().default(false),
})

export type CanvasSettings = z.infer<typeof canvasSettingsSchema>

// Minimal timeline clip schema for Phase 0.
export const timelineClipSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  startMs: z.number().int(),
  durationMs: z.number().int(),
  sourceInMs: z.number().int(),
  sourceOutMs: z.number().int(),
  speed: z.number().positive().default(1),
})

export type TimelineClip = z.infer<typeof timelineClipSchema>

export const projectSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  canvas: canvasSettingsSchema,
  tracks: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["screen", "camera", "audio", "captions", "effects"]),
      name: z.string(),
      muted: z.boolean().default(false),
      locked: z.boolean().default(false),
      clips: z.array(timelineClipSchema),
    }),
  ),
  markers: z.array(
    z.object({
      id: z.string(),
      timeMs: z.number().int(),
      label: z.string(),
    }),
  ),
})

export type recordForgeProject = z.infer<typeof projectSchema>
