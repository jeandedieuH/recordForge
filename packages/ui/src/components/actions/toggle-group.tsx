import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"
import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

const ToggleGroup = ToggleGroupPrimitive.Root

function ToggleGroupItem({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors duration-fast ease-forge outline-none first:rounded-l-md last:rounded-r-md hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-overlay data-[state=on]:text-foreground [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  )
}

/** Segmented control — wrap items in a bordered container when composing. */
export { ToggleGroup, ToggleGroupItem }
