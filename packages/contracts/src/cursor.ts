import { z } from "zod"

export const cursorIconPresetSchema = z.enum([
  "default",
  "modern-neon",
  "sleek-dark",
  "highlighter-circle",
  "mac-pro",
  "cyberpunk",
  "minimal-dot",
  "hand-pointer",
])

export type CursorIconPreset = z.infer<typeof cursorIconPresetSchema>

export const clickFeedbackSchema = z.enum(["ripple", "pulse", "spotlight", "none"])
export type ClickFeedback = z.infer<typeof clickFeedbackSchema>

export const cursorSettingsSchema = z.object({
  preset: cursorIconPresetSchema.default("modern-neon"),
  scale: z.number().min(0.2).max(5.0).default(1.0),
  fillColor: z.string().default("#3b82f6"),
  fillOpacity: z.number().min(0).max(1).default(1.0),
  strokeColor: z.string().default("#ffffff"),
  strokeWidth: z.number().min(0).max(10).default(2.0),
  strokeOpacity: z.number().min(0).max(1).default(1.0),
  shadowEnabled: z.boolean().default(true),
  shadowColor: z.string().default("#000000"),
  shadowBlur: z.number().min(0).max(30).default(8.0),
  shadowOffsetX: z.number().min(-20).max(20).default(2.0),
  shadowOffsetY: z.number().min(-20).max(20).default(4.0),
  shadowOpacity: z.number().min(0).max(1).default(0.4),
  clickFeedback: clickFeedbackSchema.default("ripple"),
  clickColor: z.string().default("#60a5fa"),
  clickSize: z.number().min(10).max(100).default(36.0),
  smoothMovement: z.boolean().default(true),
  smoothFactor: z.number().min(0.05).max(1.0).default(0.25),
  autoHideIdle: z.boolean().default(false),
  idleTimeoutMs: z.number().min(500).max(10000).default(2000),
  spotlightMode: z.boolean().default(false),
  spotlightRadius: z.number().min(40).max(300).default(120),
  spotlightDimOpacity: z.number().min(0).max(0.9).default(0.5),
  hideNativeCursor: z.boolean().default(true),
})

export type CursorSettings = z.infer<typeof cursorSettingsSchema>

export const defaultCursorSettings: CursorSettings = cursorSettingsSchema.parse({})

export const cursorTelemetryEventSchema = z.object({
  tMs: z.number().int().min(0),
  x: z.number(),
  y: z.number(),
  clicked: z.boolean().default(false),
  button: z.enum(["left", "right", "middle", "none"]).default("none"),
  visible: z.boolean().default(true),
})

export type CursorTelemetryEvent = z.infer<typeof cursorTelemetryEventSchema>

export const cursorTelemetryFileSchema = z.object({
  recordingId: z.string(),
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  sampleRateHz: z.number().default(60),
  events: z.array(cursorTelemetryEventSchema),
})

export type CursorTelemetryFile = z.infer<typeof cursorTelemetryFileSchema>
