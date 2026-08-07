import { z } from "zod"
import { projectAssetRoleSchema } from "./media"
import { timelineCanvasSchema, timelineMarkerSchema, timelineTrackSchema } from "./timeline"

// Canvas settings are stored in the on-disk project file under the same schema.
export const canvasSettingsSchema = timelineCanvasSchema

export type CanvasSettings = z.infer<typeof canvasSettingsSchema>

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
  path: z.string(),
  status: projectAssetStatusSchema.default("available"),
  durationMs: z.number().int().min(0).default(0),
  width: z.number().int().min(0).nullish(),
  height: z.number().int().min(0).nullish(),
  fps: z.number().min(0).nullish(),
  hasAudio: z.boolean().default(false),
  streamIndex: z.number().int().min(0).optional(),
})

export type ProjectAsset = z.infer<typeof projectAssetSchema>

// Export settings persisted with the project.
export const projectExportSettingsSchema = z.object({
  preset: z.string().default("default-mp4"),
  codec: z.string().default("h264"),
  container: z.string().default("mp4"),
})

export type ProjectExportSettings = z.infer<typeof projectExportSettingsSchema>

export const defaultProjectExportSettings: ProjectExportSettings =
  projectExportSettingsSchema.parse({})

// Durable, versioned project file format.
// This is the on-disk shape stored in sessions/{recording_session}/project.json.
export const projectSchema = z.object({
  format: z.literal("recordforge.project"),
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  recordingId: z.string(),
  canvas: timelineCanvasSchema,
  assets: z.array(projectAssetSchema),
  tracks: z.array(timelineTrackSchema),
  markers: z.array(timelineMarkerSchema),
  exportSettings: projectExportSettingsSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  checksum: z.string(),
})

export type recordForgeProject = z.infer<typeof projectSchema>

// `Project` is the preferred alias for the durable project type.
export type Project = recordForgeProject
