import { z } from "zod"
import { timelineCanvasSchema, timelineStateSchema } from "./timeline"

// Canvas settings are stored in the on-disk project file under the same schema.
export const canvasSettingsSchema = timelineCanvasSchema

export type CanvasSettings = z.infer<typeof canvasSettingsSchema>

// recordForge project is a saved timeline. It shares the same shape as the
// in-memory timeline state so projects can be loaded back into the editor.
export const projectSchema = timelineStateSchema

export type recordForgeProject = z.infer<typeof projectSchema>
