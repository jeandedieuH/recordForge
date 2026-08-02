import { z } from "zod"

// User-facing error categories shared across Rust and TypeScript boundaries.
export const errorCategorySchema = z.enum([
  "capture",
  "media",
  "storage",
  "project",
  "editor",
  "permissions",
  "unknown",
])

export type ErrorCategory = z.infer<typeof errorCategorySchema>

export const appErrorSchema = z.object({
  category: errorCategorySchema,
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
})

export type AppError = z.infer<typeof appErrorSchema>
