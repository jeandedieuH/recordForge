import { z } from "zod"

/** Supported storage provider types */
export const StorageProviderKindSchema = z.enum(["local", "s3", "gdrive"])
export type StorageProviderKind = z.infer<typeof StorageProviderKindSchema>

/** Configuration for S3-compatible cloud storage (AWS, Cloudflare R2, MinIO, Wasabi, Backblaze) */
export const S3ConfigSchema = z.object({
  endpoint: z.string().url("Invalid S3 endpoint URL"),
  region: z.string().min(1, "Region is required"),
  bucket: z.string().min(1, "Bucket name is required"),
  prefix: z.string().nullish().default(""),
  partSizeBytes: z
    .number()
    .int()
    .positive()
    .nullish()
    .default(8 * 1024 * 1024), // 8MB default
  forcePathStyle: z.boolean().nullish().default(false),
})
export type S3Config = z.infer<typeof S3ConfigSchema>

/** Input schema for saving S3 profile (includes secrets stored securely in OS vault) */
export const SaveS3ProfileInputSchema = z.object({
  id: z.string().nullish(),
  name: z.string().min(1, "Profile name is required"),
  config: S3ConfigSchema,
  accessKeyId: z.string().nullish().default(""),
  secretAccessKey: z.string().nullish().default(""),
  isDefault: z.boolean().nullish().default(false),
})
export type SaveS3ProfileInput = z.infer<typeof SaveS3ProfileInputSchema>

/** Configuration for Google Drive storage */
export const GoogleDriveConfigSchema = z.object({
  folderId: z.string().nullish().default("root"),
  folderName: z.string().nullish().default("recordForge"),
  accountEmail: z.string().nullish(),
  chunkSizeBytes: z
    .number()
    .int()
    .positive()
    .nullish()
    .default(5 * 1024 * 1024), // 5MB chunks
})
export type GoogleDriveConfig = z.infer<typeof GoogleDriveConfigSchema>

/** Input schema for saving Google Drive profile */
export const SaveGoogleDriveProfileInputSchema = z.object({
  id: z.string().nullish(),
  name: z.string().min(1, "Profile name is required"),
  config: GoogleDriveConfigSchema,
  refreshToken: z.string().nullish(),
  isDefault: z.boolean().nullish().default(false),
})
export type SaveGoogleDriveProfileInput = z.infer<typeof SaveGoogleDriveProfileInputSchema>

/** Configuration for local disk target */
export const LocalFolderConfigSchema = z.object({
  destinationPath: z.string().min(1, "Destination path is required"),
})
export type LocalFolderConfig = z.infer<typeof LocalFolderConfigSchema>

/** Non-secret storage profile safe for UI display and SQLite persistence */
export const StorageProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: StorageProviderKindSchema,
  isDefault: z.boolean(),
  s3Config: S3ConfigSchema.nullish(),
  driveConfig: GoogleDriveConfigSchema.nullish(),
  localConfig: LocalFolderConfigSchema.nullish(),
  hasCredentials: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type StorageProfile = z.infer<typeof StorageProfileSchema>

/** Result of a live connection test to a storage provider */
export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().nullish(),
  details: z.record(z.string(), z.string()).nullish(),
})
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>

/** Status states for upload background jobs */
export const UploadJobStateSchema = z.enum([
  "pending",
  "uploading",
  "paused",
  "completed",
  "failed",
  "cancelled",
])
export type UploadJobState = z.infer<typeof UploadJobStateSchema>

/** Upload job tracking record */
export const UploadJobSchema = z.object({
  id: z.string(),
  providerProfileId: z.string(),
  providerProfileName: z.string().nullish(),
  providerKind: StorageProviderKindSchema,
  recordingId: z.string().nullish(),
  exportId: z.string().nullish(),
  localPath: z.string(),
  remotePath: z.string(),
  state: UploadJobStateSchema,
  bytesUploaded: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  speedBps: z.number().int().nonnegative().nullish().default(0),
  remoteUrl: z.string().nullish(),
  retryCount: z.number().int().nonnegative().default(0),
  lastError: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullish(),
})
export type UploadJob = z.infer<typeof UploadJobSchema>

/** Input for starting an upload job */
export const StartUploadJobInputSchema = z.object({
  profileId: z.string(),
  recordingId: z.string().nullish(),
  exportId: z.string().nullish(),
  localPath: z.string().min(1, "Local path is required"),
  customDestinationName: z.string().nullish(),
})
export type StartUploadJobInput = z.infer<typeof StartUploadJobInputSchema>

/** OAuth PKCE Flow Start Response */
export const OAuthFlowStartResultSchema = z.object({
  authUrl: z.string(),
  state: z.string(),
  port: z.number().int(),
})
export type OAuthFlowStartResult = z.infer<typeof OAuthFlowStartResultSchema>
