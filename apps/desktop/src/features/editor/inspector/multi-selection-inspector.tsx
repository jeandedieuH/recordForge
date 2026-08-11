import { useMemo } from "react"
import type { TimelineClip } from "@recordforge/contracts"
import { createDeleteClipsCommand } from "@recordforge/editor-core"
import { Layers } from "lucide-react"
import { Button } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

interface MultiSelectionInspectorProps {
  clipIds: string[]
  onClear: () => void
}

export function MultiSelectionInspector({ clipIds, onClear }: MultiSelectionInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)

  const clips = useMemo(() => {
    if (!timeline) return [] as TimelineClip[]
    const found: TimelineClip[] = []
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clipIds.includes(clip.id)) found.push(clip)
      }
    }
    return found
  }, [timeline, clipIds])

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const clip of clips) {
      counts.set(clip.kind, (counts.get(clip.kind) ?? 0) + 1)
    }
    return counts
  }, [clips])

  const mixedKinds = kindCounts.size > 1
  const allDeletable = clips.every((clip) => clip.kind !== "cursor-effect" || !clip.locked)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Layers className="size-4 text-primary" aria-hidden />
          <span>{clipIds.length} selected</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} className="h-7 text-xs">
          Clear
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-foreground">Selection</span>
        <div className="flex flex-wrap gap-1.5">
          {Array.from(kindCounts.entries()).map(([kind, count]) => (
            <span
              key={kind}
              className="rounded-full border border-border bg-surface-dim px-2 py-0.5 text-[10px] text-foreground"
            >
              {count} × {kind}
            </span>
          ))}
        </div>
      </div>

      {mixedKinds ? (
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          Mixed selection: shared controls are limited. Select a single clip to edit kind-specific
          settings such as transform, mask, or caption style.
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          {clips[0]?.kind === "screen"
            ? "Multiple screen clips selected. Move, trim, or delete them together."
            : "All selected clips share the same type. Some controls are available for multiple items."}
        </p>
      )}

      <Button
        variant="destructive"
        size="sm"
        disabled={!allDeletable}
        onClick={() => {
          execute(createDeleteClipsCommand(clipIds))
          onClear()
        }}
      >
        Delete selection
      </Button>
    </div>
  )
}
