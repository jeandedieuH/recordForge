import { memo } from "react"
import { useSmartCutStore } from "../../../stores/smart-cut-store"

interface SilencePreviewLayerProps {
  pixelsPerMs: number
  /** Offset of the sticky ruler lane — bands start below it. */
  top: number
}

/**
 * Descript-style preview of a Smart Cut review: every detected dead-air range
 * is shaded across all lanes so users see exactly what will be removed.
 * Excluded ranges stay outlined but translucent. Non-interactive — clicks fall
 * through to the lanes so scrubbing still works while reviewing.
 */
export const SilencePreviewLayer = memo(function SilencePreviewLayer({
  pixelsPerMs,
  top,
}: SilencePreviewLayerProps) {
  const review = useSmartCutStore((state) => state.review)
  if (!review || review.ranges.length === 0) return null

  const excluded = new Set(review.excludedIds)
  return (
    <div className="pointer-events-none absolute inset-x-0 z-10" style={{ top, bottom: 0 }}>
      {review.ranges.map((range) => {
        const left = range.startMs * pixelsPerMs
        const width = Math.max(2, (range.endMs - range.startMs) * pixelsPerMs)
        const isExcluded = excluded.has(range.id)
        return (
          <div
            key={range.id}
            aria-hidden
            className={
              isExcluded
                ? "absolute inset-y-0 border-x border-dashed border-recording/20 bg-recording/5"
                : "absolute inset-y-0 border-x border-recording/35 bg-recording/10"
            }
            style={{ left, width }}
          >
            {!isExcluded && width > 18 ? (
              <span className="absolute left-1/2 top-1 -translate-x-1/2 rounded bg-recording/80 px-1 py-px font-mono text-[8px] font-bold leading-none text-white">
                CUT
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
})
