import { useConvexMutation } from "@convex-dev/react-query"
import { useMutation } from "@tanstack/react-query"
import { useCallback } from "react"
import { api } from "../../convex/_generated/api"
import type { DetectedPlatform } from "./releases"

interface TrackDownloadInput {
  platform: DetectedPlatform
  asset: string
  version: string
  url: string
}

/**
 * Records a download in Convex, then navigates to the asset URL.
 * A tracking failure must never block the download, so the mutation
 * error is swallowed before redirecting.
 */
export function useTrackDownload() {
  const record = useMutation({
    mutationFn: useConvexMutation(api.downloads.record),
  })

  const track = useCallback(
    async (input: TrackDownloadInput) => {
      try {
        await record.mutateAsync({
          platform: input.platform,
          asset: input.asset,
          version: input.version,
        })
      } catch {
        // Analytics are best-effort — proceed to the download regardless.
      }
      window.location.assign(input.url)
    },
    [record],
  )

  return { track, isTracking: record.isPending }
}
