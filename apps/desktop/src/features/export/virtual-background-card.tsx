import { useEffect, useState } from "react"
import type { WebcamBackground } from "@recordforge/contracts"
import {
  Button,
  ColorPicker,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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

interface VirtualBackgroundCardProps {
  background: WebcamBackground
  disabled?: boolean
  onChange: (background: WebcamBackground) => void
}

const MODEL_LABEL = "0.5 MB model"

export function VirtualBackgroundCard({
  background,
  disabled,
  onChange,
}: VirtualBackgroundCardProps) {
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const { toast } = useToast()
  const [modelReady, setModelReady] = useState<boolean | null>(null)
  const [downloadRatio, setDownloadRatio] = useState<number | null>(null)

  useEffect(() => {
    getVirtualBackgroundStatus()
      .then((status) => setModelReady(status.modelReady))
      .catch(() => setModelReady(false))
  }, [])

  async function handleDownload() {
    if (downloadRatio != null) return
    setDownloadRatio(0)
    const unlisten = await onVirtualBackgroundDownloadProgress((progress) => {
      setDownloadRatio(
        progress.totalBytes > 0 ? progress.downloadedBytes / progress.totalBytes : null,
      )
    })
    try {
      await downloadVirtualBackgroundModel()
      setModelReady(true)
    } catch (error) {
      toast({
        kind: "error",
        title: "Model download failed",
        description: error instanceof Error ? error.message : "Could not download the model.",
      } as Parameters<typeof toast>[0])
    } finally {
      unlisten()
      setDownloadRatio(null)
    }
  }

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
            if (enabled && gate()) return
            onChange({ ...background, enabled })
          }}
        />
      </div>
      {background.enabled ? (
        <div className="flex flex-col gap-4 border-t border-border p-5 text-xs text-subtle-foreground">
          {modelReady === false ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownload}
                disabled={disabled || downloadRatio != null}
              >
                {downloadRatio == null ? `Download model (${MODEL_LABEL})` : "Downloading…"}
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
            Applies at export — the camera feed is cut out and composited on the backdrop. Preview
            shows the unprocessed webcam.
          </span>
        </div>
      ) : null}
    </div>
  )
}
