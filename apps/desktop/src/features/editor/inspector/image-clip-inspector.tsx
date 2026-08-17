import type { ImageClip, ImageFit } from "@recordforge/contracts"
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
} from "@recordforge/ui"
import { Eye, Image as ImageIcon, Lock } from "lucide-react"
import { DebouncedSlider, InspectorSection, NumberField } from "./fields"

interface ImageClipInspectorProps {
  clip: ImageClip
  onChange: (update: Partial<ImageClip>) => void
}

export function ImageClipInspector({ clip, onChange }: ImageClipInspectorProps) {
  return (
    <div className="flex flex-col gap-4 p-3 text-xs">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-info/15 text-info">
            <ImageIcon className="size-4" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Image Overlay</h3>
            <p className="text-[10px] text-muted-foreground">{clip.assetId}</p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={cn("size-7 p-0", clip.enabled === false && "text-muted-foreground")}
            onClick={() => onChange({ enabled: clip.enabled === false ? true : false })}
            title={clip.enabled === false ? "Enable image" : "Disable image"}
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

      {/* Appearance & Sizing */}
      <InspectorSection title="Appearance">
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
            Fit Mode
          </label>
          <Select value={clip.fit} onValueChange={(val) => onChange({ fit: val as ImageFit })}>
            <SelectTrigger className="h-8 text-xs bg-surface-dim">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="contain">Contain (Preserve aspect ratio)</SelectItem>
              <SelectItem value="cover">Cover (Fill bounds)</SelectItem>
              <SelectItem value="fill">Fill (Stretch to fit)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5 mt-2">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Opacity</span>
            <span>{Math.round(clip.opacity * 100)}%</span>
          </div>
          <DebouncedSlider
            min={0}
            max={1}
            step={0.05}
            value={[clip.opacity]}
            onValueCommit={([val]) => onChange({ opacity: val })}
          />
        </div>

        <div className="space-y-1.5 mt-2">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Corner Radius</span>
            <span>{clip.borderRadius}px</span>
          </div>
          <DebouncedSlider
            min={0}
            max={48}
            step={2}
            value={[clip.borderRadius]}
            onValueCommit={([val]) => onChange({ borderRadius: val })}
          />
        </div>
      </InspectorSection>

      {/* Border & Outline */}
      <InspectorSection title="Border & Outline">
        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Border Width</span>
            <span>{clip.borderWidth}px</span>
          </div>
          <DebouncedSlider
            min={0}
            max={16}
            step={1}
            value={[clip.borderWidth]}
            onValueCommit={([val]) => onChange({ borderWidth: val })}
          />
        </div>

        {clip.borderWidth > 0 && (
          <div className="flex items-center gap-2 mt-2">
            <Input
              type="color"
              value={clip.borderColor}
              onChange={(e) => onChange({ borderColor: e.target.value })}
              className="size-8 p-0.5 rounded cursor-pointer"
            />
            <Input
              type="text"
              value={clip.borderColor}
              onChange={(e) => onChange({ borderColor: e.target.value })}
              className="h-8 font-mono text-xs"
            />
          </div>
        )}
      </InspectorSection>

      {/* Shadow */}
      <InspectorSection title="Shadow">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-foreground">Drop Shadow</span>
          <Switch
            checked={clip.shadowEnabled ?? false}
            onCheckedChange={(checked) => onChange({ shadowEnabled: checked })}
          />
        </div>

        {clip.shadowEnabled && (
          <div className="space-y-1.5 mt-2">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Shadow Blur</span>
              <span>{clip.shadowBlur ?? 12}px</span>
            </div>
            <DebouncedSlider
              min={2}
              max={36}
              step={2}
              value={[clip.shadowBlur ?? 12]}
              onValueCommit={([val]) => onChange({ shadowBlur: val })}
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
              value={clip.animationIn ?? "fade"}
              onValueChange={(val) => onChange({ animationIn: val as any })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="fade">Fade</SelectItem>
                <SelectItem value="scale-up">Pop Scale</SelectItem>
                <SelectItem value="slide-up">Slide Up</SelectItem>
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
                <SelectItem value="scale-down">Shrink Scale</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </InspectorSection>

      {/* Transform & Geometry */}
      <InspectorSection title="Transform">
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
            onChange={(val) => onChange({ width: Math.max(20, val) })}
            min={20}
          />
          <NumberField
            label="Height"
            value={Math.round(clip.height)}
            onChange={(val) => onChange({ height: Math.max(20, val) })}
            min={20}
          />
        </div>
      </InspectorSection>
    </div>
  )
}
