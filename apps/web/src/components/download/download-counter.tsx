import { convexQuery } from "@convex-dev/react-query"
import { useQuery } from "@tanstack/react-query"
import { FolderDown } from "lucide-react"
import { Skeleton } from "@recordforge/ui"
import { api } from "../../../convex/_generated/api"

/**
 * Live download total — Convex reactive query, so it ticks up in real time
 * as visitors download. Skeleton until the first result lands.
 */
export function DownloadCounter() {
  const { data } = useQuery(convexQuery(api.downloads.stats, {}))

  return (
    <div className="inline-flex items-center gap-2.5 rounded-full border border-border bg-surface px-4 py-2 text-sm text-muted-foreground">
      <FolderDown className="size-4 text-accent" aria-hidden />
      {data === undefined ? (
        <Skeleton className="h-4 w-36" />
      ) : (
        <span>
          <span className="font-semibold text-foreground tnum">{data.total.toLocaleString()}</span>{" "}
          downloads and counting
        </span>
      )}
    </div>
  )
}
