import type { HTMLAttributes } from "react"
import { cn } from "../../lib/cn"

interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  /** 0–1 fraction or 0–100 percentage */
  value: number
  /** Optional custom class name for the inner animated indicator bar */
  indicatorClassName?: string
}

function Progress({ value, className, indicatorClassName, ...props }: ProgressProps) {
  // Support both 0–1 fractions and 0–100 percentages seamlessly
  const normalized = value > 1 ? value : value * 100
  const clamped = Math.min(100, Math.max(0, Number.isFinite(normalized) ? normalized : 0))
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-overlay", className)}
      {...props}
    >
      <div
        className={cn(
          "h-full rounded-full bg-accent transition-[width] duration-base ease-forge",
          indicatorClassName,
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

interface StageProgressProps extends ProgressProps {
  /** Current stage label, e.g. "Rendering". */
  stage: string
  /** Human-readable ETA, e.g. "~12 s left". */
  eta?: string
}

/** Determinate progress with stage label + ETA for jobs and exports. */
function StageProgress({
  stage,
  eta,
  value,
  className,
  indicatorClassName,
  ...props
}: StageProgressProps) {
  const normalized = value > 1 ? value : value * 100
  const clamped = Math.min(100, Math.max(0, Number.isFinite(normalized) ? normalized : 0))
  return (
    <div className={cn("flex w-full flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">{stage}</span>
        <span className="tnum text-muted-foreground">
          {Math.round(clamped)}%{eta ? ` · ${eta}` : ""}
        </span>
      </div>
      <Progress value={value} indicatorClassName={indicatorClassName} {...props} />
    </div>
  )
}

export { Progress, StageProgress }
export type { ProgressProps, StageProgressProps }
