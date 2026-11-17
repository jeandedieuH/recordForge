import type { CameraFrameAlign } from "@recordforge/contracts"
import { cn } from "@recordforge/ui"

interface AnchorGridProps {
  value: CameraFrameAlign
  onChange: (align: CameraFrameAlign) => void
}

const STEPS = [0, 0.5, 1] as const
const LABELS = ["left", "centre", "right"] as const
const ROW_LABELS = ["top", "middle", "bottom"] as const

// 3x3 alignment grid: each cell maps to align values 0 / 0.5 / 1 per axis,
// matching the free-area alignment the frame resolver uses.
export function AnchorGrid({ value, onChange }: AnchorGridProps) {
  return (
    <div
      className="grid w-24 grid-cols-3 gap-1"
      role="radiogroup"
      aria-label="Camera anchor position"
    >
      {STEPS.map((y, row) =>
        STEPS.map((x, col) => {
          const active = Math.abs(value.x - x) < 0.01 && Math.abs(value.y - y) < 0.01
          return (
            <button
              key={`${x}-${y}`}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`Anchor ${ROW_LABELS[row]} ${LABELS[col]}`}
              onClick={() => onChange({ x, y })}
              className={cn(
                "h-5 rounded-sm border transition-colors",
                active
                  ? "border-primary bg-primary"
                  : "border-border bg-surface-dim hover:bg-surface-hover",
              )}
            />
          )
        }),
      )}
    </div>
  )
}
