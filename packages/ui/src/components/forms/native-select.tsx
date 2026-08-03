import type { SelectHTMLAttributes } from "react"
import { cn } from "../../lib/cn"

/**
 * Native <select> wrapper styled with custom arrow icon and matching design tokens.
 * For custom dropdown menus and listboxes, use Radix `Select` from `@recordforge/ui`.
 */
function NativeSelect({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative inline-block w-full">
      <select
        className={cn(
          "h-8 w-full appearance-none rounded-md border border-border bg-surface px-3 py-1 pr-8 text-xs font-medium text-foreground outline-none transition-colors duration-fast ease-forge hover:border-border-strong focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle-foreground">
        <svg
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </div>
  )
}

export { NativeSelect }
