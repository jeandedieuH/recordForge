import { memo } from "react"
import { ScrollArea, Switch } from "@recordforge/ui"
import { VolumeX } from "lucide-react"
import type { SmartCutReviewRange } from "../../../../stores/smart-cut-store"

function formatTimecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const millis = Math.floor((ms % 1000) / 10)
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(2, "0")}`
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000
  return seconds >= 10 ? `${seconds.toFixed(1)} s` : `${seconds.toFixed(2)} s`
}

interface SilenceRangeListProps {
  ranges: SmartCutReviewRange[]
  excludedIds: string[]
  onToggle: (id: string) => void
  onToggleAll: (excluded: boolean) => void
  /** Seeks a little before the cut so the user hears the transition point. */
  onSeek: (ms: number) => void
}

export const SilenceRangeList = memo(function SilenceRangeList({
  ranges,
  excludedIds,
  onToggle,
  onToggleAll,
  onSeek,
}: SilenceRangeListProps) {
  const excluded = new Set(excludedIds)
  const allExcluded = excluded.size === ranges.length

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-subtle-foreground">
          Silences to cut
        </span>
        <button
          type="button"
          onClick={() => onToggleAll(!allExcluded)}
          className="cursor-pointer text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {allExcluded ? "Include all" : "Exclude all"}
        </button>
      </div>
      <ScrollArea className="max-h-52 w-full">
        <ul className="flex flex-col gap-1 pr-1">
          {ranges.map((range, index) => {
            const isExcluded = excluded.has(range.id)
            const durationMs = range.endMs - range.startMs
            return (
              <li key={range.id}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Preview silence at ${formatTimecode(range.startMs)}`}
                  onClick={() => onSeek(Math.max(0, range.startMs - 300))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      onSeek(Math.max(0, range.startMs - 300))
                    }
                  }}
                  className={`group/item flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                    isExcluded
                      ? "border-border/60 bg-surface/40 opacity-55"
                      : "border-border/70 bg-surface/80 hover:border-border-strong hover:bg-surface"
                  }`}
                >
                  <VolumeX
                    className={`size-3.5 shrink-0 ${isExcluded ? "text-subtle-foreground" : "text-recording"}`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-[11px] font-semibold tabular-nums text-foreground">
                      {formatTimecode(range.startMs)}
                      <span className="text-muted-foreground"> → </span>
                      {formatTimecode(range.endMs)}
                    </span>
                    <span className="ml-1.5 text-[10px] text-muted-foreground">
                      {formatDuration(durationMs)}
                    </span>
                  </span>
                  <Switch
                    className="h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
                    checked={!isExcluded}
                    aria-label={`Include silence ${index + 1} in the cut`}
                    onCheckedChange={() => onToggle(range.id)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      </ScrollArea>
      <p className="px-0.5 text-[10px] leading-relaxed text-subtle-foreground">
        Click a silence to preview it — excluded ones stay in the timeline.
      </p>
    </div>
  )
})
