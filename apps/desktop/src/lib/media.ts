import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type {
  DiskSpaceEstimate,
  MediaJob,
  MediaMetadata,
  PrepareMediaOptions,
} from "@recordforge/contracts"

export async function prepareMedia(options: PrepareMediaOptions): Promise<MediaJob> {
  return invoke("prepare_media", { options })
}

export async function cancelMediaJob(jobId: string): Promise<void> {
  return invoke("cancel_media_job", { jobId })
}

export async function getMediaJob(jobId: string): Promise<MediaJob> {
  return invoke("get_media_job", { jobId })
}

export async function listMediaJobs(recordingId: string): Promise<MediaJob[]> {
  return invoke("list_media_jobs", { recordingId })
}

export async function getMediaMetadata(recordingId: string): Promise<MediaMetadata | null> {
  return invoke("get_media_metadata", { recordingId })
}

export async function estimatePrepareDiskSpace(
  recordingId: string,
  options?: { proxyHeight?: number; thumbnailIntervalSec?: number },
): Promise<DiskSpaceEstimate> {
  return invoke("estimate_prepare_disk_space", {
    recordingId,
    proxyHeight: options?.proxyHeight,
    thumbnailIntervalSec: options?.thumbnailIntervalSec,
  })
}

export function onMediaJobUpdate(callback: (job: MediaJob) => void): Promise<() => void> {
  return listen<MediaJob>("media-job-update", (event) => {
    callback(event.payload)
  })
}
