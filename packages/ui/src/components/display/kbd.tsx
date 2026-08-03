import type { HTMLAttributes } from "react"
import { cn } from "../../lib/cn"

/** Keyboard shortcut hint element — used in tooltips, menus, and shortcut maps. */
function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-overlay px-1 font-mono text-[10px] font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
