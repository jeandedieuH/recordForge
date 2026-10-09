import { Badge, cn } from "@recordforge/ui"

interface ProBadgeProps {
  className?: string
}

/** Compact "PRO" marker placed on gated controls when the tier is Free. */
export function ProBadge({ className }: ProBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "pointer-events-none shrink-0 border-warning/60 bg-warning/15 px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider text-warning",
        className,
      )}
    >
      Pro
    </Badge>
  )
}
