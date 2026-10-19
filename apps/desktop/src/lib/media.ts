import { listen } from "@tauri-apps/api/event"
import {
  diskSpaceEstimateSchema,
  keystrokeEventsResponseSchema,
  mediaJobSchema,
  mediaMetadataSchema,
  renderPlanSchema,
  silenceRangeSchema,
  silenceScanResultSchema,
  type DiskSpaceEstimate,
  type KeystrokeEventsResponse,
  type MediaJob,
  type MediaMetadata,
  type PrepareMediaOptions,
  type RenderPlan,
  type SilenceRange,
  type SilenceScanResult,
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
    includeProxy: false,
    force,
  })
}

// Ask Rust to build the lightweight performance-preview proxy on demand.
// Prepare dedupe keeps repeated calls cheap: it reuses a queued proxy job or a
// completed job whose proxy file is still on disk.
export function requestPreviewProxy(recordingId: string): Promise<MediaJob> {
  return prepareMedia({
    recordingId,
    proxyHeight: 540,
    thumbnailIntervalSec: 5,
    includeProxy: true,
    force: false,
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
  options?: { proxyHeight?: number; thumbnailIntervalSec?: number; includeProxy?: boolean },
): Promise<DiskSpaceEstimate> {
  return invokeValidated(
    "estimate_prepare_disk_space",
    {
      recordingId,
      proxyHeight: options?.proxyHeight,
      thumbnailIntervalSec: options?.thumbnailIntervalSec,
      includeProxy: options?.includeProxy,
    },
    diskSpaceEstimateSchema,
  )
}

// Smart Cut (Pro): scan the recording's audio for silence ranges the editor
// can ripple-delete in one command.
export async function detectSilences(
  recordingId: string,
  options?: { thresholdDb?: number; minDurationMs?: number },
): Promise<SilenceRange[]> {
  return invokeValidated(
    "detect_silences",
    {
      recordingId,
      thresholdDb: options?.thresholdDb,
      minDurationMs: options?.minDurationMs,
    },
    silenceRangeSchema.array(),
  )
}

// Smart Cut (Pro): analyze the CURRENT edited timeline's mixed audio through
// the export audio graph — trims, moves, speed changes, mutes, and imported
// audio are all honored. Returned ranges are output-timeline milliseconds,
// the same coordinates a ripple-delete command consumes. `thresholdDb` left
// null selects the adaptive RMS calibration; a number is the manual floor.
export async function detectTimelineSilences(
  recordingId: string,
  scanId: string,
  options: { plan: RenderPlan; thresholdDb?: number | null; minDurationMs?: number },
): Promise<SilenceScanResult> {
  // Validate the plan client-side so malformed editor state fails before IPC.
  const plan = renderPlanSchema.parse(options.plan)
  return invokeValidated(
    "detect_timeline_silences",
    {
      recordingId,
      scanId,
      plan,
      thresholdDb: options.thresholdDb ?? null,
      minDurationMs: options.minDurationMs,
    },
    silenceScanResultSchema,
  )
}

// Stop an in-flight Smart Cut scan identified by its per-run scan id; a
// no-op when that run is no longer registered, so unmount/edit cleanup can
// call it unconditionally without touching a newer run's job.
export async function cancelSmartCut(recordingId: string, scanId: string): Promise<void> {
  return invokeValidated<void>("cancel_smart_cut", { recordingId, scanId })
}

// Keystroke badge events saved with the recording — source-media
// timestamps and safe canonical labels ("Ctrl+C"). `supported` reports
// platform capability (Windows/macOS only).
export async function getKeystrokeEvents(recordingId: string): Promise<KeystrokeEventsResponse> {
  return invokeValidated("get_keystroke_events", { recordingId }, keystrokeEventsResponseSchema)
}

export function onMediaJobUpdate(callback: (job: MediaJob) => void): Promise<() => void> {
  return listen<unknown>("media-job-update", (event) => {
    const parsed = mediaJobSchema.safeParse(event.payload)
    if (parsed.success) callback(parsed.data)
  })
}
