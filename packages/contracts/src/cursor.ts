import { z } from "zod"
import { boundsSchema } from "./recording"

// V2 cursor telemetry is the single source of truth for preview, export,
// recovery, and capture. V1 schemas have been removed.

// The editor and export only support the Recorded/System cursor style.
// Legacy curated presets are migrated to "recorded-system" during project load.
const MIGRATED_CURSOR_PRESETS: Record<string, "recorded-system" | undefined> = {
  "recorded-system": "recorded-system",
  default: "recorded-system",
  "modern-neon": "recorded-system",
  "sleek-dark": "recorded-system",
  "mac-pro": "recorded-system",
}

export const cursorIconPresetSchema = z.preprocess(
  (value) =>
    typeof value === "string" ? (MIGRATED_CURSOR_PRESETS[value] ?? "recorded-system") : value,
  z.enum(["recorded-system"]),
)

export type CursorIconPreset = z.infer<typeof cursorIconPresetSchema>

export const clickFeedbackSchema = z.enum(["ripple", "pulse", "spotlight", "none"])
export type ClickFeedback = z.infer<typeof clickFeedbackSchema>

// Smoothing is represented as a named preset on cursor ranges while the legacy
// canvas settings continue to expose the numeric factor used by the renderer.
export const cursorSmoothingSchema = z.enum(["off", "smooth", "strong"])
export type CursorSmoothing = z.infer<typeof cursorSmoothingSchema>

export const cursorShapeModeSchema = z.enum(["preset", "recorded", "optimized"])
export type CursorShapeMode = z.infer<typeof cursorShapeModeSchema>

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

export const cursorSettingsFields = {
  enabled: z.boolean(),
  preset: cursorIconPresetSchema,
  scale: z.number().min(0.2).max(5.0),
  fillColor: z.string(),
  fillOpacity: z.number().min(0).max(1),
  strokeColor: z.string(),
  strokeWidth: z.number().min(0).max(10),
  strokeOpacity: z.number().min(0).max(1),
  shadowEnabled: z.boolean(),
  shadowColor: z.string(),
  shadowBlur: z.number().min(0).max(30),
  shadowOffsetX: z.number().min(-20).max(20),
  shadowOffsetY: z.number().min(-20).max(20),
  shadowOpacity: z.number().min(0).max(1),
  clickFeedback: clickFeedbackSchema,
  clickColor: z.string(),
  clickSize: z.number().min(10).max(100),
  clickDurationMs: z.number().min(100).max(2000),
  leftClickEnabled: z.boolean(),
  rightClickEnabled: z.boolean(),
  clickPressAnimation: z.boolean(),
  smoothMovement: z.boolean(),
  smoothFactor: z.number().min(0.05).max(1.0),
  autoHideIdle: z.boolean(),
  idleTimeoutMs: z.number().min(500).max(10000),
  spotlightMode: z.boolean(),
  spotlightRadius: z.number().min(40).max(300),
  spotlightDimOpacity: z.number().min(0).max(0.9),
  hideNativeCursor: z.boolean(),
  shapeMode: cursorShapeModeSchema,
}

export const cursorSettingsSchema = z.object({
  enabled: cursorSettingsFields.enabled.default(true),
  preset: cursorSettingsFields.preset.default("recorded-system"),
  scale: cursorSettingsFields.scale.default(1.0),
  fillColor: cursorSettingsFields.fillColor.default("#3b82f6"),
  fillOpacity: cursorSettingsFields.fillOpacity.default(1.0),
  strokeColor: cursorSettingsFields.strokeColor.default("#ffffff"),
  strokeWidth: cursorSettingsFields.strokeWidth.default(2.0),
  strokeOpacity: cursorSettingsFields.strokeOpacity.default(1.0),
  shadowEnabled: cursorSettingsFields.shadowEnabled.default(true),
  shadowColor: cursorSettingsFields.shadowColor.default("#000000"),
  shadowBlur: cursorSettingsFields.shadowBlur.default(8.0),
  shadowOffsetX: cursorSettingsFields.shadowOffsetX.default(2.0),
  shadowOffsetY: cursorSettingsFields.shadowOffsetY.default(4.0),
  shadowOpacity: cursorSettingsFields.shadowOpacity.default(0.4),
  clickFeedback: cursorSettingsFields.clickFeedback.default("ripple"),
  clickColor: cursorSettingsFields.clickColor.default("#60a5fa"),
  clickSize: cursorSettingsFields.clickSize.default(36.0),
  clickDurationMs: cursorSettingsFields.clickDurationMs.default(350),
  leftClickEnabled: cursorSettingsFields.leftClickEnabled.default(true),
  rightClickEnabled: cursorSettingsFields.rightClickEnabled.default(true),
  clickPressAnimation: cursorSettingsFields.clickPressAnimation.default(true),
  smoothMovement: cursorSettingsFields.smoothMovement.default(true),
  smoothFactor: cursorSettingsFields.smoothFactor.default(0.25),
  autoHideIdle: cursorSettingsFields.autoHideIdle.default(false),
  idleTimeoutMs: cursorSettingsFields.idleTimeoutMs.default(2000),
  spotlightMode: cursorSettingsFields.spotlightMode.default(false),
  spotlightRadius: cursorSettingsFields.spotlightRadius.default(120),
  spotlightDimOpacity: cursorSettingsFields.spotlightDimOpacity.default(0.5),
  hideNativeCursor: cursorSettingsFields.hideNativeCursor.default(true),
  shapeMode: cursorSettingsFields.shapeMode.default("optimized"),
})

export type CursorSettings = z.infer<typeof cursorSettingsSchema>

export const defaultCursorSettings: CursorSettings = cursorSettingsSchema.parse({})

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

export const cursorTelemetryEventSchema = z.object({
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
  timebase: cursorTelemetryTimebaseSchema.default(() => cursorTelemetryTimebaseSchema.parse({})),
  sampleRateHz: z.number().positive().default(60),
  clickWindowMs: z.number().positive().default(350),
  health: cursorTelemetryHealthSchema.default("healthy"),
  eventCount: z.number().int().min(0).default(0),
  index: z.array(cursorEventIndexEntrySchema).default([]),
  eventFile: z.string().default("cursor_events.bin"),
})

export type CursorTelemetryMetadata = z.infer<typeof cursorTelemetryMetadataSchema>

function identityTransform(): CursorCoordinateTransform {
  return {
    a00: 1,
    a01: 0,
    a10: 0,
    a11: 1,
    b0: 0,
    b1: 0,
  }
}

function addV2Defaults(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const input = value as Record<string, unknown>
  const recordingId = typeof input.recordingId === "string" ? input.recordingId : "recording"
  const sourceWidth = typeof input.sourceWidth === "number" ? input.sourceWidth : 1
  const sourceHeight = typeof input.sourceHeight === "number" ? input.sourceHeight : 1

  return {
    ...input,
    schemaVersion: typeof input.schemaVersion === "number" ? input.schemaVersion : 2,
    assetId: input.assetId ?? `cursor-events:${recordingId}`,
    recordingId,
    captureBounds: input.captureBounds ?? {
      x: 0,
      y: 0,
      width: sourceWidth,
      height: sourceHeight,
    },
    coordinateTransform: input.coordinateTransform ?? identityTransform(),
    shapes: Array.isArray(input.shapes) ? input.shapes : [],
    timebase: input.timebase ?? { unit: "ms", ticksPerSecond: 1000 },
    sampleRateHz: typeof input.sampleRateHz === "number" ? input.sampleRateHz : 60,
    clickWindowMs: typeof input.clickWindowMs === "number" ? input.clickWindowMs : 350,
    health: input.health ?? "healthy",
    eventCount: typeof input.eventCount === "number" ? input.eventCount : 0,
    index: Array.isArray(input.index) ? input.index : [],
    eventFile: typeof input.eventFile === "string" ? input.eventFile : "cursor_events.bin",
  }
}

export const cursorTelemetryFileSchema = z.preprocess(
  addV2Defaults,
  cursorTelemetryMetadataSchema.extend({
    events: z.array(cursorTelemetryEventSchema),
  }),
)

export type CursorTelemetryFile = z.infer<typeof cursorTelemetryFileSchema>

// Partial settings are persisted on a cursor range. The renderer merges them
// with the full-duration default, so adding a new setting remains migration-safe.
export const cursorEffectSettingsSchema = z
  .object(cursorSettingsFields)
  .partial()
  .extend({
    presetId: cursorIconPresetSchema.optional(),
    smoothing: cursorSmoothingSchema.optional(),
    opacity: z.number().min(0).max(1).optional(),
  })

export type CursorEffectSettings = z.infer<typeof cursorEffectSettingsSchema>

export const cursorTelemetryAssetId = (recordingId: string): string =>
  `cursor-events:${recordingId}`
