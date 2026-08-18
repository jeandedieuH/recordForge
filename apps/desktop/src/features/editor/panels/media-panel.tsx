import { useState } from "react"
import type { LibraryRecording, MediaMetadata, TimelineState } from "@recordforge/contracts"
import { Monitor } from "lucide-react"
import { EmptyState, Skeleton, Tabs, TabsList, TabsTrigger } from "@recordforge/ui"
import { DerivativeCard, DerivativeStatus } from "../components/derivative-status"
import { ProjectAssetsPanel } from "./project-assets-panel"
import { useTimelineStore } from "../../../stores/timeline-store"
import type {
  DerivativeResource,
  ThumbnailManifest,
  WaveformResources,
} from "../media/derivative-resources"

interface MediaPanelProps {
  timeline: TimelineState | null
  recording: LibraryRecording | null
  metadata: MediaMetadata | null
  thumbnailResource: DerivativeResource<ThumbnailManifest> & { retry: () => void }
  waveformResources: WaveformResources
}

export function MediaPanel({
  timeline,
  recording,
  metadata,
  thumbnailResource,
  waveformResources,
}: MediaPanelProps) {
  const [tab, setTab] = useState<"project" | "assets">("project")
  const isLoading = useTimelineStore((state) => state.isLoading)
  const isReady = thumbnailResource.status === "content"

  if (isLoading) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-surface">
        <div className="border-b border-border p-3 pb-2">
          <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="w-full">
            <TabsList className="grid w-full grid-cols-2 h-7 bg-surface-dim p-0.5">
              <TabsTrigger value="project" className="text-xs py-0 h-6">
                Source
              </TabsTrigger>
              <TabsTrigger value="assets" className="text-xs py-0 h-6">
                Assets
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
          {/* Source metadata skeleton */}
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-12 rounded" />
              <Skeleton className="h-3 w-28 rounded" />
            </div>
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-16 rounded" />
              <Skeleton className="h-3 w-20 rounded" />
            </div>
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-14 rounded" />
              <Skeleton className="h-3 w-16 rounded" />
            </div>
          </div>

          {/* Canvas info grid skeleton */}
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-dim p-2 text-xs">
            <div className="flex flex-col gap-1">
              <Skeleton className="h-2.5 w-10 rounded" />
              <Skeleton className="h-3 w-16 rounded" />
            </div>
            <div className="flex flex-col gap-1">
              <Skeleton className="h-2.5 w-10 rounded" />
              <Skeleton className="h-3 w-16 rounded" />
            </div>
            <div className="flex flex-col gap-1">
              <Skeleton className="h-2.5 w-16 rounded" />
              <Skeleton className="h-3 w-12 rounded" />
            </div>
            <div className="flex flex-col gap-1">
              <Skeleton className="h-2.5 w-12 rounded" />
              <Skeleton className="h-3 w-8 rounded" />
            </div>
          </div>

          {/* Derivative status skeleton */}
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24 rounded" />
            <div className="flex gap-2">
              <Skeleton className="h-6 w-24 rounded-full" />
              <Skeleton className="h-6 w-24 rounded-full" />
            </div>
          </div>

          {/* Derivative cards skeleton */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-20 rounded" />
                <Skeleton className="h-3 w-14 rounded" />
              </div>
              <Skeleton className="h-2 w-full rounded" />
            </div>
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-24 rounded" />
                <Skeleton className="h-3 w-14 rounded" />
              </div>
              <Skeleton className="h-2 w-full rounded" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface">
      <div className="border-b border-border p-3 pb-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="w-full">
          <TabsList className="grid w-full grid-cols-2 h-7 bg-surface-dim p-0.5">
            <TabsTrigger value="project" className="text-xs py-0 h-6">
              Source
            </TabsTrigger>
            <TabsTrigger value="assets" className="text-xs py-0 h-6">
              Assets
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {tab === "assets" ? (
        <ProjectAssetsPanel />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
          {recording ? (
            <div className="flex flex-col gap-2">
              <InfoRow label="Source" value={recording.name} />
              <InfoRow
                label="Metadata"
                value={
                  metadata ? `${metadata.width ?? "—"} × ${metadata.height ?? "—"}` : "Unavailable"
                }
              />
              <InfoRow
                label="Duration"
                value={metadata ? formatMediaDuration(metadata.durationMs) : "Unavailable"}
              />
            </div>
          ) : (
            <Skeleton className="h-20 w-full" />
          )}

          {timeline ? (
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-dim p-2 text-xs">
              <InfoRow label="Width" value={`${timeline.canvas.width}px`} />
              <InfoRow label="Height" value={`${timeline.canvas.height}px`} />
              <InfoRow label="Frame rate" value={`${timeline.canvas.fps} fps`} />
              <InfoRow label="Tracks" value={String(timeline.tracks.length)} />
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-foreground">Derivative status</span>
            <div className="flex flex-wrap gap-2">
              <DerivativeStatus
                label="Thumbnails"
                status={isReady ? "content" : thumbnailResource.status}
                onRetry={thumbnailResource.retry}
              />
              <DerivativeStatus
                label="Waveform"
                status={waveformResources.status}
                onRetry={waveformResources.retry}
              />
            </div>
          </div>

          <DerivativeCard
            label="Thumbnails"
            resource={thumbnailResource}
            onRetry={thumbnailResource.retry}
          />
          <DerivativeCard
            label="Waveform peaks"
            resource={{ status: waveformResources.status }}
            onRetry={waveformResources.retry}
          />

          {!recording ? (
            <EmptyState
              icon={Monitor}
              title="No media loaded"
              description="Open a recording from the library to prepare its derivatives."
              className="mt-auto border border-dashed border-border bg-surface-dim p-4"
            />
          ) : null}
        </div>
      )}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-subtle-foreground">{label}</span>
      <span className="max-w-40 truncate font-mono tabular-nums text-foreground" title={value}>
        {value}
      </span>
    </div>
  )
}

function formatMediaDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}
