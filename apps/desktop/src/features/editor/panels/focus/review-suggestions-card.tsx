import { memo, useState } from "react"
import type { ManualZoomSegment } from "@recordforge/contracts"
import { zoomSegmentBadges } from "@recordforge/cursor-core"
import { Check, Sparkles, X, ZoomIn } from "lucide-react"
import { Badge, Button, IconButton, ScrollArea } from "@recordforge/ui"
import { MiniFocusThumbnail } from "./mini-focus-thumbnail"

interface ReviewSuggestionsCardProps {
  suggestions: ManualZoomSegment[]
  canvas: { width: number; height: number }
  onAccept: (selectedSegments: ManualZoomSegment[]) => void
  onReject: () => void
}

function badgeVariant(
  variant: "default" | "secondary" | "outline" | "warning",
): "default" | "accent" | "outline" | "warning" {
  if (variant === "secondary") return "outline"
  if (variant === "default") return "accent"
  return variant
}

function formatTimecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const millis = Math.floor((ms % 1000) / 10)
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(2, "0")}`
}

function formatDuration(ms: number): string {
  const sec = ms / 1000
  return `${sec.toFixed(2)}s`
}

export const ReviewSuggestionsCard = memo(function ReviewSuggestionsCard({
  suggestions: initialSuggestions,
  canvas,
  onAccept,
  onReject,
}: ReviewSuggestionsCardProps) {
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set())

  const activeSuggestions = initialSuggestions.filter(
    (segment) => !excludedIds.has(segment.id),
  )

  function toggleExclude(segmentId: string) {
    setExcludedIds((prev) => {
      const next = new Set(prev)
      if (next.has(segmentId)) {
        next.delete(segmentId)
      } else {
        next.add(segmentId)
      }
      return next
    })
  }

  function handleAcceptAll() {
    onAccept(activeSuggestions)
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-primary/40 bg-primary/5 p-3 shadow-xs">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <Sparkles className="size-4 shrink-0 text-purple-400" aria-hidden />
          <span className="text-xs font-semibold text-foreground truncate">
            Smart Suggestions ({activeSuggestions.length})
          </span>
        </div>

        <IconButton
          label="Cancel review"
          size="sm"
          variant="ghost"
          className="size-6 text-muted-foreground hover:text-foreground"
          onClick={onReject}
        >
          <X className="size-3.5" aria-hidden />
        </IconButton>
      </div>

      <p className="text-[10px] leading-relaxed text-subtle-foreground">
        Generated from cursor telemetry. Exclude any items below, then accept to apply.
      </p>

      {/* Fixed-Height Scrollable Suggestions Section */}
      <div className="rounded-lg border border-border/80 bg-surface-dim/90 overflow-hidden shadow-inner">
        <ScrollArea className="h-60 w-full p-2">
          {activeSuggestions.length === 0 ? (
            <div className="flex h-56 flex-col items-center justify-center gap-1.5 p-4 text-center">
              <span className="text-xs text-muted-foreground">All suggestions excluded</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px]"
                onClick={() => setExcludedIds(new Set())}
              >
                Reset excluded
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 pr-2">
              {activeSuggestions.map((segment) => {
                const badges = zoomSegmentBadges(segment)
                return (
                  <div
                    key={segment.id}
                    className="group/item flex flex-col gap-1.5 rounded-md border border-border/70 bg-surface/80 p-2 text-xs transition-colors hover:border-border-strong hover:bg-surface"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <div className="flex items-baseline gap-1 font-mono text-[11px] font-semibold tabular-nums text-foreground">
                        <span>{formatTimecode(segment.startMs)}</span>
                        <span className="text-muted-foreground">→</span>
                        <span>{formatTimecode(segment.startMs + segment.durationMs)}</span>
                        <span className="text-[10px] font-normal text-muted-foreground">
                          ({formatDuration(segment.durationMs)})
                        </span>
                      </div>

                      <div className="flex items-center gap-1">
                        <span className="inline-flex items-center gap-1 rounded bg-overlay px-1.5 py-0.2 font-mono text-[10px] font-semibold tabular-nums text-foreground">
                          <ZoomIn className="size-2.5 text-primary" aria-hidden />
                          {segment.scale.toFixed(1)}×
                        </span>

                        <IconButton
                          label="Exclude suggestion"
                          size="sm"
                          variant="ghost"
                          className="size-5 p-0 text-subtle-foreground hover:text-recording hover:bg-recording/10 opacity-70 group-hover/item:opacity-100"
                          onClick={() => toggleExclude(segment.id)}
                        >
                          <X className="size-3" aria-hidden />
                        </IconButton>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <MiniFocusThumbnail target={segment.target} canvas={canvas} width={38} />

                      <div className="flex flex-1 flex-wrap gap-1 min-w-0">
                        {badges.map((badge) => (
                          <Badge
                            key={badge.key}
                            variant={badgeVariant(badge.variant)}
                            className="text-[9px] px-1.5 py-0 capitalize"
                          >
                            {badge.label}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Action Footer */}
      <div className="flex items-center gap-2 pt-0.5">
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 text-xs"
          onClick={onReject}
        >
          Dismiss
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 flex-1 text-xs font-semibold"
          disabled={activeSuggestions.length === 0}
          onClick={handleAcceptAll}
        >
          <Check className="size-3.5" data-icon="inline-start" />
          <span>Accept ({activeSuggestions.length})</span>
        </Button>
      </div>
    </div>
  )
})
