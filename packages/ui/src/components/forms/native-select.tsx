import type { SelectHTMLAttributes } from "react"
import { cn } from "../../lib/cn"

/**
 * Legacy native <select> wrapper kept for call sites not yet migrated to the
 * Radix-based Select. New code must use Select from forms/select.
 */
function NativeSelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-8 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground outline-none transition-colors duration-fast ease-forge focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { NativeSelect }
