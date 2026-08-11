import { CheckCircle2, AlertCircle } from "lucide-react"
import { Badge, Button, Skeleton } from "@recordforge/ui"

interface DerivativeStatusProps {
  label: string
  status: "loading" | "missing" | "content" | "error"
  onRetry?: () => void
}

export function DerivativeStatus({ label, status, onRetry }: DerivativeStatusProps) {
  if (status === "loading") {
    return (
      <Skeleton className="h-6 w-24 rounded-full" aria-label={`Loading ${label.toLowerCase()}`} />
    )
  }
  if (status === "error") {
    return (
      <Button variant="ghost" size="sm" className="h-6 text-[10px] text-warning" onClick={onRetry}>
        <AlertCircle data-icon="inline-start" />
        Retry {label.toLowerCase()}
      </Button>
    )
  }
  if (status === "missing") {
    return (
      <span className="text-[10px] text-subtle-foreground">
        No {label.toLowerCase()} derivative
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-1 text-[10px] text-success">
      <CheckCircle2 className="size-3" aria-hidden />
      {label} ready
    </span>
  )
}

interface DerivativeCardProps {
  label: string
  resource: { status: "loading" | "missing" | "content" | "error"; message?: string }
  onRetry?: () => void
  onEmpty?: () => void
}

export function DerivativeCard({ label, resource, onRetry, onEmpty }: DerivativeCardProps) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{label}</span>
        {resource.status === "content" ? <Badge variant="success">Ready</Badge> : null}
      </div>
      {resource.status === "loading" ? <Skeleton className="h-5 w-full" /> : null}
      {resource.status === "missing" ? (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            Not prepared for this recording.
          </p>
          {onEmpty ? (
            <Button variant="ghost" size="sm" onClick={onEmpty}>
              Return to library
            </Button>
          ) : null}
        </div>
      ) : null}
      {resource.status === "error" ? (
        <div className="flex items-center justify-between gap-2 text-[11px] text-warning">
          <span>Derivative unavailable.</span>
          {onRetry ? (
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
