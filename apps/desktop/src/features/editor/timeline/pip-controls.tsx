import type { TimelineTrack } from "@recordforge/contracts"
import { createUpdateClipTransformCommand } from "@recordforge/editor-core"
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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

  function handleNumberChange(field: keyof typeof transform, value: string) {
    const parsed = Number.parseFloat(value)
    if (!Number.isNaN(parsed)) {
      updateTransform({ [field]: parsed })
    }
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
        <div>
          <label className="mb-1 block text-xs font-medium">X</label>
          <Input
            type="number"
            value={transform.x}
            onChange={(e) => handleNumberChange("x", e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Y</label>
          <Input
            type="number"
            value={transform.y}
            onChange={(e) => handleNumberChange("y", e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Width</label>
          <Input
            type="number"
            value={transform.width}
            onChange={(e) => handleNumberChange("width", e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Height</label>
          <Input
            type="number"
            value={transform.height}
            onChange={(e) => handleNumberChange("height", e.target.value)}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium">Opacity</label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={transform.opacity}
          onChange={(e) => updateTransform({ opacity: Number.parseFloat(e.target.value) })}
          className="w-full"
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
