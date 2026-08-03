import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "../../lib/cn"

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  /** Primary call-to-action (usually a Button). */
  action?: ReactNode
  /** Secondary affordance rendered under the primary action. */
  secondaryAction?: ReactNode
  className?: string
}

/** Standard empty surface: icon + headline + body + CTA (Forge UI four-states rule). */
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong px-6 py-12 text-center",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-overlay">
        <Icon className="size-6 text-subtle-foreground" aria-hidden />
      </div>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
      {secondaryAction ? <div className="text-sm">{secondaryAction}</div> : null}
    </div>
  )
}

export { EmptyState }
export type { EmptyStateProps }
