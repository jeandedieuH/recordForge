import type { MaskClip, MediaMetadata } from "@recordforge/contracts"
import { Sparkles } from "lucide-react"
import { ColorPicker, NativeSelect, Switch } from "@recordforge/ui"
import { useTimelineInteraction } from "../timeline/use-timeline-interaction"
import { ClipPropertiesInspector } from "./clip-properties-inspector"
import { InspectorSection, NumberField } from "./fields"

interface MaskClipInspectorProps {
  clip: MaskClip
  track: import("@recordforge/contracts").TimelineTrack
  metadata: MediaMetadata | null
  selectedClipCount?: number
}

export function MaskClipInspector({
  clip,
  track,
  metadata,
  selectedClipCount = 1,
}: MaskClipInspectorProps) {
  const interaction = useTimelineInteraction()

  function updateMask(update: Parameters<typeof interaction.updateMask>[1]) {
    interaction.updateMask(clip.id, update, { phase: "commit" })
  }

  return (
    <div className="flex flex-col gap-4">
      <InspectorSection title="Basic" defaultOpen>
        <ClipPropertiesInspector
          clip={clip}
          track={track}
          metadata={metadata}
          selectedClipCount={selectedClipCount}
        />
      </InspectorSection>

      <InspectorSection title="Advanced" defaultOpen>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            <Sparkles className="size-4 text-primary" aria-hidden />
            <span>Privacy mask</span>
          </div>
          <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
            Mode
            <NativeSelect
              aria-label="Mask mode"
              value={clip.mode}
              onChange={(event) => updateMask({ mode: event.target.value as typeof clip.mode })}
            >
              <option value="blur">Blur</option>
              <option value="pixelate">Pixelate</option>
              <option value="redact">Redact</option>
            </NativeSelect>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(["x", "y", "width", "height"] as const).map((field) => (
              <NumberField
                key={field}
                label={field}
                value={clip.rect[field]}
                min={field === "x" || field === "y" ? 0 : 1}
                onChange={(value) => updateMask({ rect: { [field]: value } })}
              />
            ))}
          </div>
          {clip.mode === "blur" ? (
            <NumberField
              label="Blur radius"
              value={clip.blurRadius}
              min={1}
              onChange={(value) => updateMask({ blurRadius: value })}
            />
          ) : null}
          {clip.mode === "pixelate" ? (
            <NumberField
              label="Pixel size"
              value={clip.pixelSize}
              min={2}
              onChange={(value) => updateMask({ pixelSize: Math.round(value) })}
            />
          ) : null}
          {clip.mode === "redact" ? (
            <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
              <span>Redact color</span>
              <ColorPicker
                aria-label="Redact color"
                size="sm"
                value={clip.redactColor ?? "#000000"}
                onChange={(redactColor) => updateMask({ redactColor })}
              />
            </div>
          ) : null}
          <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
            <span>Enabled in preview and export</span>
            <Switch checked={clip.enabled} onCheckedChange={(enabled) => updateMask({ enabled })} />
          </label>
        </div>
      </InspectorSection>
    </div>
  )
}
