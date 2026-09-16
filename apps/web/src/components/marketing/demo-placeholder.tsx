import { Clapperboard } from "lucide-react"
import { cn } from "@recordforge/ui"

interface DemoPlaceholderProps {
  /** Short description of the clip this slot will eventually play. */
  label: string
  /** URL of the real demo GIF/video — renders media instead of the placeholder when provided. */
  src?: string
  className?: string
  /** Tailwind aspect class for the media frame (defaults to 16:9). */
  aspectClass?: string
}

/**
 * Slot for product demo GIFs. Until a real clip exists it renders a styled
 * stand-in (grid backdrop, shimmer sweep, dashed bezel); passing `src` swaps
 * in the media with no layout changes.
 */
export function DemoPlaceholder({
  label,
  src,
  className,
  aspectClass = "aspect-video",
}: DemoPlaceholderProps) {
  return (
    <div className={cn("rounded-2xl border border-border bg-surface-dim p-1.5", className)}>
      <div
        className={cn(
          "relative overflow-hidden rounded-xl border border-dashed border-border-strong/70 bg-surface",
          aspectClass,
        )}
      >
        {src ? (
          <img src={src} alt={label} className="absolute inset-0 size-full object-cover" />
        ) : (
          <>
            <div className="demo-grid absolute inset-0" aria-hidden />
            <div
              className="demo-shimmer absolute inset-y-0 w-1/2 bg-linear-to-r from-transparent via-overlay/50 to-transparent"
              aria-hidden
            />
            <div className="relative flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="flex size-11 items-center justify-center rounded-full border border-dashed border-border-strong bg-elevated">
                <Clapperboard className="size-5 text-muted-foreground" aria-hidden />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="mt-1 text-xs text-subtle-foreground">Demo clip coming soon</p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
