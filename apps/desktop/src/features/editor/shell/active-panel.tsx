import type { LucideIcon } from "lucide-react"
import {
  Captions,
  EyeOff,
  FileOutput,
  Library,
  LayoutTemplate,
  MousePointer2,
  Volume2,
  ZoomIn,
} from "lucide-react"
import type { EditorTask } from "./task-rail"
import { MediaPanel } from "../panels/media-panel"
import { FocusPanel } from "../panels/focus-panel"
import { CursorPanel } from "../panels/cursor-panel"
import { CaptionsPanel } from "../panels/captions-panel"
import { LayoutPanel } from "../panels/layout-panel"
import { AudioPanel } from "../panels/audio-panel"
import { PrivacyPanel } from "../panels/privacy-panel"
import { ExportPanel } from "../panels/export-panel"
import type {
  DerivativeResource,
  ThumbnailManifest,
  WaveformResources,
} from "../media/derivative-resources"
import type { LibraryRecording, MediaMetadata, TimelineState } from "@recordforge/contracts"

export const TASK_ICONS: Record<EditorTask, LucideIcon> = {
  media: Library,
  focus: ZoomIn,
  cursor: MousePointer2,
  captions: Captions,
  layout: LayoutTemplate,
  audio: Volume2,
  privacy: EyeOff,
  export: FileOutput,
}

interface ActivePanelProps {
  activeTask: EditorTask
  timeline: TimelineState | null
  recording: LibraryRecording | null
  metadata: MediaMetadata | null
  thumbnailResource: DerivativeResource<ThumbnailManifest> & { retry: () => void }
  waveformResources: WaveformResources
  onOpenExport?: () => void
}

export function ActivePanel({
  activeTask,
  timeline,
  recording,
  metadata,
  thumbnailResource,
  waveformResources,
  onOpenExport,
}: ActivePanelProps) {
  switch (activeTask) {
    case "media":
      return (
        <MediaPanel
          timeline={timeline}
          recording={recording}
          metadata={metadata}
          thumbnailResource={thumbnailResource}
          waveformResources={waveformResources}
        />
      )
    case "focus":
      return <FocusPanel />
    case "cursor":
      return <CursorPanel />
    case "captions":
      return <CaptionsPanel />
    case "layout":
      return <LayoutPanel />
    case "audio":
      return <AudioPanel />
    case "privacy":
      return <PrivacyPanel />
    case "export":
      return <ExportPanel onOpenExport={onOpenExport} />
    default:
      return null
  }
}
