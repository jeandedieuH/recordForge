import type {
  CameraFrameMode,
  CameraFrameSide,
  CameraPlacementPreset,
} from "@recordforge/contracts"
import { autoPresetForAspectRatio, createApplyCameraPresetCommand } from "@recordforge/editor-core"
import { RotateCcw } from "lucide-react"
import { IconButton, SimpleSelect, ToggleGroup, ToggleGroupItem } from "@recordforge/ui"
import { useTimelineStore } from "../../../../stores/timeline-store"
import { DebouncedSlider, InspectorSection } from "../fields"
import { CameraPresetPicker } from "../camera-preset-picker"
import { AnchorGrid } from "./anchor-grid"
import type { CameraSectionProps } from "./camera-section-props"

const MODES: Array<{ value: CameraFrameMode; label: string }> = [
  { value: "overlay", label: "Overlay" },
  { value: "split", label: "Split" },
  { value: "full", label: "Full" },
]

const SIDES: Array<{ value: CameraFrameSide; label: string }> = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
]

// Where the camera sits: a free overlay, a side-by-side split, or fullscreen.
// Placement edits pin the frame (the command merge rule) unless the user picks
// a preset, which rebuilds an auto frame that follows the canvas ratio.
export function CameraPlacementSection({ clip, frame, canvas, onUpdate }: CameraSectionProps) {
  const placement = frame.placement

  function applyPreset(preset: CameraPlacementPreset) {
    useTimelineStore.getState().execute(createApplyCameraPresetCommand(clip.id, preset))
  }

  function resetToSmartDefault() {
    applyPreset(autoPresetForAspectRatio(canvas.aspectRatio ?? "16:9"))
  }

  return (
    <InspectorSection title="Placement" defaultOpen>
      <div className="flex flex-col gap-3">
        <CameraPresetPicker activePreset={frame.preset} onSelect={applyPreset} />

        <div className="flex items-center justify-between gap-3">
          <ToggleGroup
            type="single"
            value={placement.mode}
            onValueChange={(value) => {
              if (!value) return
              onUpdate({ placement: { mode: value as CameraFrameMode } })
            }}
            aria-label="Placement mode"
            className="flex-1"
          >
            {MODES.map((mode) => (
              <ToggleGroupItem
                key={mode.value}
                value={mode.value}
                className="flex-1 text-xs"
                aria-label={`${mode.label} placement`}
              >
                {mode.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <span
            className={
              placement.origin === "auto"
                ? "rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
                : "rounded bg-surface-dim px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground"
            }
          >
            {placement.origin === "auto" ? "Auto" : "Pinned"}
          </span>
          <IconButton
            label="Reset to the smart default for this canvas"
            onClick={resetToSmartDefault}
          >
            <RotateCcw className="size-3.5" aria-hidden />
          </IconButton>
        </div>

        {placement.mode === "overlay" ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-subtle-foreground">Anchor</span>
              <AnchorGrid
                value={placement.align}
                onChange={(align) => onUpdate({ placement: { align } })}
              />
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-subtle-foreground">Size</span>
              <span className="font-mono tabular-nums">{Math.round(placement.size * 100)}%</span>
            </div>
            <DebouncedSlider
              value={[placement.size * 100]}
              min={5}
              max={100}
              step={1}
              aria-label="Camera size (percent of short edge)"
              onValueCommit={(value) => onUpdate({ placement: { size: (value[0] ?? 30) / 100 } })}
            />
            <div className="flex items-center justify-between text-xs">
              <span className="text-subtle-foreground">Margin</span>
              <span className="font-mono tabular-nums">{Math.round(placement.margin * 100)}%</span>
            </div>
            <DebouncedSlider
              value={[placement.margin * 100]}
              min={0}
              max={30}
              step={1}
              aria-label="Camera margin (percent of short edge)"
              onValueCommit={(value) => onUpdate({ placement: { margin: (value[0] ?? 0) / 100 } })}
            />
            <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
              <span>Anchor to</span>
              <SimpleSelect
                aria-label="Anchor to"
                size="sm"
                value={placement.anchorTo}
                onValueChange={(value) =>
                  onUpdate({
                    placement: { anchorTo: value as "content" | "canvas" },
                  })
                }
                className="w-32"
                options={[
                  { value: "canvas", label: "Canvas" },
                  { value: "content", label: "Content area" },
                ]}
              />
            </div>
          </>
        ) : null}

        {placement.mode === "split" ? (
          <>
            <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
              <span>Camera side</span>
              <SimpleSelect
                aria-label="Camera side"
                size="sm"
                value={placement.split.side}
                onValueChange={(value) =>
                  onUpdate({
                    placement: { split: { side: value as CameraFrameSide } },
                  })
                }
                className="w-32"
                options={SIDES}
              />
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-subtle-foreground">Screen share</span>
              <span className="font-mono tabular-nums">
                {Math.round(placement.split.ratio * 100)}%
              </span>
            </div>
            <DebouncedSlider
              value={[placement.split.ratio * 100]}
              min={30}
              max={95}
              step={1}
              aria-label="Screen share"
              onValueCommit={(value) =>
                onUpdate({ placement: { split: { ratio: (value[0] ?? 76) / 100 } } })
              }
            />
            <div className="flex items-center justify-between text-xs">
              <span className="text-subtle-foreground">Gap</span>
              <span className="font-mono tabular-nums">
                {Math.round(placement.split.gap * 100)}%
              </span>
            </div>
            <DebouncedSlider
              value={[placement.split.gap * 100]}
              min={0}
              max={20}
              step={1}
              aria-label="Split gap"
              onValueCommit={(value) =>
                onUpdate({ placement: { split: { gap: (value[0] ?? 0) / 100 } } })
              }
            />
          </>
        ) : null}

        {placement.mode === "full" ? (
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            The camera fills the whole canvas and cannot be dragged.
          </p>
        ) : null}
      </div>
    </InspectorSection>
  )
}
