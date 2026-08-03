import type { HTMLAttributes } from "react"
import { cn } from "../../lib/cn"

interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  /** 0–1 */
  value: number
}

function Progress({ value, className, ...props }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value * 100))
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
        className="h-full rounded-full bg-accent transition-[width] duration-base ease-forge"
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
function StageProgress({ stage, eta, value, className, ...props }: StageProgressProps) {
  return (
    <div className={cn("flex w-full flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">{stage}</span>
        <span className="tnum text-muted-foreground">
          {Math.round(Math.min(100, Math.max(0, value * 100)))}%{eta ? ` · ${eta}` : ""}
        </span>
      </div>
      <Progress value={value} {...props} />
    </div>
  )
}

export { Progress, StageProgress }
export type { ProgressProps, StageProgressProps }
