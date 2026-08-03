import { cn } from "../../lib/cn"

interface AudioLevelMeterProps {
  /** 0–1 live input level (from the Rust `audio-level` event). */
  level: number
  segments?: number
  orientation?: "horizontal" | "vertical"
  className?: string
}

/**
 * Segmented live meter used by the floating pill, recorder home, and device
 * tests. Segments color-shift emerald → amber → red toward clipping.
 */
function AudioLevelMeter({
  level,
  segments = 16,
  orientation = "horizontal",
  className,
}: AudioLevelMeterProps) {
  const clamped = Math.min(1, Math.max(0, level))
  const active = Math.round(clamped * segments)

  return (
    <div
      role="meter"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Audio level"
      className={cn(
        "flex gap-0.5",
        orientation === "horizontal" ? "h-3 items-end" : "w-3 flex-col-reverse",
        className,
      )}
    >
      {Array.from({ length: segments }, (_, i) => {
        const lit = i < active
        const ratio = (i + 1) / segments
        const color = ratio > 0.85 ? "bg-recording" : ratio > 0.65 ? "bg-warning" : "bg-success"
        return (
          <span
            key={i}
            className={cn(
              "rounded-[1px] transition-colors duration-fast",
              orientation === "horizontal" ? "w-1" : "h-1 w-full",
              lit ? color : "bg-overlay",
            )}
            style={orientation === "horizontal" ? { height: `${30 + ratio * 70}%` } : undefined}
          />
        )
      })}
    </div>
  )
}

export { AudioLevelMeter }
export type { AudioLevelMeterProps }
