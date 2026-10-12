import { FlipHorizontal2, Grid3x3, Video } from "lucide-react"
import { Switch, ToggleGroup, ToggleGroupItem } from "@recordforge/ui"
import type { CameraProfileId } from "@recordforge/contracts"
import { cameraTiers } from "@recordforge/contracts"
import { useRecorderStore } from "../../hooks/use-recorder"

const TIER_DESCRIPTIONS: Record<CameraProfileId, string> = {
  "camera-low": "720p · lightest on CPU and disk",
  "camera-balanced": "1080p · best for most cameras",
  "camera-high": "1080p · higher bitrate, cleaner detail",
  "camera-ultra": "Up to 4K · for 4K cameras, heavy on CPU/GPU",
}

const SELF_VIEW_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "standard", label: "Smooth" },
] as const

// Recording-Defaults card for camera mode: tier, self-view, mirror and the
// framing guide. Mirrors the camera setup panel's picks (same preferences).
export function CameraDefaultsCard() {
  const {
    preferences,
    preferencesLoaded,
    selectedCameraProfileId,
    setSelectedCameraProfileId,
    savePreferences,
  } = useRecorderStore()

  return (
    <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <Video className="size-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Camera Defaults</h3>
        </div>
        <p className="text-xs text-subtle-foreground mt-0.5">
          Default quality and preview behaviour for camera recordings.
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-subtle-foreground mb-1.5">
          Default quality
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {cameraTiers.map((tier) => (
            <button
              key={tier.id}
              type="button"
              disabled={!preferencesLoaded}
              onClick={() => setSelectedCameraProfileId(tier.id)}
              className={`flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition-all ${
                selectedCameraProfileId === tier.id
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-surface-dim text-subtle-foreground hover:border-border-strong"
              }`}
            >
              <span className="text-xs font-semibold text-foreground">{tier.label}</span>
              <span className="text-[11px] text-subtle-foreground leading-snug">
                {TIER_DESCRIPTIONS[tier.id]}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-subtle-foreground mb-1.5">
          Self-view while recording
        </label>
        <ToggleGroup
          type="single"
          value={preferences.cameraPreviewMode}
          onValueChange={(value) => {
            if (value) {
              void savePreferences({
                cameraPreviewMode: value as typeof preferences.cameraPreviewMode,
              })
            }
          }}
          className="w-fit"
        >
          {SELF_VIEW_OPTIONS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value} className="text-xs">
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="mt-1.5 text-[11px] text-subtle-foreground">
          A small always-on-top window shows your framing. It never appears in the recording.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex items-center justify-between rounded-lg border border-border bg-surface-dim px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <FlipHorizontal2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">Mirror preview</div>
              <div className="text-[11px] text-subtle-foreground">
                Show a mirrored setup preview; the recording is not mirrored.
              </div>
            </div>
          </div>
          <Switch
            checked={preferences.cameraMirrorPreview}
            disabled={!preferencesLoaded}
            onCheckedChange={(checked) => void savePreferences({ cameraMirrorPreview: checked })}
            aria-label="Mirror camera preview"
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border bg-surface-dim px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <Grid3x3 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">Framing guide</div>
              <div className="text-[11px] text-subtle-foreground">
                Rule-of-thirds overlay on the setup preview.
              </div>
            </div>
          </div>
          <Switch
            checked={preferences.cameraFramingGuide}
            disabled={!preferencesLoaded}
            onCheckedChange={(checked) => void savePreferences({ cameraFramingGuide: checked })}
            aria-label="Show framing guide"
          />
        </div>
      </div>
    </div>
  )
}
