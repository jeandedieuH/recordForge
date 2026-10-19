import {
  exportTimelineOptionsSchema,
  mediaJobSchema,
  previewTimelineOptionsSchema,
  type ExportTimelineOptions,
  type MediaJob,
  type PreviewTimelineOptions,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export async function exportTimeline(options: ExportTimelineOptions): Promise<MediaJob> {
  return invokeValidated(
    "export_timeline",
    { options: exportTimelineOptionsSchema.parse(options) },
    mediaJobSchema,
  )
}

// Processed preview: renders the current plan through the real export
// pipeline into a job-owned file under the recording's work dir. The job
// carries options.preview=true so the exports listener can route it away
// from export/share state.
export async function previewTimeline(options: PreviewTimelineOptions): Promise<MediaJob> {
  return invokeValidated(
    "preview_timeline",
    { options: previewTimelineOptionsSchema.parse(options) },
    mediaJobSchema,
  )
}

export async function retryExport(jobId: string): Promise<MediaJob> {
  return invokeValidated("retry_export", { jobId }, mediaJobSchema)
}

export async function revealExport(jobId: string): Promise<void> {
  return invokeValidated<void>("reveal_export", { jobId })
}
