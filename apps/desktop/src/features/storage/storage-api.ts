import { invoke } from "@tauri-apps/api/core"
import {
  ConnectionTestResultSchema,
  OAuthFlowStartResultSchema,
  SaveGoogleDriveProfileInputSchema,
  SaveS3ProfileInputSchema,
  StorageProfileSchema,
  UploadJobSchema,
  type ConnectionTestResult,
  type OAuthFlowStartResult,
  type S3Config,
  type SaveGoogleDriveProfileInput,
  type SaveS3ProfileInput,
  type StartUploadJobInput,
  type StorageProfile,
  type UploadJob,
} from "@recordforge/contracts"
import { z } from "zod"

export async function listStorageProfiles(): Promise<StorageProfile[]> {
  const res = await invoke("list_storage_profiles")
  return z.array(StorageProfileSchema).parse(res)
}

export async function saveS3Profile(input: SaveS3ProfileInput): Promise<StorageProfile> {
  const validated = SaveS3ProfileInputSchema.parse(input)
  const res = await invoke("save_s3_profile", { input: validated })
  return StorageProfileSchema.parse(res)
}

export async function saveGoogleDriveProfile(
  input: SaveGoogleDriveProfileInput
): Promise<StorageProfile> {
  const validated = SaveGoogleDriveProfileInputSchema.parse(input)
  const res = await invoke("save_google_drive_profile", { input: validated })
  return StorageProfileSchema.parse(res)
}

export async function saveLocalProfile(input: {
  id?: string
  name: string
  config: { destinationPath: string }
  isDefault?: boolean
}): Promise<StorageProfile> {
  const res = await invoke("save_local_profile", { input })
  return StorageProfileSchema.parse(res)
}

export async function deleteStorageProfile(profileId: string): Promise<void> {
  await invoke("delete_storage_profile", { profileId })
}

export async function testStorageProfile(profileId: string): Promise<ConnectionTestResult> {
  const res = await invoke("test_storage_profile", { profileId })
  return ConnectionTestResultSchema.parse(res)
}

export async function testS3Credentials(
  config: S3Config,
  accessKey: string,
  secretKey: string
): Promise<ConnectionTestResult> {
  const res = await invoke("test_s3_credentials", {
    config,
    accessKey,
    secretKey,
  })
  return ConnectionTestResultSchema.parse(res)
}

export async function startGoogleDriveOAuth(): Promise<OAuthFlowStartResult> {
  const res = await invoke("start_google_drive_oauth")
  return OAuthFlowStartResultSchema.parse(res)
}

export async function startUploadJob(input: StartUploadJobInput): Promise<UploadJob> {
  const res = await invoke("start_upload_job", { input })
  return UploadJobSchema.parse(res)
}

export async function cancelUploadJob(jobId: string): Promise<void> {
  await invoke("cancel_upload_job", { jobId })
}

export async function retryUploadJob(jobId: string): Promise<UploadJob> {
  const res = await invoke("retry_upload_job", { jobId })
  return UploadJobSchema.parse(res)
}

export async function listUploadJobs(): Promise<UploadJob[]> {
  const res = await invoke("list_upload_jobs")
  return z.array(UploadJobSchema).parse(res)
}

export async function deleteUploadJob(jobId: string): Promise<void> {
  await invoke("delete_upload_job", { jobId })
}
