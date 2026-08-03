import * as SwitchPrimitive from "@radix-ui/react-switch"
import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-overlay transition-colors duration-fast ease-forge outline-none focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-muted-foreground transition-transform duration-fast ease-forge data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-accent-foreground" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
