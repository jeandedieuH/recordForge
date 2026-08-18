import { z } from "zod"

/** Supported storage provider types */
export const StorageProviderKindSchema = z.enum(["local", "s3", "gdrive"])
export type StorageProviderKind = z.infer<typeof StorageProviderKindSchema>

/** Configuration for S3-compatible cloud storage (AWS, Cloudflare R2, MinIO, Wasabi, Backblaze) */
export const S3ConfigSchema = z.object({
  endpoint: z.string().url("Invalid S3 endpoint URL"),
  region: z.string().min(1, "Region is required"),
  bucket: z.string().min(1, "Bucket name is required"),
  prefix: z.string().optional().default(""),
  partSizeBytes: z.number().int().positive().optional().default(8 * 1024 * 1024), // 8MB default
  forcePathStyle: z.boolean().optional().default(false),
})
export type S3Config = z.infer<typeof S3ConfigSchema>

/** Input schema for saving S3 profile (includes secrets stored securely in OS vault) */
export const SaveS3ProfileInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "Profile name is required"),
  config: S3ConfigSchema,
  accessKeyId: z.string().min(1, "Access Key ID is required"),
  secretAccessKey: z.string().min(1, "Secret Access Key is required"),
  isDefault: z.boolean().optional().default(false),
})
export type SaveS3ProfileInput = z.infer<typeof SaveS3ProfileInputSchema>

/** Configuration for Google Drive storage */
export const GoogleDriveConfigSchema = z.object({
  folderId: z.string().optional().default("root"),
  folderName: z.string().optional().default("recordForge"),
  accountEmail: z.string().optional(),
  chunkSizeBytes: z.number().int().positive().optional().default(5 * 1024 * 1024), // 5MB chunks
})
export type GoogleDriveConfig = z.infer<typeof GoogleDriveConfigSchema>

/** Input schema for saving Google Drive profile */
export const SaveGoogleDriveProfileInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "Profile name is required"),
  config: GoogleDriveConfigSchema,
  refreshToken: z.string().optional(),
  isDefault: z.boolean().optional().default(false),
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
  s3Config: S3ConfigSchema.optional(),
  driveConfig: GoogleDriveConfigSchema.optional(),
  localConfig: LocalFolderConfigSchema.optional(),
  hasCredentials: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type StorageProfile = z.infer<typeof StorageProfileSchema>

/** Result of a live connection test to a storage provider */
export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().optional(),
  details: z.record(z.string(), z.string()).optional(),
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
  providerProfileName: z.string().optional(),
  providerKind: StorageProviderKindSchema,
  recordingId: z.string().optional(),
  exportId: z.string().optional(),
  localPath: z.string(),
  remotePath: z.string(),
  state: UploadJobStateSchema,
  bytesUploaded: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  speedBps: z.number().int().nonnegative().optional().default(0),
  remoteUrl: z.string().optional(),
  retryCount: z.number().int().nonnegative().default(0),
  lastError: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
})
export type UploadJob = z.infer<typeof UploadJobSchema>

/** Input for starting an upload job */
export const StartUploadJobInputSchema = z.object({
  profileId: z.string(),
  recordingId: z.string().optional(),
  exportId: z.string().optional(),
  localPath: z.string().min(1, "Local path is required"),
  customDestinationName: z.string().optional(),
})
export type StartUploadJobInput = z.infer<typeof StartUploadJobInputSchema>

/** OAuth PKCE Flow Start Response */
export const OAuthFlowStartResultSchema = z.object({
  authUrl: z.string(),
  state: z.string(),
  port: z.number().int(),
})
export type OAuthFlowStartResult = z.infer<typeof OAuthFlowStartResultSchema>
