import { Download } from "lucide-react"
import { Button, type ButtonProps } from "@recordforge/ui"
import type { DetectedPlatform, ReleaseAsset } from "../../lib/releases"
import { useTrackDownload } from "../../lib/track-download"

interface DownloadButtonProps {
  platform: DetectedPlatform
  asset: ReleaseAsset
  version: string
  variant?: ButtonProps["variant"]
}

/**
 * Download CTA — records the click in Convex, then hands the browser the
 * GitHub Release asset URL. Tracking failures never block the download.
 */
export function DownloadButton({
  platform,
  asset,
  version,
  variant = "primary",
}: DownloadButtonProps) {
  const { track, isTracking } = useTrackDownload()

  return (
    <Button
      variant={variant}
      size="lg"
      loading={isTracking}
      className="w-full rounded-xl"
      onClick={() => track({ platform, asset: asset.id, version, url: asset.url })}
    >
      <Download className="size-4" aria-hidden />
      {asset.label}
    </Button>
  )
}
