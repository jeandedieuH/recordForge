import { useState } from "react"
import type { CanvasAspectRatio } from "@recordforge/contracts"
import {
  createUpdateCanvasCommand,
  getBackgroundKind,
  type BackgroundKind,
} from "@recordforge/editor-core"
import {
  Button,
  Input,
  Slider,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@recordforge/ui"
import {
  LayoutTemplate,
  Palette,
  RotateCcw,
  Sparkles,
  Square,
  Image as ImageIcon,
} from "lucide-react"
import { useTimelineStore } from "../../../stores/timeline-store"
import { AspectRatioSelector } from "./layout/aspect-ratio-selector"
import { SolidBackgroundPicker } from "./layout/solid-background-picker"
import { GradientBackgroundPicker } from "./layout/gradient-background-picker"
import { ImageBackgroundPicker } from "./layout/image-background-picker"
import { ShadowControls } from "./layout/shadow-controls"

const PADDING_PRESETS = [0, 24, 48, 64, 96]
const RADIUS_PRESETS = [
  { value: 0, label: "0" },
  { value: 12, label: "12" },
  { value: 24, label: "24" },
  { value: 36, label: "36" },
  { value: 48, label: "48" },
]

export function LayoutPanel() {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)

  const currentBackground = timeline?.canvas.background ?? "#070b14"
  const detectedKind = getBackgroundKind(currentBackground)
  const [activeBgTab, setActiveBgTab] = useState<BackgroundKind>(detectedKind)

  if (!timeline) {
    return (
      <div className="flex h-full flex-col gap-3 p-3">
        <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
          <LayoutTemplate className="size-4 text-primary" aria-hidden />
          <h2>Canvas Layout</h2>
        </div>
        <p className="text-[11px] text-subtle-foreground">No timeline loaded.</p>
      </div>
    )
  }

  const canvas = timeline.canvas

  const handleAspectRatioChange = (option: {
    value: CanvasAspectRatio
    width: number
    height: number
  }) => {
    if (option.value === "custom") {
      execute(createUpdateCanvasCommand({ aspectRatio: "custom" }))
    } else {
      execute(
        createUpdateCanvasCommand({
          aspectRatio: option.value,
          width: option.width,
          height: option.height,
        }),
      )
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3 pr-2">
      {/* Panel Header */}
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <LayoutTemplate className="size-4 text-primary" aria-hidden />
          <h2>Canvas Layout</h2>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {canvas.width} × {canvas.height}
        </span>
      </div>

      {/* Aspect Ratio Framing */}
      <div className="flex flex-col gap-2">
        <label className="text-xs font-semibold text-foreground">Aspect Ratio & Framing</label>
        <AspectRatioSelector
          value={canvas.aspectRatio ?? "16:9"}
          onChange={handleAspectRatioChange}
        />
      </div>

      {/* Dimensions & Insets */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-dim/40 p-3">
        {/* Custom Width & Height */}
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
            <span>Width (px)</span>
            <Input
              type="number"
              min={320}
              max={7680}
              value={canvas.width}
              onChange={(e) =>
                execute(
                  createUpdateCanvasCommand({
                    width: Math.max(1, Number(e.target.value) || 1920),
                    aspectRatio: "custom",
                  }),
                )
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
            <span>Height (px)</span>
            <Input
              type="number"
              min={240}
              max={4320}
              value={canvas.height}
              onChange={(e) =>
                execute(
                  createUpdateCanvasCommand({
                    height: Math.max(1, Number(e.target.value) || 1080),
                    aspectRatio: "custom",
                  }),
                )
              }
            />
          </label>
        </div>

        {/* Canvas Padding */}
        <div className="flex flex-col gap-1.5 pt-1">
          <div className="flex items-center justify-between text-[11px] text-subtle-foreground">
            <span>Canvas Padding</span>
            <span className="font-mono text-[10px] text-foreground">{canvas.padding}px</span>
          </div>
          <Slider
            value={[canvas.padding]}
            min={0}
            max={160}
            step={4}
            onValueChange={([val]) =>
              val !== undefined && execute(createUpdateCanvasCommand({ padding: val }))
            }
          />
          <div className="flex items-center justify-between gap-1 pt-0.5">
            {PADDING_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => execute(createUpdateCanvasCommand({ padding: p }))}
                className={cn(
                  "flex-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors",
                  canvas.padding === p
                    ? "bg-primary text-primary-foreground"
                    : "bg-surface text-subtle-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                {p}px
              </button>
            ))}
          </div>
        </div>

        {/* Corner Radius */}
        <div className="flex flex-col gap-1.5 pt-1">
          <div className="flex items-center justify-between text-[11px] text-subtle-foreground">
            <span>Corner Radius</span>
            <span className="font-mono text-[10px] text-foreground">{canvas.borderRadius}px</span>
          </div>
          <Slider
            value={[canvas.borderRadius]}
            min={0}
            max={64}
            step={2}
            onValueChange={([val]) =>
              val !== undefined && execute(createUpdateCanvasCommand({ borderRadius: val }))
            }
          />
          <div className="flex items-center justify-between gap-1 pt-0.5">
            {RADIUS_PRESETS.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() => execute(createUpdateCanvasCommand({ borderRadius: r.value }))}
                className={cn(
                  "flex-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors",
                  canvas.borderRadius === r.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-surface text-subtle-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Background Studio */}
      <div className="flex flex-col gap-2.5">
        <label className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Palette className="size-3.5 text-primary" aria-hidden />
          <span>Canvas Background</span>
        </label>

        <Tabs
          value={activeBgTab}
          onValueChange={(val) => setActiveBgTab(val as BackgroundKind)}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="solid" className="text-xs">
              <Square className="size-3 mr-1" aria-hidden />
              Solid
            </TabsTrigger>
            <TabsTrigger value="gradient" className="text-xs">
              <Sparkles className="size-3 mr-1 text-secondary" aria-hidden />
              Gradient
            </TabsTrigger>
            <TabsTrigger value="image" className="text-xs">
              <ImageIcon className="size-3 mr-1 text-primary" aria-hidden />
              Image
            </TabsTrigger>
          </TabsList>

          <TabsContent value="solid" className="mt-2.5">
            <SolidBackgroundPicker
              value={canvas.background}
              onChange={(bg) => execute(createUpdateCanvasCommand({ background: bg }))}
            />
          </TabsContent>

          <TabsContent value="gradient" className="mt-2.5">
            <GradientBackgroundPicker
              value={canvas.background}
              onChange={(grad) => execute(createUpdateCanvasCommand({ background: grad }))}
            />
          </TabsContent>

          <TabsContent value="image" className="mt-2.5">
            <ImageBackgroundPicker
              value={canvas.background}
              onChange={(imgSrc) => execute(createUpdateCanvasCommand({ background: imgSrc }))}
              backgroundBlur={canvas.backgroundBlur ?? 0}
              onBlurChange={(blur) => execute(createUpdateCanvasCommand({ backgroundBlur: blur }))}
              backgroundDim={canvas.backgroundDim ?? 0}
              onDimChange={(dim) => execute(createUpdateCanvasCommand({ backgroundDim: dim }))}
            />
          </TabsContent>
        </Tabs>
      </div>

      {/* Elevation & Shadow */}
      <ShadowControls
        canvas={canvas}
        onChange={(updates) => execute(createUpdateCanvasCommand(updates))}
      />

      {/* Footer Reset Action */}
      <div className="mt-auto flex flex-col gap-2 pt-2 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          className="w-full text-xs text-subtle-foreground hover:text-foreground"
          onClick={() =>
            execute(
              createUpdateCanvasCommand({
                width: 1920,
                height: 1080,
                padding: 0,
                borderRadius: 0,
                aspectRatio: "16:9",
                background: "#070b14",
                backgroundBlur: 0,
                backgroundDim: 0,
                shadow: false,
              }),
            )
          }
        >
          <RotateCcw className="size-3.5 mr-1" aria-hidden />
          Reset Canvas to 1080p
        </Button>
      </div>
    </div>
  )
}
