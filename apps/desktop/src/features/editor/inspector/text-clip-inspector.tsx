import { useMemo, useState } from "react"
import type {
  TextClip,
  TextBackdropStyle,
  TitlePresetCategory,
  OverlayEasing,
} from "@recordforge/contracts"
import {
  applyTextPresetToClip,
  getTextPresetById,
  listTextPresetsByCategory,
  textPresetFromClip,
  textPresetToDefinition,
  type TextPresetRecord,
} from "@recordforge/editor-core"
import {
  Button,
  ColorPicker,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
  cn,
  useToast,
} from "@recordforge/ui"
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Eye,
  FolderOpen,
  Lock,
  RotateCcw,
  Save,
  Type,
} from "lucide-react"
import { DebouncedSlider, InspectorSection, NumberField } from "./fields"
import { useTextPresetRegistry } from "../presets/preset-store"
import { PresetBrowser, type BrowserPreset } from "../panels/preset-browser"
import { SavePresetDialog, type SavePresetFormData } from "../presets/save-preset-dialog"
import { useTimelineStore } from "../../../stores/timeline-store"

interface TextClipInspectorProps {
  clip: TextClip
  onChange: (update: Partial<TextClip>) => void
}

export function TextClipInspector({ clip, onChange }: TextClipInspectorProps) {
  const { registry, snapshot } = useTextPresetRegistry()
  const { toast } = useToast()
  const [browserOpen, setBrowserOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)

  const canvasWidth = useTimelineStore(
    (state) => state.engine?.history.present.canvas.width ?? 1920,
  )
  const canvasHeight = useTimelineStore(
    (state) => state.engine?.history.present.canvas.height ?? 1080,
  )

  const activePresetName = useMemo(() => {
    const preset = registry.getPresetById(clip.presetId)
    return preset?.name ?? clip.presetId
  }, [registry, clip.presetId])

  const categoryPresets = useMemo(() => {
    return listTextPresetsByCategory(clip.category)
  }, [clip.category])

  function handleApplyPreset(preset: BrowserPreset) {
    const definition = textPresetToDefinition(preset as TextPresetRecord)
    const updated = applyTextPresetToClip(clip, definition)
    onChange({
      ...updated,
      primaryText: clip.primaryText,
      secondaryText: clip.secondaryText,
      tagText: clip.tagText,
    })
  }

  function handleQuickSwitchPreset(presetId: string) {
    const definition = getTextPresetById(presetId)
    const updated = applyTextPresetToClip(clip, definition)
    onChange({
      ...updated,
      primaryText: clip.primaryText,
      secondaryText: clip.secondaryText,
      tagText: clip.tagText,
    })
  }

  function handleResetDimensions() {
    const defaultDef = getTextPresetById(clip.presetId)
    onChange({
      width: defaultDef.width,
      height: defaultDef.height,
      fontSize: defaultDef.fontSize,
      backdropPaddingX: defaultDef.backdropPaddingX,
      backdropPaddingY: defaultDef.backdropPaddingY,
      backdropBorderRadius: defaultDef.backdropBorderRadius,
    })
    toast({ title: "Dimensions reset", description: "Reset layout properties to preset defaults." })
  }

  function handleAlignToCanvas(position: "center" | "lower-third" | "top-left" | "top-right" | "bottom-left" | "bottom-right") {
    let targetX = clip.x
    let targetY = clip.y
    const pad = 60

    if (position === "center") {
      targetX = Math.round((canvasWidth - clip.width) / 2)
      targetY = Math.round((canvasHeight - clip.height) / 2)
    } else if (position === "lower-third") {
      targetX = Math.round((canvasWidth - clip.width) / 2)
      targetY = Math.round(canvasHeight - clip.height - 90)
    } else if (position === "top-left") {
      targetX = pad
      targetY = pad
    } else if (position === "top-right") {
      targetX = canvasWidth - clip.width - pad
      targetY = pad
    } else if (position === "bottom-left") {
      targetX = pad
      targetY = canvasHeight - clip.height - pad
    } else if (position === "bottom-right") {
      targetX = canvasWidth - clip.width - pad
      targetY = canvasHeight - clip.height - pad
    }

    onChange({
      x: Math.max(0, targetX),
      y: Math.max(0, targetY),
    })
  }

  async function handleSavePreset(data: SavePresetFormData) {
    const record = textPresetFromClip(clip, {
      name: data.name,
      description: data.description,
      category: data.category as TitlePresetCategory,
      tags: data.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    })
    try {
      await registry.saveCustomPreset(record)
      toast({ title: "Preset saved", description: `${data.name} is now in your library.` })
    } catch (error) {
      toast({
        title: "Could not save preset",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "error",
      })
    }
  }

  return (
    <div className="flex flex-col gap-4 p-3 text-xs">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-warning/15 text-warning">
            <Type className="size-4" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-semibold capitalize text-foreground">
              {clip.category.replace("-", " ")}
            </h3>
            <p className="text-[10px] text-muted-foreground">{activePresetName}</p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={cn("size-7 p-0", clip.enabled === false && "text-muted-foreground")}
            onClick={() => onChange({ enabled: clip.enabled === false ? true : false })}
            title={clip.enabled === false ? "Enable title" : "Disable title"}
          >
            <Eye className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("size-7 p-0", clip.locked && "text-primary")}
            onClick={() => onChange({ locked: !clip.locked })}
            title={clip.locked ? "Unlock position" : "Lock position"}
          >
            <Lock className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      {/* Preset Controls */}
      <InspectorSection title="Style Preset & Theme">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-dim px-2.5 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
              Active Preset
            </span>
            <span
              className="truncate text-xs font-medium text-foreground text-right"
              title={activePresetName}
            >
              {activePresetName}
            </span>
          </div>

          {/* Quick Preset Selector Chips */}
          <div className="flex flex-wrap gap-1">
            {categoryPresets.slice(0, 6).map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleQuickSwitchPreset(preset.id)}
                className={cn(
                  "rounded px-2 py-1 text-[10px] font-medium transition-colors",
                  clip.presetId === preset.id
                    ? "bg-primary/20 text-primary border border-primary/40 font-semibold"
                    : "bg-surface-dim text-muted-foreground hover:bg-surface-container hover:text-foreground border border-border/60",
                )}
                title={preset.description}
              >
                {preset.name}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 mt-0.5">
            <Button
              variant="secondary"
              size="sm"
              className="h-7 gap-1.5 text-xs justify-center"
              onClick={() => setBrowserOpen(true)}
            >
              <FolderOpen className="size-3.5" aria-hidden />
              Browse Library
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs justify-center"
              onClick={() => setSaveOpen(true)}
            >
              <Save className="size-3.5" aria-hidden />
              Save As Preset
            </Button>
          </div>
        </div>
      </InspectorSection>

      <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
        <DialogContent className="flex max-h-[min(760px,90vh)] max-w-3xl flex-col gap-3 overflow-hidden p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Type className="size-4 text-warning" aria-hidden />
              Browse title presets
            </DialogTitle>
          </DialogHeader>
          <PresetBrowser
            kind="text"
            selectedPresetId={clip.presetId}
            onSelect={(preset) => {
              handleApplyPreset(preset)
              setBrowserOpen(false)
            }}
          />
        </DialogContent>
      </Dialog>

      <SavePresetDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        defaultCategory={clip.category}
        categories={snapshot.categories}
        onSave={handleSavePreset}
      />

      {/* Quick Placement */}
      <InspectorSection title="Quick Alignment">
        <div className="grid grid-cols-3 gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-1"
            onClick={() => handleAlignToCanvas("center")}
          >
            🎯 Center
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-1"
            onClick={() => handleAlignToCanvas("lower-third")}
          >
            ⬇️ Lower Third
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-1"
            onClick={() => handleAlignToCanvas("top-left")}
          >
            ↖️ Top Left
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-1"
            onClick={() => handleAlignToCanvas("top-right")}
          >
            ↗️ Top Right
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-1"
            onClick={() => handleAlignToCanvas("bottom-left")}
          >
            ↙️ Bottom Left
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-1"
            onClick={() => handleAlignToCanvas("bottom-right")}
          >
            ↘️ Bottom Right
          </Button>
        </div>
      </InspectorSection>

      {/* Text Content */}
      <InspectorSection title="Text Content">
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          <span>Primary Title</span>
          <Textarea
            value={clip.primaryText}
            onChange={(e) => onChange({ primaryText: e.target.value })}
            placeholder="Main Title..."
            rows={2}
            className="min-h-14 text-xs font-bold resize-y"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          <span>Subtitle / Description</span>
          <Textarea
            value={clip.secondaryText ?? ""}
            onChange={(e) => onChange({ secondaryText: e.target.value })}
            placeholder="Subtitle text (optional)..."
            rows={2}
            className="min-h-14 text-xs resize-y"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          <span>Tag / Category Badge</span>
          <Input
            type="text"
            value={clip.tagText ?? ""}
            onChange={(e) => onChange({ tagText: e.target.value })}
            placeholder="Tag / Topic badge (optional)..."
            className="h-8 text-xs uppercase font-semibold"
          />
        </label>
      </InspectorSection>

      {/* Typography */}
      <InspectorSection title="Typography">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
              Font Family
            </label>
            <Select
              value={
                clip.fontFamily === "inter"
                  ? "sans"
                  : clip.fontFamily === "outfit"
                    ? "heading"
                    : clip.fontFamily || "sans"
              }
              onValueChange={(val) => onChange({ fontFamily: val as any })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Font family" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sans">Inter (Modern Sans)</SelectItem>
                <SelectItem value="heading">Outfit (Bold Display)</SelectItem>
                <SelectItem value="serif">Source Serif (Editorial)</SelectItem>
                <SelectItem value="mono">JetBrains Mono (Code)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="w-full">
            <NumberField
              label="Font Size"
              value={clip.fontSize}
              onChange={(val) => onChange({ fontSize: Math.max(12, val) })}
              min={12}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 mt-1">
          <div className="flex-1">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
              Weight
            </label>
            <Select
              value={String(clip.fontWeight ?? "700")}
              onValueChange={(val) => onChange({ fontWeight: val as any })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="400">Regular (400)</SelectItem>
                <SelectItem value="500">Medium (500)</SelectItem>
                <SelectItem value="600">Semibold (600)</SelectItem>
                <SelectItem value="700">Bold (700)</SelectItem>
                <SelectItem value="800">Extra Bold (800)</SelectItem>
                <SelectItem value="900">Black (900)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
              Align
            </label>
            <ToggleGroup
              type="single"
              value={clip.alignment}
              onValueChange={(val) => val && onChange({ alignment: val as any })}
              className="bg-surface-dim p-0.5 rounded-lg border border-border"
            >
              <ToggleGroupItem value="left" className="size-7 p-0">
                <AlignLeft className="size-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem value="center" className="size-7 p-0">
                <AlignCenter className="size-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem value="right" className="size-7 p-0">
                <AlignRight className="size-3.5" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
          <div className="flex flex-col">
            <span className="text-xs font-medium text-foreground">Auto-Scale to Box</span>
            <span className="text-[10px] text-muted-foreground">Scale text on overflow</span>
          </div>
          <Switch
            checked={clip.autoScaleText ?? true}
            onCheckedChange={(autoScaleText) => onChange({ autoScaleText })}
          />
        </div>
      </InspectorSection>

      {/* Colors & Backdrop Styling */}
      <InspectorSection title="Colors & Backdrop">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">Title Color</span>
            <ColorPicker
              aria-label="Title color"
              size="sm"
              value={clip.textColor}
              onChange={(textColor) => onChange({ textColor })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">Subtitle Color</span>
            <ColorPicker
              aria-label="Subtitle color"
              size="sm"
              value={clip.secondaryTextColor ?? "#94a3b8"}
              onChange={(secondaryTextColor) => onChange({ secondaryTextColor })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">Accent / Tag Color</span>
            <ColorPicker
              aria-label="Accent color"
              size="sm"
              value={clip.accentColor}
              onChange={(accentColor) => onChange({ accentColor })}
            />
          </div>
        </div>

        <div className="mt-2 pt-2 border-t border-border/50">
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
            Backdrop Style
          </label>
          <Select
            value={clip.backdropStyle}
            onValueChange={(val) => onChange({ backdropStyle: val as TextBackdropStyle })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None (Transparent)</SelectItem>
              <SelectItem value="glass">Glassmorphic Blur</SelectItem>
              <SelectItem value="solid">Solid Card</SelectItem>
              <SelectItem value="accent-bar">Left Accent Bar</SelectItem>
              <SelectItem value="pill">Pill Badge</SelectItem>
              <SelectItem value="gradient">Gradient Banner</SelectItem>
              <SelectItem value="outline">Subtle Outline</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {clip.backdropStyle !== "none" && (
          <div className="space-y-2.5 mt-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">Backdrop Color</span>
              <ColorPicker
                aria-label="Backdrop color"
                size="sm"
                value={clip.backdropColor}
                onChange={(backdropColor) => onChange({ backdropColor })}
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Backdrop Opacity</span>
                <span>{Math.round(clip.backdropOpacity * 100)}%</span>
              </div>
              <DebouncedSlider
                min={0}
                max={1}
                step={0.05}
                value={[clip.backdropOpacity]}
                onValueCommit={([val]) => onChange({ backdropOpacity: val })}
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Corner Radius</span>
                <span>{clip.backdropBorderRadius}px</span>
              </div>
              <DebouncedSlider
                min={0}
                max={48}
                step={2}
                value={[clip.backdropBorderRadius]}
                onValueCommit={([val]) => onChange({ backdropBorderRadius: val })}
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Padding X / Y</span>
                <span>
                  {clip.backdropPaddingX}px / {clip.backdropPaddingY}px
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <DebouncedSlider
                  min={4}
                  max={64}
                  step={2}
                  value={[clip.backdropPaddingX]}
                  onValueCommit={([val]) => onChange({ backdropPaddingX: val })}
                />
                <DebouncedSlider
                  min={4}
                  max={48}
                  step={2}
                  value={[clip.backdropPaddingY]}
                  onValueCommit={([val]) => onChange({ backdropPaddingY: val })}
                />
              </div>
            </div>
          </div>
        )}
      </InspectorSection>

      {/* Shadow & Glow */}
      <InspectorSection title="Shadow & Ambient Glow">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-foreground">Drop Shadow / Glow</span>
          <Switch
            checked={clip.shadowEnabled ?? true}
            onCheckedChange={(checked) => onChange({ shadowEnabled: checked })}
          />
        </div>

        {clip.shadowEnabled && (
          <div className="space-y-2 mt-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">Shadow Color</span>
              <ColorPicker
                aria-label="Shadow color"
                size="sm"
                value={clip.shadowColor ?? "rgba(0,0,0,0.6)"}
                onChange={(shadowColor) => onChange({ shadowColor })}
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Shadow Blur</span>
                <span>{clip.shadowBlur ?? 16}px</span>
              </div>
              <DebouncedSlider
                min={2}
                max={48}
                step={2}
                value={[clip.shadowBlur ?? 16]}
                onValueCommit={([val]) => onChange({ shadowBlur: val })}
              />
            </div>
          </div>
        )}
      </InspectorSection>

      {/* Animation */}
      <InspectorSection title="Motion & Animation">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
              Intro
            </label>
            <Select
              value={clip.animationIn ?? "slide-up"}
              onValueChange={(val) => onChange({ animationIn: val as any })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="fade">Fade</SelectItem>
                <SelectItem value="slide-up">Slide Up</SelectItem>
                <SelectItem value="slide-down">Slide Down</SelectItem>
                <SelectItem value="slide-left">Slide Left</SelectItem>
                <SelectItem value="slide-right">Slide Right</SelectItem>
                <SelectItem value="zoom-punch">Zoom Punch</SelectItem>
                <SelectItem value="expand-bar">Expand Bar</SelectItem>
                <SelectItem value="pop-in">Pop In</SelectItem>
                <SelectItem value="bounce">Bounce</SelectItem>
                <SelectItem value="typewriter">Typewriter</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
              Outro
            </label>
            <Select
              value={clip.animationOut ?? "fade"}
              onValueChange={(val) => onChange({ animationOut: val as any })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="fade">Fade</SelectItem>
                <SelectItem value="slide-down">Slide Down</SelectItem>
                <SelectItem value="slide-up">Slide Up</SelectItem>
                <SelectItem value="slide-left">Slide Left</SelectItem>
                <SelectItem value="slide-right">Slide Right</SelectItem>
                <SelectItem value="zoom-punch">Zoom Punch</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 mt-2">
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>In Duration</span>
              <span>{clip.overlayAnimation?.inDurationMs ?? 350}ms</span>
            </div>
            <DebouncedSlider
              min={100}
              max={1500}
              step={50}
              value={[clip.overlayAnimation?.inDurationMs ?? 350]}
              onValueCommit={([val]) =>
                onChange({
                  overlayAnimation: {
                    ...clip.overlayAnimation,
                    inDurationMs: val,
                  },
                })
              }
            />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Out Duration</span>
              <span>{clip.overlayAnimation?.outDurationMs ?? 350}ms</span>
            </div>
            <DebouncedSlider
              min={100}
              max={1500}
              step={50}
              value={[clip.overlayAnimation?.outDurationMs ?? 350]}
              onValueCommit={([val]) =>
                onChange({
                  overlayAnimation: {
                    ...clip.overlayAnimation,
                    outDurationMs: val,
                  },
                })
              }
            />
          </div>
        </div>

        <div className="mt-2">
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
            Motion Easing Curve
          </label>
          <Select
            value={clip.overlayAnimation?.easing ?? "expo-out"}
            onValueChange={(val) =>
              onChange({
                overlayAnimation: {
                  ...clip.overlayAnimation,
                  easing: val as OverlayEasing,
                },
              })
            }
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="expo-out">Expo Out (Snappy Finish)</SelectItem>
              <SelectItem value="ease-out">Ease Out (Smooth Decel)</SelectItem>
              <SelectItem value="ease-in-out">Ease In Out (Natural)</SelectItem>
              <SelectItem value="ease-in">Ease In (Accelerate)</SelectItem>
              <SelectItem value="linear">Linear (Constant Speed)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </InspectorSection>

      {/* Transform & Geometry */}
      <InspectorSection title="Dimensions & Geometry">
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="X Position"
            value={Math.round(clip.x)}
            onChange={(val) => onChange({ x: val })}
          />
          <NumberField
            label="Y Position"
            value={Math.round(clip.y)}
            onChange={(val) => onChange({ y: val })}
          />
          <NumberField
            label="Width"
            value={Math.round(clip.width)}
            onChange={(val) => onChange({ width: Math.max(50, val) })}
            min={50}
          />
          <NumberField
            label="Height"
            value={Math.round(clip.height)}
            onChange={(val) => onChange({ height: Math.max(30, val) })}
            min={30}
          />
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground hover:text-foreground justify-center gap-1.5 mt-1"
          onClick={handleResetDimensions}
        >
          <RotateCcw className="size-3" aria-hidden />
          Reset to Preset Dimensions
        </Button>
      </InspectorSection>
    </div>
  )
}
