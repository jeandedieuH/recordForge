import { z } from "zod"

/** Metadata returned by the signed desktop updater after a successful check. */
export const updateMetadataSchema = z.object({
  version: z.string().min(1),
  currentVersion: z.string().min(1),
  body: z.string().nullable(),
  pubDate: z.string().nullable(),
})

export type UpdateMetadata = z.infer<typeof updateMetadataSchema>

/** Native operations that must finish before the Windows installer can run. */
export const updateReadinessBlockerSchema = z.enum([
  "recording",
  "recording-finalizing",
  "media-job-active",
  "upload-active",
  "operation-active",
  "update-in-progress",
])

export type UpdateReadinessBlocker = z.infer<typeof updateReadinessBlockerSchema>

export const updateReadinessSchema = z.object({
  canInstall: z.boolean(),
  blockers: z.array(updateReadinessBlockerSchema),
})

export type UpdateReadiness = z.infer<typeof updateReadinessSchema>

/** Compact progress messages emitted while the updater downloads an artifact. */
export const updateDownloadEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("Started"),
    data: z.object({
      contentLength: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    event: z.literal("Progress"),
    data: z.object({
      chunkLength: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    event: z.literal("Finished"),
  }),
])

export type UpdateDownloadEvent = z.infer<typeof updateDownloadEventSchema>
