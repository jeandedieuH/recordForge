import type { CameraPlacementPreset } from "@recordforge/contracts"
import {
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@recordforge/ui"
import { CameraPresetThumbnail } from "./camera-preset-thumbnail"

interface PresetMeta {
  id: CameraPlacementPreset
  label: string
  description: string
}

const PRESETS: PresetMeta[] = [
  {
    id: "camera-only",
    label: "Camera only",
    description: "Webcam fills the whole canvas. Locked so it cannot be dragged.",
  },
  {
    id: "vertical-pip",
    label: "Vertical PiP",
    description: "A tall rectangular webcam overlay in the bottom-right corner.",
  },
  {
    id: "circle-pip",
    label: "Circular PiP",
    description: "A perfectly round webcam overlay in the bottom-right corner.",
  },
  {
    id: "side-by-side",
    label: "Side by side",
    description: "Expanded screen on the left, 5:7 portrait webcam on the right.",
  },
]

interface CameraPresetPickerProps {
  activePreset?: CameraPlacementPreset
  onSelect: (preset: CameraPlacementPreset) => void
}

// Visual, one-click camera placement presets. Each item is a labelled thumbnail
// so the user can see the layout before applying it.
export function CameraPresetPicker({ activePreset, onSelect }: CameraPresetPickerProps) {
  return (
    <ToggleGroup
      type="single"
      value={activePreset ?? ""}
      onValueChange={(value) => {
        if (!value) return
        onSelect(value as CameraPlacementPreset)
      }}
      className="grid grid-cols-2 gap-2"
      aria-label="Camera placement preset"
    >
      {PRESETS.map((preset) => (
        <Tooltip key={preset.id}>
          <TooltipTrigger asChild>
            <ToggleGroupItem
              value={preset.id}
              className="h-auto w-full flex-col gap-1.5 p-2"
              aria-label={preset.label}
            >
              <CameraPresetThumbnail preset={preset.id} />
              <span className="text-[10px]">{preset.label}</span>
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-45">
            <p className="text-xs">{preset.description}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  )
}
