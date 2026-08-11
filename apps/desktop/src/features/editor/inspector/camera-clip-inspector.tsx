import type { CameraClip, ClipTransform, MediaMetadata } from "@recordforge/contracts"
import { AlignLeft, AlignRight, Maximize2, Sparkles } from "lucide-react"
import { Input, Slider, Switch } from "@recordforge/ui"
import { useTimelineInteraction } from "../timeline/use-timeline-interaction"
import { ClipPropertiesInspector } from "./clip-properties-inspector"
import { InspectorSection, NumberField, PresetButton } from "./fields"

interface CameraClipInspectorProps {
  clip: CameraClip
  track: import("@recordforge/contracts").TimelineTrack
  metadata: MediaMetadata | null
  selectedClipCount?: number
}

export function CameraClipInspector({
  clip,
  track,
  metadata,
  selectedClipCount = 1,
}: CameraClipInspectorProps) {
  const interaction = useTimelineInteraction()

  function updateTransform(partial: Partial<ClipTransform>) {
    interaction.updateClipTransform(clip.id, { ...clip.transform, ...partial }, { phase: "commit" })
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
            <Sparkles className="size-4 text-tertiary" aria-hidden />
            <span>Picture in picture</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="X"
              value={clip.transform.x}
              onChange={(value) => updateTransform({ x: value })}
            />
            <NumberField
              label="Y"
              value={clip.transform.y}
              onChange={(value) => updateTransform({ y: value })}
            />
            <NumberField
              label="Width"
              value={clip.transform.width}
              onChange={(value) => updateTransform({ width: value })}
            />
            <NumberField
              label="Height"
              value={clip.transform.height}
              onChange={(value) => updateTransform({ height: value })}
            />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-subtle-foreground">Opacity</span>
            <span className="font-mono tabular-nums">
              {Math.round(clip.transform.opacity * 100)}%
            </span>
          </div>
          <Slider
            value={[clip.transform.opacity]}
            min={0}
            max={1}
            step={0.05}
            aria-label="Camera opacity"
            onValueChange={(value) => updateTransform({ opacity: value[0] ?? 1 })}
          />
          <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
            <span>Show camera</span>
            <Switch
              checked={clip.transform.visible !== false}
              onCheckedChange={(visible) => updateTransform({ visible })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
            <span>Shape</span>
            <select
              aria-label="Camera shape"
              value={clip.transform.shape}
              onChange={(event) =>
                updateTransform({
                  shape: event.target.value as ClipTransform["shape"],
                })
              }
              className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground"
            >
              <option value="rectangle">Rectangle</option>
              <option value="rounded">Rounded</option>
              <option value="circle">Circle</option>
            </select>
          </label>

          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-dim p-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-subtle-foreground">
              Crop (source pixels)
            </span>
            <div className="grid grid-cols-2 gap-2">
              {(["x", "y", "width", "height"] as const).map((field) => (
                <NumberField
                  key={field}
                  label={field}
                  value={clip.transform.crop?.[field] ?? 0}
                  onChange={(value) =>
                    updateTransform({
                      crop: {
                        x: clip.transform.crop?.x ?? 0,
                        y: clip.transform.crop?.y ?? 0,
                        width: clip.transform.crop?.width ?? metadata?.width ?? 1,
                        height: clip.transform.crop?.height ?? metadata?.height ?? 1,
                        [field]: value,
                      },
                    })
                  }
                />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Border width"
              value={clip.transform.borderWidth ?? 0}
              onChange={(value) => updateTransform({ borderWidth: value })}
            />
            <NumberField
              label="Border opacity"
              value={clip.transform.borderOpacity ?? 1}
              onChange={(value) => updateTransform({ borderOpacity: value })}
            />
            <NumberField
              label="Shadow blur"
              value={clip.transform.shadowBlur ?? 0}
              onChange={(value) => updateTransform({ shadowBlur: value, shadowEnabled: value > 0 })}
            />
            <NumberField
              label="Shadow X"
              value={clip.transform.shadowOffsetX ?? 0}
              onChange={(value) => updateTransform({ shadowOffsetX: value })}
            />
            <NumberField
              label="Shadow Y"
              value={clip.transform.shadowOffsetY ?? 0}
              onChange={(value) => updateTransform({ shadowOffsetY: value })}
            />
          </div>

          <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
            <span>Border color</span>
            <Input
              aria-label="Camera border color"
              type="color"
              value={clip.transform.borderColor ?? "#ffffff"}
              onChange={(event) => updateTransform({ borderColor: event.target.value })}
              className="h-8 w-12 p-1"
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <PresetButton
              active={clip.transform.x < 100}
              label="Left"
              onClick={() => updateTransform({ x: 24, y: 24 })}
              icon={AlignLeft}
            />
            <PresetButton
              active={clip.transform.x > 100}
              label="Right"
              onClick={() =>
                updateTransform({
                  x: (metadata?.width ?? 1920) - clip.transform.width - 24,
                  y: 24,
                })
              }
              icon={AlignRight}
            />
            <PresetButton
              active={clip.transform.width >= (metadata?.width ?? 1920) - 10}
              label="Full"
              onClick={() =>
                updateTransform({
                  x: 0,
                  y: 0,
                  width: metadata?.width ?? 1920,
                  height: metadata?.height ?? 1080,
                })
              }
              icon={Maximize2}
            />
          </div>
        </div>
      </InspectorSection>
    </div>
  )
}
