import { Button } from "@recordforge/ui"
import { DebouncedSlider, InspectorSection } from "../fields"
import type { CameraSectionProps } from "./camera-section-props"

const MAX_ZOOM = 3

// Source-window framing inside the cover crop: focus positions the crop
// centre (0.5 = centred), zoom >= 1 shrinks the crop around it. Face
// tracking owns the crop when enabled, so the sliders disable then.
export function CameraFramingSection({ clip, frame, onUpdate }: CameraSectionProps) {
  const framing = frame.framing
  const disabled = clip.faceTracking?.enabled === true

  return (
    <InspectorSection title="Framing" defaultOpen>
      <div className="flex flex-col gap-3">
        {disabled ? (
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            Face tracking is enabled and controls the crop automatically. Turn it off to frame the
            camera manually.
          </p>
        ) : null}

        <div className="flex items-center justify-between text-xs">
          <span className="text-subtle-foreground">Zoom</span>
          <span className="font-mono tabular-nums">{framing.zoom.toFixed(2)}x</span>
        </div>
        <DebouncedSlider
          value={[framing.zoom]}
          min={1}
          max={MAX_ZOOM}
          step={0.05}
          disabled={disabled}
          aria-label="Camera framing zoom"
          onValueCommit={(value) => onUpdate({ framing: { zoom: value[0] ?? 1 } })}
        />
        <div className="flex items-center justify-between text-xs">
          <span className="text-subtle-foreground">Focus X</span>
          <span className="font-mono tabular-nums">{Math.round(framing.focusX * 100)}%</span>
        </div>
        <DebouncedSlider
          value={[framing.focusX]}
          min={0}
          max={1}
          step={0.01}
          disabled={disabled}
          aria-label="Camera focus X"
          onValueCommit={(value) => onUpdate({ framing: { focusX: value[0] ?? 0.5 } })}
        />
        <div className="flex items-center justify-between text-xs">
          <span className="text-subtle-foreground">Focus Y</span>
          <span className="font-mono tabular-nums">{Math.round(framing.focusY * 100)}%</span>
        </div>
        <DebouncedSlider
          value={[framing.focusY]}
          min={0}
          max={1}
          step={0.01}
          disabled={disabled}
          aria-label="Camera focus Y"
          onValueCommit={(value) => onUpdate({ framing: { focusY: value[0] ?? 0.5 } })}
        />

        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onUpdate({ framing: { focusX: 0.5, focusY: 0.5 } })}
          className="w-full text-xs"
        >
          Center
        </Button>
      </div>
    </InspectorSection>
  )
}
