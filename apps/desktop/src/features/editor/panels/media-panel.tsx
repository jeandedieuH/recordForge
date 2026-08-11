import type { LibraryRecording, MediaMetadata, TimelineState } from "@recordforge/contracts"
import { Library, Monitor } from "lucide-react"
import { EmptyState, Skeleton } from "@recordforge/ui"
import { DerivativeCard, DerivativeStatus } from "../components/derivative-status"
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
  const isReady = thumbnailResource.status === "content"

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
        <Library className="size-4 text-primary" aria-hidden />
        <h2>Media</h2>
      </div>

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
