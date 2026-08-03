import * as TabsPrimitive from "@radix-ui/react-tabs"
import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

const Tabs = TabsPrimitive.Root

function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-surface p-1",
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors duration-fast ease-forge outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-overlay data-[state=active]:text-foreground [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("outline-none", className)} {...props} />
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
