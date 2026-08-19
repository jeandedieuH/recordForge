import { z } from "zod"
import { cursorDpiScaleSchema, cursorTelemetryTimebaseSchema } from "./cursor"
import { boundsSchema } from "./recording"
import { mediaKindSchema, projectAssetImportStrategySchema, projectAssetRoleSchema } from "./media"
import {
  manualZoomSegmentSchema,
  smartZoomSettingsSchema,
  timelineCanvasSchema,
  timelineMarkerSchema,
  timelineTrackSchema,
} from "./timeline"
import { exportSettingsSchema } from "./timeline"

// Canvas settings are stored in the on-disk project file under the same schema.
export const canvasSettingsSchema = timelineCanvasSchema

export type CanvasSettings = z.infer<typeof canvasSettingsSchema>

const assetKindByRole: Record<string, z.infer<typeof mediaKindSchema>> = {
  screen: "video",
  webcam: "video",
  b_roll: "video",
  microphone: "audio",
  system_audio: "audio",
  music: "audio",
  audio_track: "audio",
  cursor_events: "cursor",
  caption: "caption",
  image: "image",
  graphic: "image",
}

const overlayInAnimationTypes = new Set([
  "none",
  "fade",
  "scale-up",
  "scale-down",
  "slide-up",
  "slide-down",
  "draw",
  "typewriter",
])

const overlayOutAnimationTypes = new Set([
  "none",
  "fade",
  "scale-up",
  "scale-down",
  "slide-up",
  "slide-down",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAbsolutePath(value: string): boolean {
  return /^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value) || value.startsWith("file://")
}

function mapLegacyAnimation(value: unknown, phase: "in" | "out"): string | undefined {
  if (typeof value !== "string") return undefined
  if (phase === "in" && overlayInAnimationTypes.has(value)) return value
  if (phase === "out" && overlayOutAnimationTypes.has(value)) return value
  if (value === "zoom-punch") return phase === "in" ? "scale-up" : "scale-down"
  if (value === "expand-bar") return phase === "in" ? "slide-up" : "slide-down"
  if (phase === "out" && (value === "draw" || value === "typewriter")) return "fade"
  return undefined
}

export function normalizeProjectAssetInput(value: unknown): unknown {
  if (!isRecord(value)) return value

  const role = typeof value.role === "string" ? value.role : undefined
  const path = typeof value.path === "string" ? value.path : undefined
  const kind =
    typeof value.kind === "string" ? value.kind : role ? assetKindByRole[role] : undefined
  const importStrategy =
    typeof value.importStrategy === "string"
      ? value.importStrategy
      : path && isAbsolutePath(path)
        ? "reference"
        : "copy"

  return {
    ...value,
    ...(kind ? { kind } : {}),
    ...(importStrategy ? { importStrategy } : {}),
  }
}

export function normalizeOverlayClipInput(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (value.kind !== "annotation" && value.kind !== "text" && value.kind !== "image") {
    return value
  }

  const existingAnimation = isRecord(value.overlayAnimation) ? value.overlayAnimation : {}
  const inType = existingAnimation.inType ?? mapLegacyAnimation(value.animationIn, "in") ?? "fade"
  const outType =
    existingAnimation.outType ?? mapLegacyAnimation(value.animationOut, "out") ?? "fade"

  return {
    ...value,
    rotation: value.rotation ?? 0,
    anchorX: value.anchorX ?? 0.5,
    anchorY: value.anchorY ?? 0.5,
    zIndex: value.zIndex ?? 0,
    opacity: value.opacity ?? 1,
    overlayAnimation: {
      inType,
      outType,
      inDurationMs: existingAnimation.inDurationMs ?? 350,
      outDurationMs: existingAnimation.outDurationMs ?? 350,
      easing: existingAnimation.easing ?? "expo-out",
    },
  }
}

export function migrateProjectInput(value: unknown): unknown {
  if (!isRecord(value)) return value

  const assets = Array.isArray(value.assets)
    ? value.assets.map(normalizeProjectAssetInput)
    : (value.assets ?? [])
  const tracks = Array.isArray(value.tracks)
    ? value.tracks.map((track) => {
        if (!isRecord(track) || !Array.isArray(track.clips)) return track
        return { ...track, clips: track.clips.map(normalizeOverlayClipInput) }
      })
    : (value.tracks ?? [])

  return {
    ...value,
    format: value.format ?? "recordforge.project",
    version: value.version ?? 1,
    assets,
    tracks,
    markers: value.markers ?? [],
    zoomSegments: value.zoomSegments ?? [],
    smartZoomSettings: value.smartZoomSettings ?? {},
    exportSettings: value.exportSettings ?? {},
    checksum: value.checksum ?? "",
  }
}

// Status of an asset in the project registry.
// `available`  - the file exists and is ready for preview/export.
// `missing`    - the file could not be found on load and must be relinked.
// `relinked`   - the asset was manually pointed to a new file.
export const projectAssetStatusSchema = z.enum(["available", "missing", "relinked"])
export type ProjectAssetStatus = z.infer<typeof projectAssetStatusSchema>

// One durable asset entry in a project. Assets are immutable source files referenced
// by clips in the timeline. Paths are stored relative to the project directory
// and resolved to absolute paths by the Rust backend on load.
export const projectAssetSchema = z.object({
  id: z.string(),
  role: projectAssetRoleSchema,
  kind: mediaKindSchema.optional(),
  path: z.string(),
  status: projectAssetStatusSchema.default("available"),
  contentHash: z.string().optional(),
  importStrategy: projectAssetImportStrategySchema.optional(),
  originalPath: z.string().optional(),
  svgSafe: z.boolean().optional(),
  derivativeVersion: z.number().int().min(0).default(1),
  derivatives: z.record(z.string(), z.string()).optional(),
  durationMs: z.number().int().min(0).default(0),
  width: z.number().int().min(0).nullish(),
  height: z.number().int().min(0).nullish(),
  fps: z.number().min(0).nullish(),
  hasAudio: z.boolean().default(false),
  streamIndex: z.number().int().min(0).nullish(),
  // Cursor telemetry assets retain their capture contract in the registry so
  // preview/export never need to infer metadata from a recording path.
  sourceWidth: z.number().int().positive().nullish(),
  sourceHeight: z.number().int().positive().nullish(),
  sampleRateHz: z.number().positive().nullish(),
  schemaVersion: z.number().int().positive().nullish(),
  captureBounds: boundsSchema.nullish(),
  dpiScale: cursorDpiScaleSchema.nullish(),
  timebase: cursorTelemetryTimebaseSchema.nullish(),
  cursorMetadata: z.enum(["available", "unavailable"]).nullish(),
})

export type ProjectAsset = z.infer<typeof projectAssetSchema>

// Export settings persisted with the project.
export const projectExportSettingsSchema = exportSettingsSchema

export type ProjectExportSettings = z.infer<typeof projectExportSettingsSchema>

export const defaultProjectExportSettings: ProjectExportSettings =
  projectExportSettingsSchema.parse({})

// Durable, versioned project file format.
// This is the on-disk shape stored in sessions/{recording_session}/project.json.
const projectSchemaBase = z.object({
  format: z.literal("recordforge.project"),
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  recordingId: z.string(),
  canvas: timelineCanvasSchema,
  assets: z.array(projectAssetSchema),
  tracks: z.array(timelineTrackSchema),
  markers: z.array(timelineMarkerSchema),
  // Optional for projects created before Phase 6. New edits persist the
  // collection so manual and generated zoom behavior survives reopen.
  zoomSegments: z.array(manualZoomSegmentSchema).optional(),
  smartZoomSettings: smartZoomSettingsSchema.optional(),
  exportSettings: projectExportSettingsSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  checksum: z.string(),
})

export const projectSchema = z.preprocess(migrateProjectInput, projectSchemaBase)

export type recordForgeProject = z.infer<typeof projectSchema>

// `Project` is the preferred alias for the durable project type.
export type Project = recordForgeProject

// Lightweight project summary for project browsing and management in the UI.
export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  recordingId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  durationMs: z.number().int().min(0).default(0),
  thumbnailPath: z.string().nullish(),
  workDir: z.string().nullish(),
  trackCount: z.number().int().min(0).default(0),
  clipCount: z.number().int().min(0).default(0),
  width: z.number().int().min(0).nullish(),
  height: z.number().int().min(0).nullish(),
  fps: z.number().min(0).nullish(),
})

export type ProjectSummary = z.infer<typeof projectSummarySchema>
