import type { LucideIcon } from "lucide-react"
import {
  Captions,
  EyeOff,
  FileOutput,
  Library,
  LayoutTemplate,
  MousePointer2,
  Shapes,
  Type,
  Volume2,
  ZoomIn,
} from "lucide-react"
import type { EditorTask } from "./task-rail"
import { MediaPanel } from "../panels/media-panel"
import { TitlesPanel } from "../panels/titles-panel"
import { AnnotationsPanel } from "../panels/annotations-panel"
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
import type {
  AnnotationType,
  LibraryRecording,
  MediaMetadata,
  TimelineState,
} from "@recordforge/contracts"

export const TASK_ICONS: Record<EditorTask, LucideIcon> = {
  media: Library,
  titles: Type,
  annotations: Shapes,
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
  drawMode?: boolean
  onToggleDrawMode?: (enabled: boolean, type: AnnotationType, color: string) => void
  onOpenExport?: () => void
}

export function ActivePanel({
  activeTask,
  timeline,
  recording,
  metadata,
  thumbnailResource,
  waveformResources,
  drawMode,
  onToggleDrawMode,
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
    case "titles":
      return <TitlesPanel />
    case "annotations":
      return <AnnotationsPanel drawMode={drawMode} onToggleDrawMode={onToggleDrawMode} />
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
