import type { LucideIcon } from "lucide-react"
import type { InputHTMLAttributes } from "react"
import { cn } from "../../lib/cn"

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Leading icon rendered inside the field. */
  icon?: LucideIcon
  /** Error state styling; pair with a human-readable message near the field. */
  error?: boolean
}

function Input({ className, icon: Icon, error, ...props }: InputProps) {
  if (Icon) {
    return (
      <div className="relative w-full">
        <Icon
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground"
          aria-hidden
        />
        <input
          aria-invalid={error || undefined}
          className={cn(
            "h-8 w-full rounded-md border bg-surface pr-3 pl-8 text-sm text-foreground outline-none transition-colors duration-fast ease-forge placeholder:text-subtle-foreground focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-50",
            error ? "border-recording/60 focus-visible:ring-recording/30" : "border-border",
            className,
          )}
          {...props}
        />
      </div>
    )
  }

  return (
    <input
      aria-invalid={error || undefined}
      className={cn(
        "h-8 w-full rounded-md border bg-surface px-3 text-sm text-foreground outline-none transition-colors duration-fast ease-forge placeholder:text-subtle-foreground focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-50",
        error ? "border-recording/60 focus-visible:ring-recording/30" : "border-border",
        className,
      )}
      {...props}
    />
  )
}

export { Input }
export type { InputProps }
