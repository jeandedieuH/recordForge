import {
  exportTimelineOptionsSchema,
  mediaJobSchema,
  type ExportTimelineOptions,
  type MediaJob,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export async function exportTimeline(options: ExportTimelineOptions): Promise<MediaJob> {
  return invokeValidated(
    "export_timeline",
    { options: exportTimelineOptionsSchema.parse(options) },
    mediaJobSchema,
  )
}

export async function retryExport(jobId: string): Promise<MediaJob> {
  return invokeValidated("retry_export", { jobId }, mediaJobSchema)
}

export async function revealExport(jobId: string): Promise<void> {
  return invokeValidated<void>("reveal_export", { jobId })
}
