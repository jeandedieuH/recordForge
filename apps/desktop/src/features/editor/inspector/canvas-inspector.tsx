import { Monitor, MousePointer2 } from "lucide-react"
import { Button, EmptyState, Skeleton } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { InfoField } from "./fields"

export function CanvasInspector() {
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const isLoading = useTimelineStore((state) => state.isLoading)
  const recording = useTimelineStore((state) => state.recording)
  const setSelection = useTimelineStore((state) => state.setSelection)

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 border-b border-border pb-3">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="h-4 w-28 rounded" />
        </div>

        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div
              key={idx}
              className="flex flex-col gap-1 rounded-md border border-border/80 bg-surface-dim/60 p-2 text-xs"
            >
              <Skeleton className="h-2.5 w-14 rounded" />
              <Skeleton className="h-3.5 w-20 rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!timeline) {
    return (
      <EmptyState
        icon={Monitor}
        title="No project loaded"
        description="Open a recording to see its canvas summary."
        className="border border-dashed border-border bg-surface-dim p-4"
      />
    )
  }

  const firstClip = timeline.tracks.flatMap((track) => track.clips)[0]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <Monitor className="size-4 text-primary" aria-hidden />
        <span className="text-sm font-semibold text-foreground">Project canvas</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <InfoField label="Width" value={`${timeline.canvas.width}px`} />
        <InfoField label="Height" value={`${timeline.canvas.height}px`} />
        <InfoField label="Frame rate" value={`${timeline.canvas.fps} fps`} />
        <InfoField label="Tracks" value={String(timeline.tracks.length)} />
        <InfoField
          label="Background"
          value={
            timeline.canvas.background.startsWith("linear-gradient") ||
            timeline.canvas.background.startsWith("radial-gradient")
              ? "Gradient"
              : timeline.canvas.background.startsWith("url(") ||
                  timeline.canvas.background.startsWith("/backgrounds/") ||
                  timeline.canvas.background.startsWith("data:")
                ? "Image"
                : timeline.canvas.background
          }
        />
        <InfoField label="Aspect ratio" value={timeline.canvas.aspectRatio?.toString() ?? "16:9"} />
        {timeline.canvas.aspectRatio && timeline.canvas.aspectRatio !== "16:9" ? (
          <InfoField
            label="Video Y position"
            value={`${Math.round((timeline.canvas.videoPositionY ?? 0.5) * 100)}%`}
          />
        ) : null}
        {(timeline.canvas.backgroundBlur ?? 0) > 0 ? (
          <InfoField label="Background blur" value={`${timeline.canvas.backgroundBlur}px`} />
        ) : null}
        {(timeline.canvas.backgroundDim ?? 0) > 0 ? (
          <InfoField
            label="Background dim"
            value={`${Math.round((timeline.canvas.backgroundDim ?? 0) * 100)}%`}
          />
        ) : null}
      </div>

      {recording ? (
        <div className="rounded-lg border border-border bg-surface-dim p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-subtle-foreground">Source</span>
            <span className="truncate text-right font-medium text-foreground">
              {recording.name}
            </span>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-3">
        <h3 className="text-xs font-semibold text-foreground">Suggested next action</h3>
        {firstClip ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setSelection({
                kind: "clip",
                primaryClipId: firstClip.id,
                clipIds: [firstClip.id],
                trackId: timeline.tracks.find((track) =>
                  track.clips.some((clip) => clip.id === firstClip.id),
                )?.id,
              })
            }
          >
            <MousePointer2 data-icon="inline-start" />
            Select the first clip
          </Button>
        ) : (
          <p className="text-[11px] text-subtle-foreground">
            The timeline is empty. Add a clip or import captions to begin editing.
          </p>
        )}
      </div>
    </div>
  )
}
