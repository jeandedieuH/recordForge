import type { CanvasAspectRatio } from "@recordforge/contracts"
import {
  canvasSizeForAspectRatio,
  CANVAS_RESOLUTION_TIERS,
  type CanvasResolutionTier,
} from "@recordforge/editor-core"
import { cn } from "@recordforge/ui"
import { ProBadge } from "../../../licensing/pro-badge"

interface ResolutionSelectorProps {
  value: CanvasResolutionTier
  /** Used to show the exact pixel size each tier produces. */
  aspectRatio: CanvasAspectRatio
  onChange: (tier: CanvasResolutionTier) => void
  /**
   * Free tier marks 1440p/2160p as Pro. When provided, gated options show a
   * PRO badge and clicking them calls `onProSelect` instead of `onChange`.
   */
  proValues?: CanvasResolutionTier[]
  onProSelect?: (tier: CanvasResolutionTier) => void
}

/** Segmented canvas-output resolution picker (1080p / 1440p / 2160p). */
export function ResolutionSelector({
  value,
  aspectRatio,
  onChange,
  proValues = [],
  onProSelect,
}: ResolutionSelectorProps) {
  return (
    <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Canvas resolution">
      {CANVAS_RESOLUTION_TIERS.map((tier) => {
        const isSelected = value === tier
        const isProGated = proValues.includes(tier)
        const size = canvasSizeForAspectRatio(aspectRatio, undefined, tier)

        return (
          <button
            key={tier}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => (isProGated ? onProSelect?.(tier) : onChange(tier))}
            className={cn(
              "group flex flex-col items-center gap-0.5 rounded-lg border px-2 py-1.5 transition-all",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              isSelected
                ? "border-primary/80 bg-primary/10 text-foreground shadow-xs"
                : "border-border bg-surface-dim/70 text-subtle-foreground hover:border-border-hover hover:bg-surface hover:text-foreground",
            )}
          >
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  "font-mono text-[11px] font-semibold",
                  isSelected ? "text-primary" : "text-foreground",
                )}
              >
                {tier}
              </span>
              {isProGated ? <ProBadge /> : null}
            </span>
            <span className="font-mono text-[9px] text-muted-foreground">
              {size.width}×{size.height}
            </span>
          </button>
        )
      })}
    </div>
  )
}
