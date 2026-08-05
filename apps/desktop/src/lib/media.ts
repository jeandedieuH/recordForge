import { listen } from "@tauri-apps/api/event"
import {
  diskSpaceEstimateSchema,
  mediaJobSchema,
  mediaMetadataSchema,
  type DiskSpaceEstimate,
  type MediaJob,
  type MediaMetadata,
  type PrepareMediaOptions,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export async function prepareMedia(options: PrepareMediaOptions): Promise<MediaJob> {
  return invokeValidated("prepare_media", { options }, mediaJobSchema)
}

// Queue the standard background derivatives without making callers duplicate the editor defaults.
export function prepareRecordingMedia(recordingId: string, force = false): Promise<MediaJob> {
  return prepareMedia({
    recordingId,
    proxyHeight: 540,
    thumbnailIntervalSec: 5,
    force,
  })
}

export async function cancelMediaJob(jobId: string): Promise<void> {
  return invokeValidated<void>("cancel_media_job", { jobId })
}

export async function getMediaJob(jobId: string): Promise<MediaJob> {
  return invokeValidated("get_media_job", { jobId }, mediaJobSchema)
}

export async function listMediaJobs(recordingId: string): Promise<MediaJob[]> {
  return invokeValidated("list_media_jobs", { recordingId }, mediaJobSchema.array())
}

export async function getMediaMetadata(recordingId: string): Promise<MediaMetadata | null> {
  return invokeValidated("get_media_metadata", { recordingId }, mediaMetadataSchema.nullable())
}

export async function deleteDerivatives(recordingId: string): Promise<void> {
  return invokeValidated<void>("delete_derivatives", { recordingId })
}

export async function estimatePrepareDiskSpace(
  recordingId: string,
  options?: { proxyHeight?: number; thumbnailIntervalSec?: number },
): Promise<DiskSpaceEstimate> {
  return invokeValidated(
    "estimate_prepare_disk_space",
    {
      recordingId,
      proxyHeight: options?.proxyHeight,
      thumbnailIntervalSec: options?.thumbnailIntervalSec,
    },
    diskSpaceEstimateSchema,
  )
}

export function onMediaJobUpdate(callback: (job: MediaJob) => void): Promise<() => void> {
  return listen<unknown>("media-job-update", (event) => {
    const parsed = mediaJobSchema.safeParse(event.payload)
    if (parsed.success) callback(parsed.data)
  })
}
