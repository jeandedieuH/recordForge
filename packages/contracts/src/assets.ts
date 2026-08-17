import { z } from "zod"
import { projectAssetSchema, projectSchema, type ProjectAsset } from "./project"
import {
  mediaKindSchema,
  mediaMetadataSchema,
  mediaJobSchema,
  projectAssetImportStrategySchema,
  projectAssetRoleSchema,
} from "./media"

// IPC payloads for the durable project asset importer. Source paths are only
// accepted from the desktop dialog and are revalidated by Rust before use.
export const assetImportRequestSchema = z.object({
  recordingId: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1).max(100),
  strategy: projectAssetImportStrategySchema.default("copy"),
  role: projectAssetRoleSchema.optional(),
})

export type AssetImportRequest = z.infer<typeof assetImportRequestSchema>

export const assetImportRecordSchema = z.object({
  asset: projectAssetSchema,
  sourceName: z.string().min(1),
  derivativeJobId: z.string().nullish(),
})

export type AssetImportRecord = z.infer<typeof assetImportRecordSchema>

export const assetImportSkippedSchema = z.object({
  sourceName: z.string().min(1),
  reason: z.string().min(1),
})

export type AssetImportSkipped = z.infer<typeof assetImportSkippedSchema>

export const assetImportResultSchema = z.object({
  project: projectSchema,
  imported: z.array(assetImportRecordSchema),
  skipped: z.array(assetImportSkippedSchema),
  warnings: z.array(z.string()),
})

export type AssetImportResult = z.infer<typeof assetImportResultSchema>

export const assetDeleteRequestSchema = z.object({
  recordingId: z.string().min(1),
  assetId: z.string().min(1),
  deleteSource: z.boolean().default(false),
})

export type AssetDeleteRequest = z.infer<typeof assetDeleteRequestSchema>

export const assetRelinkRequestSchema = z.object({
  recordingId: z.string().min(1),
  assetId: z.string().min(1),
  newPath: z.string().min(1),
  strategy: projectAssetImportStrategySchema.optional(),
})

export type AssetRelinkRequest = z.infer<typeof assetRelinkRequestSchema>

export const assetProbeRequestSchema = z.object({
  path: z.string().min(1),
  recordingId: z.string().optional(),
})

export type AssetProbeRequest = z.infer<typeof assetProbeRequestSchema>

export const assetDerivativeJobRequestSchema = z.object({
  recordingId: z.string().min(1),
  assetId: z.string().min(1),
  force: z.boolean().default(false),
})

export type AssetDerivativeJobRequest = z.infer<typeof assetDerivativeJobRequestSchema>

export const projectAssetPathMapSchema = z.record(z.string(), z.string())
export type ProjectAssetPathMap = z.infer<typeof projectAssetPathMapSchema>

export interface AssetBinItem extends ProjectAsset {
  resolvedPath?: string
  derivativeJob?: z.infer<typeof mediaJobSchema>
  mediaKind?: z.infer<typeof mediaKindSchema>
  metadata?: z.infer<typeof mediaMetadataSchema>
}
