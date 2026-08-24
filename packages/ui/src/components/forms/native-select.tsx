import type { SelectHTMLAttributes } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "../../lib/cn"

interface NativeSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Optional class name for the wrapper element. */
  containerClassName?: string
  /** Optional class name for the select element itself. */
  selectClassName?: string
}

/**
 * Native <select> wrapper styled with custom arrow icon and matching design tokens.
 * For custom dropdown menus and listboxes, use Radix `Select` from `@recordforge/ui`.
 */
function NativeSelect({
  className,
  containerClassName,
  selectClassName,
  children,
  disabled,
  ...props
}: NativeSelectProps) {
  return (
    <div
      className={cn(
        "relative inline-flex h-8 w-full items-center rounded-md border border-border bg-surface text-xs font-medium text-foreground transition-colors duration-fast ease-forge hover:border-border-strong focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30",
        disabled && "cursor-not-allowed opacity-50",
        className,
        containerClassName,
      )}
    >
      <select
        disabled={disabled}
        className={cn(
          "h-full w-full cursor-pointer appearance-none bg-transparent px-3 py-1 pr-8 text-inherit font-inherit outline-none disabled:cursor-not-allowed",
          selectClassName,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className={cn(
          "pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground opacity-70 transition-opacity",
          disabled && "opacity-30",
        )}
        aria-hidden
      />
    </div>
  )
}

export { NativeSelect }
export type { NativeSelectProps }

