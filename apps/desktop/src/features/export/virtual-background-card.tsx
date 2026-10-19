import { useEffect, useRef, useState } from "react"
import type { WebcamBackground } from "@recordforge/contracts"
import {
  Button,
  ColorPicker,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Slider,
  Switch,
} from "@recordforge/ui"
import {
  downloadVirtualBackgroundModel,
  getVirtualBackgroundStatus,
  onVirtualBackgroundDownloadProgress,
} from "../../lib/background"
import { ProBadge } from "../licensing/pro-badge"
import { useLicenseStore } from "../../stores/license-store"
import { useToast } from "@recordforge/ui"
import { createVirtualBackgroundController } from "./virtual-background-controller"

interface VirtualBackgroundCardProps {
  background: WebcamBackground
  disabled?: boolean
  // False when the project has no camera source at all — show an honest
  // empty state instead of a dead enabled switch.
  hasCamera?: boolean
  onChange: (background: WebcamBackground) => void
}

const MODEL_LABEL = "0.5 MB model"

export function VirtualBackgroundCard({
  background,
  disabled,
  hasCamera = true,
  onChange,
}: VirtualBackgroundCardProps) {
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const { toast } = useToast()
  const [modelReady, setModelReady] = useState<boolean | null>(null)
  // Distinguish "model missing" (offer download) from "status check failed"
  // (offer retry) — a failed probe must not pretend the model is absent.
  const [statusError, setStatusError] = useState<string | null>(null)
  // null = idle; "indeterminate" while the native side reports no byte total.
  const [downloadRatio, setDownloadRatio] = useState<number | "indeterminate" | null>(null)

  // Async ownership lives in the controller — the card only binds its
  // hooks to state (double-click, stale probes, and unmount races are
  // unit-tested there).
  const controllerRef = useRef<ReturnType<typeof createVirtualBackgroundController> | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = createVirtualBackgroundController({
      getStatus: getVirtualBackgroundStatus,
      download: downloadVirtualBackgroundModel,
      onProgress: onVirtualBackgroundDownloadProgress,
      toast,
      hooks: {
        modelReady: setModelReady,
        statusError: setStatusError,
        downloadRatio: setDownloadRatio,
      },
    })
  }
  const controller = controllerRef.current

  useEffect(() => {
    controller.mount()
    return () => controller.unmount()
  }, [controller])

  function gate(): boolean {
    if (isPro) return false
    openUpgradeDialog(["virtual-background"])
    return true
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex w-full items-center justify-between p-4">
        <span className="flex items-center gap-2 font-label text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Webcam background
          {!isPro ? <ProBadge /> : null}
        </span>
        <Switch
          checked={background.enabled}
          disabled={disabled}
          aria-label="Virtual background"
          onCheckedChange={(enabled) => {
            // Turning ON needs a camera source; turning an already-enabled
            // setting OFF must always work — a persisted blur from a removed
            // camera can't be a Pro trap the user can't escape.
            if (!enabled) {
              onChange({ ...background, enabled })
              return
            }
            if (!hasCamera || gate()) return
            onChange({ ...background, enabled })
          }}
        />
      </div>
      {!hasCamera ? (
        <p className="border-t border-border px-5 py-3 text-xs text-subtle-foreground">
          No webcam in this project — add a camera recording to replace or blur its background.
        </p>
      ) : background.enabled ? (
        <div className="flex flex-col gap-4 border-t border-border p-5 text-xs text-subtle-foreground">
          {modelReady === null && statusError === null ? (
            <Skeleton className="h-4 w-2/3 rounded" />
          ) : null}
          {statusError !== null ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => controller.retryStatus()}
                disabled={disabled}
              >
                Retry
              </Button>
              <span className="flex-1">Couldn't check the segmentation model — {statusError}</span>
            </div>
          ) : null}
          {modelReady === false ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void controller.startDownload()}
                disabled={disabled || downloadRatio != null}
              >
                {downloadRatio == null
                  ? `Download model (${MODEL_LABEL})`
                  : downloadRatio === "indeterminate"
                    ? "Downloading…"
                    : `Downloading… ${Math.round(downloadRatio * 100)}%`}
              </Button>
              <span className="flex-1">
                On-device person segmentation — required once, never uploaded.
              </span>
            </div>
          ) : null}
          <label className="flex flex-col gap-1.5">
            <span className="text-foreground">Backdrop</span>
            <Select
              value={background.mode}
              onValueChange={(mode) =>
                onChange({ ...background, mode: mode as WebcamBackground["mode"] })
              }
              disabled={disabled}
            >
              <SelectTrigger className="h-8 w-full" aria-label="Backdrop mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="blur">Blur</SelectItem>
                <SelectItem value="replace">Solid color</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {background.mode === "blur" ? (
            <label className="flex flex-col gap-1.5">
              <span className="flex justify-between text-foreground">
                <span>Blur strength</span>
                <span className="text-subtle-foreground">{Math.round(background.blurSigma)}</span>
              </span>
              <Slider
                value={[background.blurSigma]}
                onValueChange={([blurSigma]) => onChange({ ...background, blurSigma })}
                min={2}
                max={80}
                step={2}
                disabled={disabled}
              />
            </label>
          ) : (
            <label className="flex flex-col gap-1.5">
              <span className="text-foreground">Background color</span>
              <ColorPicker
                value={background.replaceColor}
                onChange={(replaceColor) => onChange({ ...background, replaceColor })}
                disabled={disabled}
                size="sm"
              />
            </label>
          )}
          <span>
            Applies at export — the camera feed is cut out and composited on the backdrop. The
            canvas shows the unprocessed webcam; use Preview finished video to audition the effect.
          </span>
        </div>
      ) : null}
    </div>
  )
}
