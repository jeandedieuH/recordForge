import type { SelectHTMLAttributes } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "../../lib/cn"

interface NativeSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  /** Size variant */
  size?: "sm" | "default"
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
  size = "default",
  containerClassName,
  selectClassName,
  children,
  disabled,
  ...props
}: NativeSelectProps) {
  return (
    <div
      className={cn(
        "relative inline-flex w-full items-center rounded-md border border-border bg-surface/90 text-foreground transition-[border-color,background-color,box-shadow] duration-fast ease-forge hover:border-border-strong hover:bg-surface focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25",
        size === "sm" ? "h-7 text-[11px]" : "h-8 text-xs font-medium",
        disabled && "cursor-not-allowed opacity-50",
        className,
        containerClassName,
      )}
    >
      <select
        disabled={disabled}
        className={cn(
          "h-full w-full cursor-pointer appearance-none bg-transparent px-2.5 py-1 pr-7 text-inherit font-inherit outline-none disabled:cursor-not-allowed",
          selectClassName,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className={cn(
          "pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-subtle-foreground opacity-70 transition-opacity",
          disabled && "opacity-30",
        )}
        aria-hidden
      />
    </div>
  )
}

export { NativeSelect }
export type { NativeSelectProps }
