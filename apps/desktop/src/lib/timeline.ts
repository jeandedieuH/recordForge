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
