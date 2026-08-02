import { invoke } from "@tauri-apps/api/core"
import type { ExportTimelineOptions, MediaJob } from "@recordforge/contracts"

export async function exportTimeline(options: ExportTimelineOptions): Promise<MediaJob> {
  return invoke("export_timeline", { options })
}
