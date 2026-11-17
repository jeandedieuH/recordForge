import type { CameraFrameAspect, CameraFrameShape } from "@recordforge/contracts"
import { Circle, RectangleHorizontal, Square } from "lucide-react"
import { SimpleSelect, ToggleGroup, ToggleGroupItem } from "@recordforge/ui"
import { DebouncedSlider, InspectorSection } from "../fields"
import type { CameraSectionProps } from "./camera-section-props"

const SHAPES: Array<{ value: CameraFrameShape; label: string; icon: typeof Square }> = [
  { value: "rectangle", label: "Rectangle", icon: Square },
  { value: "rounded", label: "Rounded", icon: RectangleHorizontal },
  { value: "circle", label: "Circle", icon: Circle },
]

const ASPECTS: Array<{ value: CameraFrameAspect; label: string }> = [
  { value: "source", label: "Source" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "5:7", label: "5:7" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
]

const ASPECT_VALUES = new Set<string>(ASPECTS.map((aspect) => String(aspect.value)))

// Shape and box aspect. Shape edits keep the frame's origin so toggling a
// shape does not pin an auto frame; choosing an aspect pins like any manual
// geometry change.
export function CameraShapeSection({ frame, onUpdate }: CameraSectionProps) {
  const aspectLocked = frame.shape === "circle" || frame.placement.mode === "full"
  const aspectValue = typeof frame.aspect === "number" ? "source" : frame.aspect

  return (
    <InspectorSection title="Shape" defaultOpen>
      <div className="flex flex-col gap-3">
        <ToggleGroup
          type="single"
          value={frame.shape}
          onValueChange={(value) => {
            if (!value) return
            onUpdate({
              shape: value as CameraFrameShape,
              placement: { origin: frame.placement.origin },
            })
          }}
          aria-label="Camera shape"
          className="flex-1"
        >
          {SHAPES.map((shape) => (
            <ToggleGroupItem
              key={shape.value}
              value={shape.value}
              className="flex-1 text-xs"
              aria-label={`${shape.label} shape`}
            >
              <shape.icon className="size-3.5" aria-hidden />
              {shape.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {frame.shape === "rounded" ? (
          <>
            <div className="flex items-center justify-between text-xs">
              <span className="text-subtle-foreground">Corner radius</span>
              <span className="font-mono tabular-nums">
                {Math.round(frame.cornerRadius * 100)}%
              </span>
            </div>
            <DebouncedSlider
              value={[frame.cornerRadius * 100]}
              min={0}
              max={50}
              step={1}
              aria-label="Corner radius (percent of short side)"
              onValueCommit={(value) => onUpdate({ cornerRadius: (value[0] ?? 12) / 100 })}
            />
          </>
        ) : null}

        <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
          <span>Aspect</span>
          <SimpleSelect
            aria-label="Camera aspect"
            size="sm"
            value={aspectValue}
            disabled={aspectLocked}
            onValueChange={(value) => {
              if (!ASPECT_VALUES.has(value)) return
              onUpdate({ aspect: value as CameraFrameAspect })
            }}
            className="w-32"
            options={ASPECTS.map((aspect) => ({
              value: String(aspect.value),
              label: aspect.label,
            }))}
          />
        </div>
        {aspectLocked ? (
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            {frame.shape === "circle"
              ? "A circle always resolves to a 1:1 box, so aspect is fixed."
              : "A full-canvas camera always uses the canvas aspect, so aspect is fixed."}
          </p>
        ) : null}
      </div>
    </InspectorSection>
  )
}
