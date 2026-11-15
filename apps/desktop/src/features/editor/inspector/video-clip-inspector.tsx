import type { VideoClip, VideoLayoutMode } from "@recordforge/contracts"
import {
  Button,
  ColorPicker,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
} from "@recordforge/ui"
import { Eye, Film, Lock, Volume2, VolumeX } from "lucide-react"
import { DebouncedSlider, InspectorSection, NumberField } from "./fields"

interface VideoClipInspectorProps {
  clip: VideoClip
  onChange: (update: Partial<VideoClip>) => void
}

/**
 * B-roll / media-track video clip (#13). Layout mode, fit, animation and the
 * embedded audio mix all feed the render plan directly, so the preview and the
 * export stay in step.
 */
export function VideoClipInspector({ clip, onChange }: VideoClipInspectorProps) {
  return (
    <div className="flex flex-col gap-4 p-3 text-xs">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-info/15 text-info">
            <Film className="size-4" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Video clip</h3>
            <p className="text-[10px] text-muted-foreground">{clip.assetId}</p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={cn("size-7 p-0", clip.enabled === false && "text-muted-foreground")}
            onClick={() => onChange({ enabled: clip.enabled === false })}
            title={clip.enabled === false ? "Show video" : "Hide video"}
          >
            <Eye className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("size-7 p-0", clip.locked && "text-primary")}
            onClick={() => onChange({ locked: !clip.locked })}
            title={clip.locked ? "Unlock clip" : "Lock clip"}
          >
            <Lock className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      <InspectorSection title="Layout">
        <div>
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
            Placement
          </label>
          <Select
            value={clip.layoutMode}
            onValueChange={(value) => onChange({ layoutMode: value as VideoLayoutMode })}
          >
            <SelectTrigger className="h-8 bg-surface-dim text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="overlay">Overlay (on top of the screen)</SelectItem>
              <SelectItem value="fullscreen">Fullscreen (covers the screen)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="mt-2">
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
            Fit
          </label>
          <Select
            value={clip.fit}
            onValueChange={(value) => onChange({ fit: value as VideoClip["fit"] })}
          >
            <SelectTrigger className="h-8 bg-surface-dim text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="contain">Contain (preserve aspect ratio)</SelectItem>
              <SelectItem value="cover">Cover (fill bounds)</SelectItem>
              <SelectItem value="fill">Fill (stretch)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <NumberField
            label="X Pos"
            value={Math.round(clip.x)}
            onChange={(value) => onChange({ x: value })}
          />
          <NumberField
            label="Y Pos"
            value={Math.round(clip.y)}
            onChange={(value) => onChange({ y: value })}
          />
          <NumberField
            label="Width"
            value={Math.round(clip.width)}
            onChange={(value) => onChange({ width: Math.max(10, value) })}
            min={10}
          />
          <NumberField
            label="Height"
            value={Math.round(clip.height)}
            onChange={(value) => onChange({ height: Math.max(10, value) })}
            min={10}
          />
        </div>
      </InspectorSection>

      <InspectorSection title="Appearance">
        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Opacity</span>
            <span>{Math.round(clip.opacity * 100)}%</span>
          </div>
          <DebouncedSlider
            min={0}
            max={1}
            step={0.05}
            value={[clip.opacity]}
            onValueCommit={([value]) => onChange({ opacity: value })}
          />
        </div>

        <div className="mt-3 space-y-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Corner radius</span>
            <span>{clip.borderRadius}px</span>
          </div>
          <DebouncedSlider
            min={0}
            max={64}
            step={2}
            value={[clip.borderRadius]}
            onValueCommit={([value]) => onChange({ borderRadius: value })}
          />
        </div>

        <div className="mt-3 space-y-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Border width</span>
            <span>{clip.borderWidth}px</span>
          </div>
          <DebouncedSlider
            min={0}
            max={16}
            step={1}
            value={[clip.borderWidth]}
            onValueCommit={([value]) => onChange({ borderWidth: value })}
          />
        </div>

        {clip.borderWidth > 0 ? (
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">Border color</span>
            <ColorPicker
              aria-label="Border color"
              size="sm"
              value={clip.borderColor}
              onChange={(borderColor) => onChange({ borderColor })}
            />
          </div>
        ) : null}
      </InspectorSection>

      <InspectorSection title="Audio">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
            {clip.audioMuted ? (
              <VolumeX className="size-3.5" aria-hidden />
            ) : (
              <Volume2 className="size-3.5" aria-hidden />
            )}
            Embedded audio
          </span>
          <Switch
            checked={!clip.audioMuted}
            onCheckedChange={(enabled) => onChange({ audioMuted: !enabled })}
          />
        </div>

        {!clip.audioMuted ? (
          <div className="mt-3 space-y-1.5">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Volume</span>
              <span>{Math.round(clip.volume * 100)}%</span>
            </div>
            <DebouncedSlider
              min={0}
              max={2}
              step={0.05}
              value={[clip.volume]}
              onValueCommit={([value]) => onChange({ volume: value })}
            />
          </div>
        ) : null}
      </InspectorSection>

      <InspectorSection title="Animation">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
              In
            </label>
            <Select
              value={clip.animationIn}
              onValueChange={(value) =>
                onChange({ animationIn: value as VideoClip["animationIn"] })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="fade">Fade</SelectItem>
                <SelectItem value="scale">Scale</SelectItem>
                <SelectItem value="slide">Slide</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
              Out
            </label>
            <Select
              value={clip.animationOut}
              onValueChange={(value) =>
                onChange({ animationOut: value as VideoClip["animationOut"] })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="fade">Fade</SelectItem>
                <SelectItem value="scale">Scale</SelectItem>
                <SelectItem value="slide">Slide</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-3 space-y-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Duration</span>
            <span>{clip.animationMs}ms</span>
          </div>
          <DebouncedSlider
            min={0}
            max={2000}
            step={50}
            value={[clip.animationMs]}
            onValueCommit={([value]) => onChange({ animationMs: Math.round(value) })}
          />
        </div>
      </InspectorSection>
    </div>
  )
}
