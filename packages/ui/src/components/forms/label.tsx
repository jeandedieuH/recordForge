import * as LabelPrimitive from "@radix-ui/react-label"
import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn(
        "text-sm font-medium text-foreground select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { Label }
