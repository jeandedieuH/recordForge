import { useState } from "react"
import type { ManualZoomSegment } from "@recordforge/contracts"
import { clampZoomTarget, zoomSegmentBadges } from "@recordforge/cursor-core"
import {
  createDeleteZoomSegmentCommand,
  createSplitZoomSegmentCommand,
} from "@recordforge/editor-core"
import { ZoomIn } from "lucide-react"
import { Badge, Button, NativeSelect } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useTimelineInteraction } from "../timeline/use-timeline-interaction"
import { NumberField } from "./fields"

interface ZoomSegmentInspectorProps {
  segment: ManualZoomSegment
  onClear: () => void
}

function badgeVariant(
  variant: "default" | "secondary" | "outline" | "warning",
): "default" | "accent" | "outline" | "warning" {
  if (variant === "secondary") return "outline"
  if (variant === "default") return "accent"
  return variant
}

export function ZoomSegmentInspector({ segment, onClear }: ZoomSegmentInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const interaction = useTimelineInteraction()
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const [extraPadding, setExtraPadding] = useState(0)

  function handleUpdate(update: Parameters<typeof interaction.updateZoomTarget>[1]) {
    interaction.updateZoomTarget(segment.id, update, { phase: "commit" })
  }

  function clampTarget() {
    if (!timeline) return
    const clamped = clampZoomTarget(segment.target, timeline.canvas, extraPadding)
    handleUpdate({ target: clamped })
  }

  const badges = zoomSegmentBadges(segment)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ZoomIn className="size-4 text-primary" aria-hidden />
          <span>Zoom segment</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} className="h-7 text-xs">
          Clear
        </Button>
      </div>

      {badges.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {badges.map((badge) => (
            <Badge key={badge.key} variant={badgeVariant(badge.variant)} className="text-[10px]">
              {badge.label}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Target X"
          value={segment.target.x}
          onChange={(value) => handleUpdate({ target: { x: value } })}
        />
        <NumberField
          label="Target Y"
          value={segment.target.y}
          onChange={(value) => handleUpdate({ target: { y: value } })}
        />
        <NumberField
          label="Target width"
          value={segment.target.width}
          onChange={(value) => handleUpdate({ target: { width: value } })}
        />
        <NumberField
          label="Target height"
          value={segment.target.height}
          onChange={(value) => handleUpdate({ target: { height: value } })}
        />
        <NumberField
          label="Start (ms)"
          value={segment.startMs}
          onChange={(value) => handleUpdate({ startMs: value })}
        />
        <NumberField
          label="End (ms)"
          value={segment.startMs + segment.durationMs}
          onChange={(value) => handleUpdate({ endMs: value })}
        />
        <NumberField
          label="Scale"
          value={segment.scale}
          onChange={(value) => handleUpdate({ scale: value })}
        />
      </div>

      <label className="flex items-center justify-between gap-2 text-[11px] text-subtle-foreground">
        <span>Easing</span>
        <NativeSelect
          aria-label="Zoom easing"
          value={segment.easing}
          onChange={(event) =>
            handleUpdate({ easing: event.target.value as ManualZoomSegment["easing"] })
          }
          className="w-32"
        >
          <option value="linear">Linear</option>
          <option value="ease-in">Ease in</option>
          <option value="ease-out">Ease out</option>
          <option value="ease-in-out">Ease in/out</option>
          <option value="smooth">Smooth</option>
          <option value="cinematic">Cinematic</option>
          <option value="snappy">Snappy</option>
        </NativeSelect>
      </label>

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold">Safe edges</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px]"
            disabled={segment.locked || !timeline}
            onClick={clampTarget}
          >
            Clamp target
          </Button>
        </div>
        <NumberField
          label="Extra padding (px)"
          value={extraPadding}
          min={0}
          step={1}
          onChange={setExtraPadding}
        />
        <p className="text-[10px] text-muted-foreground">
          Clamp keeps the zoom target inside the padded canvas. Locked segments cannot be clamped.
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[10px]"
          disabled={segment.locked}
          onClick={() =>
            execute(
              createSplitZoomSegmentCommand(
                segment.id,
                segment.startMs + Math.floor(segment.durationMs / 2),
              ),
            )
          }
        >
          Split
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[10px]"
          onClick={() => handleUpdate({ locked: !segment.locked })}
        >
          {segment.locked ? "Unlock" : "Lock"}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-7 text-[10px]"
          disabled={segment.locked}
          onClick={() => {
            execute(createDeleteZoomSegmentCommand(segment.id))
            onClear()
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  )
}
