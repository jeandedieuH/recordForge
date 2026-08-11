import type { CanvasAspectRatio } from "@recordforge/contracts"
import { createUpdateCanvasCommand } from "@recordforge/editor-core"
import { LayoutTemplate } from "lucide-react"
import { Button, Input, NativeSelect, Switch } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

const ASPECT_RATIOS: { value: CanvasAspectRatio; label: string }[] = [
  { value: "16:9", label: "16:9" },
  { value: "1:1", label: "1:1" },
  { value: "9:16", label: "9:16" },
  { value: "custom", label: "Custom" },
]

export function LayoutPanel() {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)

  if (!timeline) {
    return (
      <div className="flex h-full flex-col gap-3 p-3">
        <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
          <LayoutTemplate className="size-4 text-primary" aria-hidden />
          <h2>Layout</h2>
        </div>
        <p className="text-[11px] text-subtle-foreground">No timeline loaded.</p>
      </div>
    )
  }

  const canvas = timeline.canvas

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
        <LayoutTemplate className="size-4 text-primary" aria-hidden />
        <h2>Layout</h2>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Width"
          value={canvas.width}
          onChange={(value) => execute(createUpdateCanvasCommand({ width: value }))}
        />
        <NumberField
          label="Height"
          value={canvas.height}
          onChange={(value) => execute(createUpdateCanvasCommand({ height: value }))}
        />
        <NumberField
          label="Padding"
          value={canvas.padding}
          onChange={(value) => execute(createUpdateCanvasCommand({ padding: value }))}
        />
        <NumberField
          label="Corner radius"
          value={canvas.borderRadius}
          onChange={(value) => execute(createUpdateCanvasCommand({ borderRadius: value }))}
        />
      </div>

      <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
        <span>Aspect ratio</span>
        <NativeSelect
          aria-label="Canvas aspect ratio"
          value={canvas.aspectRatio ?? "custom"}
          onChange={(event) =>
            execute(
              createUpdateCanvasCommand({
                aspectRatio: event.target.value as CanvasAspectRatio,
              }),
            )
          }
        >
          {ASPECT_RATIOS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </label>

      <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
        <span>Background</span>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Canvas background"
            type="color"
            value={canvas.background}
            onChange={(event) =>
              execute(createUpdateCanvasCommand({ background: event.target.value }))
            }
            className="h-8 w-12 p-1"
          />
          <span className="font-mono text-[11px]">{canvas.background}</span>
        </div>
      </label>

      <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
        <span>Canvas shadow</span>
        <Switch
          checked={canvas.shadow}
          onCheckedChange={(shadow) => execute(createUpdateCanvasCommand({ shadow }))}
        />
      </label>

      <div className="mt-auto flex flex-col gap-2">
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          Output canvas dimensions, padding, and background are used by the preview and the final
          export.
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            execute(
              createUpdateCanvasCommand({
                width: 1920,
                height: 1080,
                padding: 0,
                borderRadius: 0,
                aspectRatio: "16:9",
                background: "#000000",
                shadow: false,
              }),
            )
          }
        >
          Reset to 1080p
        </Button>
      </div>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-subtle-foreground">
      <span>{label}</span>
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}
