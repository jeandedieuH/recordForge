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
  WandSparkles,
  ZoomIn,
} from "lucide-react"
import type { EditorTask } from "./task-rail"
import { ActivePanelErrorBoundary } from "./active-panel-error-boundary"
import { MediaPanel } from "../panels/media-panel"
import { TitlesPanel } from "../panels/titles-panel"
import { AnnotationsPanel } from "../panels/annotations-panel"
import type { AnnotationDrawSettings } from "../annotations/annotation-tools"
import { EmptyState } from "@recordforge/ui"
import { isCameraRecording } from "../../../lib/library"
import { FocusPanel } from "../panels/focus-panel"
import { CursorPanel } from "../panels/cursor-panel"
import { CaptionsPanel } from "../panels/captions-panel"
import { LayoutPanel } from "../panels/layout-panel"
import { AudioPanel } from "../panels/audio-panel"
import { PrivacyPanel } from "../panels/privacy-panel"
import { FinishingPanel } from "../finishing/finishing-panel"
import { ExportPanel } from "../panels/export-panel"
import type {
  DerivativeResource,
  ThumbnailManifest,
  WaveformResources,
} from "../media/derivative-resources"
import type { LibraryRecording, MediaMetadata, TimelineState } from "@recordforge/contracts"

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
  finish: WandSparkles,
  export: FileOutput,
}

interface ActivePanelProps {
  activeTask: EditorTask
  timeline: TimelineState | null
  recording: LibraryRecording | null
  metadata: MediaMetadata | null
  thumbnailResource: DerivativeResource<ThumbnailManifest> & { retry: () => void }
  waveformResources: WaveformResources
  drawMode: boolean
  drawSettings: AnnotationDrawSettings
  onDrawSettingsChange: (settings: AnnotationDrawSettings) => void
  onToggleDrawMode: (enabled: boolean) => void
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
  drawSettings,
  onDrawSettingsChange,
  onToggleDrawMode,
  onOpenExport,
}: ActivePanelProps) {
  function renderContent() {
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
        return (
          <AnnotationsPanel
            drawMode={drawMode}
            drawSettings={drawSettings}
            onDrawSettingsChange={onDrawSettingsChange}
            onToggleDrawMode={onToggleDrawMode}
          />
        )
      case "focus":
        return <FocusPanel />
      case "cursor":
        // The task is already hidden from the rail for camera recordings;
        // this guard covers a "cursor" selection persisted from an earlier
        // screen-recording session.
        if (isCameraRecording(recording)) {
          return (
            <EmptyState
              icon={MousePointer2}
              title="No cursor data"
              description="Camera recordings don't capture cursor telemetry, so there are no cursor effects to adjust. This panel is only useful for screen recordings."
              className="m-3 border border-dashed border-border bg-surface-dim p-4"
            />
          )
        }
        return <CursorPanel />
      case "captions":
        return <CaptionsPanel />
      case "layout":
        return <LayoutPanel />
      case "audio":
        return <AudioPanel />
      case "privacy":
        return <PrivacyPanel />
      case "finish":
        return <FinishingPanel />
      case "export":
        return <ExportPanel onOpenExport={onOpenExport} />
      default:
        return null
    }
  }

  return (
    <ActivePanelErrorBoundary resetKey={activeTask} panelName={activeTask}>
      {renderContent()}
    </ActivePanelErrorBoundary>
  )
}
