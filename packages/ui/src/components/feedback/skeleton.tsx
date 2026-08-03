import type { HTMLAttributes } from "react"
import { cn } from "../../lib/cn"

/** Shimmer placeholder for loading surfaces — replaces raw "Loading..." text. */
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-overlay", className)} {...props} />
}

export { Skeleton }
