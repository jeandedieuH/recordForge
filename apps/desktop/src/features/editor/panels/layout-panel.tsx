import { useState } from "react"
import type { CanvasAspectRatio } from "@recordforge/contracts"
import {
  DEFAULT_CANVAS_BACKGROUND,
  createUpdateCanvasCommand,
  getBackgroundKind,
  type BackgroundKind,
} from "@recordforge/editor-core"
import {
  Button,
  Skeleton,
  Slider,
  SliderField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@recordforge/ui"
import {
  LayoutTemplate,
  MoveVertical,
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
  const isLoading = useTimelineStore((state) => state.isLoading)

  const currentBackground = timeline?.canvas.background ?? DEFAULT_CANVAS_BACKGROUND
  const detectedKind = getBackgroundKind(currentBackground)
  const [activeBgTab, setActiveBgTab] = useState<BackgroundKind>(detectedKind)

  if (isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3">
        <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
          <LayoutTemplate className="size-4 text-primary" aria-hidden />
          <h2>Canvas Layout</h2>
        </div>

        {/* Aspect Ratio Skeleton */}
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-20 rounded" />
          <div className="grid grid-cols-3 gap-1.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-7 rounded-md" />
            ))}
          </div>
        </div>

        {/* Padding / Radius Presets Skeleton */}
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-16 rounded" />
          <div className="flex gap-1.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-7 flex-1 rounded-md" />
            ))}
          </div>
        </div>

        {/* Background Picker Skeleton */}
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-24 rounded" />
          <Skeleton className="h-8 w-full rounded-md" />
          <div className="grid grid-cols-4 gap-2 pt-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (!timeline) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
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
    execute(
      createUpdateCanvasCommand({
        aspectRatio: option.value,
        width: option.width,
        height: option.height,
      }),
    )
  }

  const isCustomYRatio = canvas.aspectRatio && canvas.aspectRatio !== "16:9"

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3 pr-2">
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

      {/* Video Positioning along Y (for non-16:9 ratios) */}
      {isCustomYRatio && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-dim/40 p-3">
          <div className="flex items-center justify-between text-xs font-semibold text-foreground">
            <span className="flex items-center gap-1.5">
              <MoveVertical className="size-3.5 text-primary" aria-hidden />
              <span>Video Position (Y)</span>
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {Math.round((canvas.videoPositionY ?? 0.5) * 100)}%
            </span>
          </div>
          <p className="text-[11px] text-subtle-foreground">
            Adjust vertical placement within the {canvas.aspectRatio} canvas.
          </p>
          <Slider
            value={[Math.round((canvas.videoPositionY ?? 0.5) * 100)]}
            min={0}
            max={100}
            step={1}
            onValueChange={([val]) =>
              val !== undefined && execute(createUpdateCanvasCommand({ videoPositionY: val / 100 }))
            }
          />
          <div className="flex items-center justify-between gap-1 pt-0.5">
            <button
              type="button"
              onClick={() => execute(createUpdateCanvasCommand({ videoPositionY: 0 }))}
              className={cn(
                "flex-1 rounded border px-2 py-1 text-[11px] font-medium transition-colors",
                (canvas.videoPositionY ?? 0.5) === 0
                  ? "border-primary/60 bg-primary/15 font-semibold text-primary shadow-xs"
                  : "border-border/60 bg-surface text-subtle-foreground hover:border-border hover:bg-surface-hover hover:text-foreground",
              )}
            >
              Top
            </button>
            <button
              type="button"
              onClick={() => execute(createUpdateCanvasCommand({ videoPositionY: 0.5 }))}
              className={cn(
                "flex-1 rounded border px-2 py-1 text-[11px] font-medium transition-colors",
                (canvas.videoPositionY ?? 0.5) === 0.5
                  ? "border-primary/60 bg-primary/15 font-semibold text-primary shadow-xs"
                  : "border-border/60 bg-surface text-subtle-foreground hover:border-border hover:bg-surface-hover hover:text-foreground",
              )}
            >
              Center
            </button>
            <button
              type="button"
              onClick={() => execute(createUpdateCanvasCommand({ videoPositionY: 1 }))}
              className={cn(
                "flex-1 rounded border px-2 py-1 text-[11px] font-medium transition-colors",
                (canvas.videoPositionY ?? 0.5) === 1
                  ? "border-primary/60 bg-primary/15 font-semibold text-primary shadow-xs"
                  : "border-border/60 bg-surface text-subtle-foreground hover:border-border hover:bg-surface-hover hover:text-foreground",
              )}
            >
              Bottom
            </button>
          </div>
        </div>
      )}

      {/* Dimensions & Insets */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-dim/40 p-3">
        {/* Canvas Padding */}
        <SliderField
          label="Canvas Padding"
          value={canvas.padding}
          min={0}
          max={160}
          step={4}
          unit="px"
          onValueChange={(val) => execute(createUpdateCanvasCommand({ padding: val }))}
          presets={PADDING_PRESETS.map((p) => ({ value: p, label: `${p}px` }))}
        />

        {/* Corner Radius */}
        <SliderField
          label="Corner Radius"
          value={canvas.borderRadius}
          min={0}
          max={64}
          step={2}
          unit="px"
          onValueChange={(val) => execute(createUpdateCanvasCommand({ borderRadius: val }))}
          presets={RADIUS_PRESETS.map((r) => ({ value: r.value, label: r.label }))}
        />
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
              backgroundFit={canvas.backgroundFit ?? "cover"}
              onFitChange={(fit) => execute(createUpdateCanvasCommand({ backgroundFit: fit }))}
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
                videoPositionY: 0.5,
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
