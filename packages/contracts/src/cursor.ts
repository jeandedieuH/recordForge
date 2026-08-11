import { z } from "zod"
import { boundsSchema } from "./recording"

// Phase 5 — V2 cursor telemetry: independent buttons, shape metadata, topology,
// and an explicit affine source transform. V1 schemas remain below for legacy
// recordings and the current V1 editor contract.

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

// Smoothing is represented as a named preset on cursor ranges while the legacy
// canvas settings continue to expose the numeric factor used by the renderer.
export const cursorSmoothingSchema = z.enum(["off", "smooth", "strong"])
export type CursorSmoothing = z.infer<typeof cursorSmoothingSchema>

// `down` and `up` are edge samples; `held` is intentionally not treated as a
// click by preview/export. Older telemetry only has `clicked`, so consumers must
// keep the legacy fallback when buttonEvent is `none`.
export const cursorButtonEventSchema = z.enum(["none", "down", "held", "up"])
export type CursorButtonEvent = z.infer<typeof cursorButtonEventSchema>

export const cursorSettingsSchema = z.object({
  enabled: z.boolean().default(true),
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
  clickDurationMs: z.number().min(100).max(2000).default(350),
  leftClickEnabled: z.boolean().default(true),
  rightClickEnabled: z.boolean().default(true),
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
  x: z.number().finite(),
  y: z.number().finite(),
  clicked: z.boolean().default(false),
  button: z.enum(["left", "right", "middle", "none"]).default("none"),
  buttonEvent: cursorButtonEventSchema.default("none"),
  visible: z.boolean().default(true),
  shapeId: z.string().optional(),
})

export type CursorTelemetryEvent = z.infer<typeof cursorTelemetryEventSchema>

export const cursorTelemetryTimebaseSchema = z.object({
  unit: z.literal("ms").default("ms"),
  ticksPerSecond: z.number().int().positive().default(1000),
})

export type CursorTelemetryTimebase = z.infer<typeof cursorTelemetryTimebaseSchema>

export const cursorDpiScaleSchema = z.object({
  x: z.number().positive().default(1),
  y: z.number().positive().default(1),
})

export type CursorDpiScale = z.infer<typeof cursorDpiScaleSchema>

export const cursorTelemetryAssetMetadataSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  assetId: z.string().min(1),
  recordingId: z.string().min(1),
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  captureBounds: boundsSchema,
  dpiScale: cursorDpiScaleSchema.default({}),
  timebase: cursorTelemetryTimebaseSchema.default({}),
  sampleRateHz: z.number().positive().default(60),
})

export type CursorTelemetryAssetMetadata = z.infer<typeof cursorTelemetryAssetMetadataSchema>

const cursorTelemetryFileBaseSchema = cursorTelemetryAssetMetadataSchema.extend({
  events: z.array(cursorTelemetryEventSchema),
})

function addTelemetryDefaults(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const input = value as Record<string, unknown>
  const recordingId = typeof input.recordingId === "string" ? input.recordingId : "recording"
  const sourceWidth = typeof input.sourceWidth === "number" ? input.sourceWidth : 1
  const sourceHeight = typeof input.sourceHeight === "number" ? input.sourceHeight : 1

  return {
    ...input,
    schemaVersion: input.schemaVersion ?? 1,
    assetId: input.assetId ?? `cursor-events:${recordingId}`,
    captureBounds: input.captureBounds ?? {
      x: 0,
      y: 0,
      width: sourceWidth,
      height: sourceHeight,
    },
    dpiScale: input.dpiScale ?? { x: 1, y: 1 },
    timebase: input.timebase ?? { unit: "ms", ticksPerSecond: 1000 },
  }
}

// The preprocess keeps v1 recordings readable while guaranteeing that every
// normalized file has the metadata needed by preview, export, and recovery.
export const cursorTelemetryFileSchema = z.preprocess(
  addTelemetryDefaults,
  cursorTelemetryFileBaseSchema,
)

export type CursorTelemetryFile = z.infer<typeof cursorTelemetryFileSchema>

// ---------------------------------------------------------------------------
// V2 cursor telemetry schemas
// ---------------------------------------------------------------------------

export const cursorCoordinateTransformSchema = z.object({
  a00: z.number().finite(),
  a01: z.number().finite(),
  a10: z.number().finite(),
  a11: z.number().finite(),
  b0: z.number().finite(),
  b1: z.number().finite(),
})

export type CursorCoordinateTransform = z.infer<typeof cursorCoordinateTransformSchema>

export const cursorTopologySchema = z.object({
  displayId: z.string().min(1),
  displayBounds: boundsSchema,
  isPrimary: z.boolean(),
  orientation: z.number().int().min(0),
  scaleFactor: z.number().positive(),
  dpiX: z.number().positive(),
  dpiY: z.number().positive(),
})

export type CursorTopology = z.infer<typeof cursorTopologySchema>

export const cursorShapeInfoSchema = z.object({
  shapeId: z.string().min(1),
  hotspotX: z.number().int(),
  hotspotY: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  kind: z.string(),
})

export type CursorShapeInfo = z.infer<typeof cursorShapeInfoSchema>

export const cursorButtonStateSchema = z.object({
  left: z.boolean(),
  right: z.boolean(),
  middle: z.boolean(),
  x1: z.boolean(),
  x2: z.boolean(),
})

export type CursorButtonState = z.infer<typeof cursorButtonStateSchema>

export const cursorButtonEventV2Schema = z.enum([
  "none",
  "left-down",
  "left-up",
  "left-held",
  "right-down",
  "right-up",
  "right-held",
  "middle-down",
  "middle-up",
  "middle-held",
  "x1-down",
  "x1-up",
  "x1-held",
  "x2-down",
  "x2-up",
  "x2-held",
])

export type CursorButtonEventV2 = z.infer<typeof cursorButtonEventV2Schema>

export const cursorTelemetryHealthSchema = z.enum([
  "healthy",
  "positionUnavailable",
  "buttonsUnavailable",
  "shapesUnavailable",
  "topologyUnavailable",
])

export type CursorTelemetryHealth = z.infer<typeof cursorTelemetryHealthSchema>

export const cursorEventIndexEntrySchema = z.object({
  eventIndex: z.number().int().min(0),
  tMs: z.number().int().min(0),
  fileOffset: z.number().int().min(0),
})

export type CursorEventIndexEntry = z.infer<typeof cursorEventIndexEntrySchema>

export const cursorTelemetryEventV2Schema = z.object({
  tMs: z.number().int().min(0),
  rawX: z.number().int(),
  rawY: z.number().int(),
  sourceX: z.number().finite(),
  sourceY: z.number().finite(),
  buttons: cursorButtonStateSchema,
  buttonEvent: cursorButtonEventV2Schema,
  visible: z.boolean(),
  shapeId: z.string(),
  shapeChanged: z.boolean(),
})

export type CursorTelemetryEventV2 = z.infer<typeof cursorTelemetryEventV2Schema>

export const cursorTelemetryMetadataSchema = z.object({
  schemaVersion: z.number().int().positive(),
  assetId: z.string().min(1),
  recordingId: z.string().min(1),
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  captureBounds: boundsSchema,
  coordinateTransform: cursorCoordinateTransformSchema,
  topology: cursorTopologySchema.optional(),
  shapes: z.array(cursorShapeInfoSchema).default([]),
  timebase: cursorTelemetryTimebaseSchema.default({}),
  sampleRateHz: z.number().positive().default(60),
  clickWindowMs: z.number().positive().default(350),
  health: cursorTelemetryHealthSchema.default("healthy"),
  eventCount: z.number().int().min(0).default(0),
  index: z.array(cursorEventIndexEntrySchema).default([]),
  eventFile: z.string().default("cursor_events.bin"),
})

export type CursorTelemetryMetadata = z.infer<typeof cursorTelemetryMetadataSchema>

export const cursorTelemetryFileV2Schema = cursorTelemetryMetadataSchema.extend({
  events: z.array(cursorTelemetryEventV2Schema),
})

export type CursorTelemetryFileV2 = z.infer<typeof cursorTelemetryFileV2Schema>

// Partial settings are persisted on a cursor range. The renderer merges them
// with the full-duration default, so adding a new setting remains migration-safe.
export const cursorEffectSettingsSchema = cursorSettingsSchema.partial().extend({
  presetId: cursorIconPresetSchema.optional(),
  smoothing: cursorSmoothingSchema.optional(),
  opacity: z.number().min(0).max(1).optional(),
})

export type CursorEffectSettings = z.infer<typeof cursorEffectSettingsSchema>

export const cursorTelemetryAssetId = (recordingId: string): string =>
  `cursor-events:${recordingId}`
