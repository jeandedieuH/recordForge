import { useState } from "react"
import { AlignLeft, AlignRight, Maximize2, Sliders, Sparkles, Volume2 } from "lucide-react"
import { Badge, Input, Slider, Switch } from "@recordforge/ui"

interface ClipInspectorProps {
  clipId: string
  onClear: () => void
}

export function ClipInspector({ clipId }: ClipInspectorProps) {
  const [scale, setScale] = useState("100%")
  const [opacity, setOpacity] = useState("100%")
  const [cornerRadius, setCornerRadius] = useState("8px")
  const [borderEnabled, setBorderEnabled] = useState(true)
  const [volume, setVolume] = useState([80])
  const [selectedPreset, setSelectedPreset] = useState<"left" | "right" | "full">("right")

  const clipLabel = clipId.toLowerCase().includes("webcam")
    ? "WebCam"
    : clipId.toLowerCase().includes("screen")
      ? "Screen"
      : "Audio"

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-5 border-l border-border bg-surface p-4 text-foreground select-none overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <h3 className="font-sans text-sm font-bold tracking-tight text-foreground">Inspector</h3>
        <Badge
          variant="accent"
          className="border-border bg-overlay font-mono text-[11px] text-muted-foreground px-2 py-0.5"
        >
          Clip: {clipLabel}
        </Badge>
      </div>

      {/* Section 1: Transform */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-subtle-foreground uppercase tracking-wider font-label">
          <Sliders className="size-4 text-primary" />
          <span>Transform</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="inspector-scale" className="text-xs font-medium text-subtle-foreground">
              Scale
            </label>
            <Input
              id="inspector-scale"
              value={scale}
              onChange={(e) => setScale(e.target.value)}
              className="border-border bg-background text-xs font-mono text-foreground text-center"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="inspector-opacity"
              className="text-xs font-medium text-subtle-foreground"
            >
              Opacity
            </label>
            <Input
              id="inspector-opacity"
              value={opacity}
              onChange={(e) => setOpacity(e.target.value)}
              className="border-border bg-background text-xs font-mono text-foreground text-center"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5 mt-1">
          <span className="text-xs font-medium text-subtle-foreground">Position Presets</span>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setSelectedPreset("left")}
              className={`flex h-8 items-center justify-center rounded border transition-colors ${
                selectedPreset === "left"
                  ? "border-primary bg-primary/20 text-foreground"
                  : "border-border bg-surface-dim text-muted-foreground hover:text-foreground"
              }`}
              title="Align Bottom Left"
            >
              <AlignLeft className="size-4" />
            </button>

            <button
              type="button"
              onClick={() => setSelectedPreset("right")}
              className={`flex h-8 items-center justify-center rounded border transition-colors ${
                selectedPreset === "right"
                  ? "border-primary bg-primary/20 text-foreground"
                  : "border-border bg-surface-dim text-muted-foreground hover:text-foreground"
              }`}
              title="Align Bottom Right"
            >
              <AlignRight className="size-4" />
            </button>

            <button
              type="button"
              onClick={() => setSelectedPreset("full")}
              className={`flex h-8 items-center justify-center rounded border transition-colors ${
                selectedPreset === "full"
                  ? "border-primary bg-primary/20 text-foreground"
                  : "border-border bg-surface-dim text-muted-foreground hover:text-foreground"
              }`}
              title="Full Screen"
            >
              <Maximize2 className="size-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Section 2: Appearance */}
      <div className="flex flex-col gap-3 pt-2 border-t border-border">
        <div className="flex items-center gap-2 text-xs font-semibold text-subtle-foreground uppercase tracking-wider font-label">
          <Sparkles className="size-4 text-tertiary" />
          <span>Appearance</span>
        </div>

        <div className="flex items-center justify-between">
          <label htmlFor="inspector-radius" className="text-xs font-medium text-subtle-foreground">
            Corner Radius
          </label>
          <Input
            id="inspector-radius"
            value={cornerRadius}
            onChange={(e) => setCornerRadius(e.target.value)}
            className="w-20 border-border bg-background text-xs font-mono text-foreground text-center"
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-subtle-foreground">Border</span>
          <Switch checked={borderEnabled} onCheckedChange={setBorderEnabled} />
        </div>
      </div>

      {/* Section 3: Audio */}
      <div className="flex flex-col gap-3 pt-2 border-t border-border">
        <div className="flex items-center gap-2 text-xs font-semibold text-subtle-foreground uppercase tracking-wider font-label">
          <Volume2 className="size-4 text-track-screen" />
          <span>Audio</span>
        </div>

        <div className="flex items-center justify-between text-xs text-subtle-foreground">
          <span>Volume</span>
          <span className="font-mono text-foreground">0 dB</span>
        </div>

        <Slider value={volume} onValueChange={setVolume} max={100} step={1} className="my-1" />
      </div>
    </aside>
  )
}
