import type { TextClip, TextBackdropStyle } from "@recordforge/contracts"
import { applyPresetToTextClip, TEXT_PRESETS } from "@recordforge/editor-core"
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  cn,
} from "@recordforge/ui"
import { AlignCenter, AlignLeft, AlignRight, Eye, Lock, Type } from "lucide-react"
import { InspectorSection, NumberField } from "./fields"

interface TextClipInspectorProps {
  clip: TextClip
  onChange: (update: Partial<TextClip>) => void
}

export function TextClipInspector({ clip, onChange }: TextClipInspectorProps) {
  function handlePresetChange(presetId: string) {
    const updated = applyPresetToTextClip(clip, presetId)
    onChange(updated)
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
            <p className="text-[10px] text-muted-foreground">{clip.presetId}</p>
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

      {/* Preset Swapper */}
      <InspectorSection title="Style Preset">
        <Select value={clip.presetId} onValueChange={handlePresetChange}>
          <SelectTrigger className="h-8 text-xs bg-surface-dim">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            {TEXT_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id} className="text-xs">
                {preset.name} ({preset.category})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InspectorSection>

      {/* Text Content */}
      <InspectorSection title="Text Content">
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          <span>Primary Title</span>
          <Input
            type="text"
            value={clip.primaryText}
            onChange={(e) => onChange({ primaryText: e.target.value })}
            placeholder="Main Title..."
            className="h-8 text-xs font-bold"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          <span>Subtitle / Description</span>
          <Input
            type="text"
            value={clip.secondaryText ?? ""}
            onChange={(e) => onChange({ secondaryText: e.target.value })}
            placeholder="Subtitle text (optional)..."
            className="h-8 text-xs"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          <span>Tag / Category Badge</span>
          <Input
            type="text"
            value={clip.tagText ?? ""}
            onChange={(e) => onChange({ tagText: e.target.value })}
            placeholder="Tag / Topic badge (optional)..."
            className="h-8 text-xs uppercase"
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
              value={clip.fontFamily}
              onValueChange={(val) => onChange({ fontFamily: val as any })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sans">Inter (Modern Sans)</SelectItem>
                <SelectItem value="serif">Noto Serif (Editorial)</SelectItem>
                <SelectItem value="mono">Cascadia (Code Mono)</SelectItem>
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
              value={clip.fontWeight}
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
      </InspectorSection>

      {/* Colors & Backdrop Styling */}
      <InspectorSection title="Colors & Backdrop">
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1 items-center">
            <span className="text-[10px] text-muted-foreground">Title Color</span>
            <Input
              type="color"
              value={clip.textColor}
              onChange={(e) => onChange({ textColor: e.target.value })}
              className="size-8 p-0.5 rounded cursor-pointer"
            />
          </div>

          <div className="flex flex-col gap-1 items-center">
            <span className="text-[10px] text-muted-foreground">Subtitle Color</span>
            <Input
              type="color"
              value={clip.secondaryTextColor ?? "#94a3b8"}
              onChange={(e) => onChange({ secondaryTextColor: e.target.value })}
              className="size-8 p-0.5 rounded cursor-pointer"
            />
          </div>

          <div className="flex flex-col gap-1 items-center">
            <span className="text-[10px] text-muted-foreground">Accent Bar</span>
            <Input
              type="color"
              value={clip.accentColor}
              onChange={(e) => onChange({ accentColor: e.target.value })}
              className="size-8 p-0.5 rounded cursor-pointer"
            />
          </div>
        </div>

        <div className="mt-2">
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
          <div className="space-y-2 mt-2">
            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Backdrop Opacity</span>
                <span>{Math.round(clip.backdropOpacity * 100)}%</span>
              </div>
              <Slider
                min={0}
                max={1}
                step={0.05}
                value={[clip.backdropOpacity]}
                onValueChange={([val]) => onChange({ backdropOpacity: val })}
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Corner Radius</span>
                <span>{clip.backdropBorderRadius}px</span>
              </div>
              <Slider
                min={0}
                max={32}
                step={2}
                value={[clip.backdropBorderRadius]}
                onValueChange={([val]) => onChange({ backdropBorderRadius: val })}
              />
            </div>
          </div>
        )}
      </InspectorSection>

      {/* Shadow & Glow */}
      <InspectorSection title="Shadow & Glow">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-foreground">Drop Shadow</span>
          <Switch
            checked={clip.shadowEnabled ?? true}
            onCheckedChange={(checked) => onChange({ shadowEnabled: checked })}
          />
        </div>

        {clip.shadowEnabled && (
          <div className="space-y-1.5 mt-1">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Shadow Blur</span>
              <span>{clip.shadowBlur ?? 16}px</span>
            </div>
            <Slider
              min={2}
              max={40}
              step={2}
              value={[clip.shadowBlur ?? 16]}
              onValueChange={([val]) => onChange({ shadowBlur: val })}
            />
          </div>
        )}
      </InspectorSection>

      {/* Animation */}
      <InspectorSection title="Animation">
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
                <SelectItem value="typewriter">Typewriter</SelectItem>
                <SelectItem value="zoom-punch">Zoom Punch</SelectItem>
                <SelectItem value="expand-bar">Expand Bar</SelectItem>
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
              </SelectContent>
            </Select>
          </div>
        </div>
      </InspectorSection>

      {/* Transform & Geometry */}
      <InspectorSection title="Position & Dimensions">
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="X Pos"
            value={Math.round(clip.x)}
            onChange={(val) => onChange({ x: val })}
          />
          <NumberField
            label="Y Pos"
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
      </InspectorSection>
    </div>
  )
}
