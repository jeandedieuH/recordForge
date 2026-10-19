import { useState } from "react"
import { ChevronLeft, ChevronRight, Play } from "lucide-react"
import type { SmartCutRange } from "@recordforge/editor-core"
import { Button, IconButton } from "@recordforge/ui"
import { formatSilenceClock, type SmartCutResult } from "./smart-cut-model"
import { formatDuration } from "../../../lib/format"

// Review lists stay paged rather than height-capped — every detected pause
// remains individually reviewable, with selection tracked by absolute index
// across pages.
export const SMART_CUT_PAGE_SIZE = 60

interface SmartCutReviewProps {
  result: SmartCutResult
  ranges: SmartCutRange[]
  selected: ReadonlySet<number>
  onToggle: (index: number, checked: boolean) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  onPreview: (range: SmartCutRange) => void
}

export function SmartCutReview({
  result,
  ranges,
  selected,
  onToggle,
  onSelectAll,
  onDeselectAll,
  onPreview,
}: SmartCutReviewProps) {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(ranges.length / SMART_CUT_PAGE_SIZE))
  const clampedPage = Math.min(page, pageCount - 1)
  const pageStart = clampedPage * SMART_CUT_PAGE_SIZE
  const visible = ranges.slice(pageStart, pageStart + SMART_CUT_PAGE_SIZE)
  const removedMs = ranges.reduce(
    (total, range, index) => (selected.has(index) ? total + (range.endMs - range.startMs) : total),
    0,
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-ui-caption">
        <span className="font-medium text-foreground">
          {ranges.length} pause{ranges.length === 1 ? "" : "s"} found
        </span>
        <div className="flex gap-2">
          <button type="button" className="text-primary hover:underline" onClick={onSelectAll}>
            Select all
          </button>
          <button
            type="button"
            className="text-subtle-foreground hover:underline"
            onClick={onDeselectAll}
          >
            Deselect all
          </button>
        </div>
      </div>
      <div className="max-h-44 overflow-y-auto rounded border border-border/60 bg-surface-dim p-2">
        <ul className="flex flex-col gap-1">
          {visible.map((range, offset) => {
            const index = pageStart + offset
            return (
              <li key={`${range.startMs}-${range.endMs}`} className="flex items-center gap-2">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-ui-caption text-subtle-foreground">
                  <input
                    type="checkbox"
                    checked={selected.has(index)}
                    onChange={(event) => onToggle(index, event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-border"
                    aria-label={`Include pause ${index + 1}`}
                  />
                  <span className="font-mono">
                    {formatSilenceClock(range.startMs)} → {formatSilenceClock(range.endMs)}
                  </span>
                  <span className="shrink-0">{formatDuration(range.endMs - range.startMs)}</span>
                </label>
                <IconButton
                  label="Preview pause"
                  size="sm"
                  variant="ghost"
                  onClick={() => onPreview(range)}
                >
                  <Play className="size-3.5" aria-hidden />
                </IconButton>
              </li>
            )
          })}
        </ul>
      </div>
      {pageCount > 1 ? (
        <div className="flex items-center justify-between text-ui-caption text-subtle-foreground">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            disabled={clampedPage === 0}
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            Prev
          </Button>
          <span>
            {pageStart + 1}–{Math.min(pageStart + SMART_CUT_PAGE_SIZE, ranges.length)} of{" "}
            {ranges.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            disabled={clampedPage >= pageCount - 1}
          >
            Next
            <ChevronRight className="size-3.5" aria-hidden />
          </Button>
        </div>
      ) : null}
      <p className="text-ui-caption text-subtle-foreground">
        {selected.size} selected · saves {formatDuration(removedMs)} · new length{" "}
        {formatDuration(Math.max(0, result.durationMs - removedMs))}
      </p>
    </div>
  )
}
