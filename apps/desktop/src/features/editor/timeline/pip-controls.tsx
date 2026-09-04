import type { TimelineTrack } from "@recordforge/contracts"
import { createUpdateClipTransformCommand } from "@recordforge/editor-core"
import {
  Button,
  NumberInputField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
} from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

interface PipControlsProps {
  track: TimelineTrack
  selectedClipId: string | null
  onClose: () => void
}

// PiP placement, size, and opacity controls for a camera clip.
export function PipControls({ track, selectedClipId, onClose }: PipControlsProps) {
  const store = useTimelineStore()
  const clip = track.clips.find((c) => c.id === selectedClipId)

  if (!clip || clip.kind !== "camera") {
    return (
      <div className="rounded border border-border bg-muted p-3 text-sm">
        Select a camera clip to edit PiP.
        <Button variant="ghost" className="ml-2" onClick={onClose}>
          Close
        </Button>
      </div>
    )
  }

  const camera = clip
  const transform = camera.transform

  function updateTransform(partial: Partial<typeof transform>) {
    store.execute(
      createUpdateClipTransformCommand(camera.id, {
        ...transform,
        ...partial,
      }),
    )
  }

  return (
    <div className="space-y-3 rounded border border-border bg-muted p-3 text-sm">
      <div className="flex items-center justify-between">
        <h4 className="font-medium">Picture-in-picture</h4>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberInputField
          size="sm"
          label="X"
          unit="px"
          value={transform.x}
          onChange={(val) => updateTransform({ x: val })}
        />
        <NumberInputField
          size="sm"
          label="Y"
          unit="px"
          value={transform.y}
          onChange={(val) => updateTransform({ y: val })}
        />
        <NumberInputField
          size="sm"
          label="Width"
          unit="px"
          min={10}
          value={transform.width}
          onChange={(val) => updateTransform({ width: val })}
        />
        <NumberInputField
          size="sm"
          label="Height"
          unit="px"
          min={10}
          value={transform.height}
          onChange={(val) => updateTransform({ height: val })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs font-medium">
          <span>Opacity</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {Math.round(transform.opacity * 100)}%
          </span>
        </div>
        <Slider
          size="sm"
          min={0}
          max={1}
          step={0.05}
          value={[transform.opacity]}
          onValueChange={([val]) => val !== undefined && updateTransform({ opacity: val })}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium">Shape</label>
        <Select
          value={transform.shape}
          onValueChange={(val) =>
            updateTransform({
              shape: val as (typeof transform)["shape"],
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select shape" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="rectangle">Rectangle</SelectItem>
            <SelectItem value="rounded">Rounded</SelectItem>
            <SelectItem value="circle">Circle</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
