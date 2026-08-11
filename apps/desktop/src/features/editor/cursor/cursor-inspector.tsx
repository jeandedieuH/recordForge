import type { CursorIconPreset, CursorSettings } from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/contracts"
import { MousePointer2, Sliders, Sparkles, Zap } from "lucide-react"
import { Button, Label, Slider, Switch, cn } from "@recordforge/ui"
import { RenderCursorPreset } from "./custom-cursor-overlay"

interface CursorInspectorProps {
  settings?: CursorSettings
  onChange: (updated: Partial<CursorSettings>) => void
}

const PRESETS: { id: CursorIconPreset; label: string; desc: string }[] = [
  { id: "modern-neon", label: "Modern Neon", desc: "Luminous pointer arrow" },
  { id: "sleek-dark", label: "Sleek Dark", desc: "Stealth dark pointer" },
  { id: "highlighter-circle", label: "Highlighter", desc: "Halo circle focus" },
  { id: "mac-pro", label: "Mac Pro", desc: "Classic white rounded pointer" },
  { id: "cyberpunk", label: "Cyberpunk", desc: "Tech crosshair reticle" },
  { id: "minimal-dot", label: "Minimal Dot", desc: "Clean precision dot" },
  { id: "hand-pointer", label: "Hand Pointer", desc: "Expressive hand icon" },
  { id: "default", label: "Classic Arrow", desc: "Standard screen arrow" },
]

export function CursorInspector({
  settings = defaultCursorSettings,
  onChange,
}: CursorInspectorProps) {
  const activePreset = settings.preset ?? "modern-neon"
  const scale = settings.scale ?? 1.0

  return (
    <div className="space-y-6 text-xs text-foreground p-1">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2 font-semibold">
          <MousePointer2 className="size-4 text-primary" />
          <span>Cursor Customization</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => onChange(defaultCursorSettings)}
        >
          Reset
        </Button>
      </div>

      {/* Availability is explicit so disabled ranges never look like missing media. */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-surface p-3">
        <div className="space-y-0.5">
          <p className="font-semibold">Show custom cursor</p>
          <p className="text-[10px] text-muted-foreground">
            Use recorded cursor telemetry in preview and export
          </p>
        </div>
        <Switch
          checked={settings.enabled ?? true}
          onCheckedChange={(value) => onChange({ enabled: value })}
        />
      </div>

      {/* 1. Preset Selector Grid */}
      <div className="space-y-2">
        <Label className="text-[11px] font-semibold text-muted-foreground">
          Cursor Style Preset
        </Label>
        <div className="grid grid-cols-2 gap-2">
          {PRESETS.map((item) => {
            const isSelected = activePreset === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onChange({ preset: item.id })}
                className={cn(
                  "flex flex-col items-center justify-center gap-2 rounded-xl border p-2.5 text-center transition-colors hover:bg-surface-elevated",
                  isSelected
                    ? "border-primary bg-primary/10 ring-1 ring-primary"
                    : "border-border bg-surface",
                )}
              >
                <div className="flex size-10 items-center justify-center rounded-lg bg-surface-dim shadow-inner">
                  <RenderCursorPreset
                    preset={item.id}
                    isPreview
                    fillColor={settings.fillColor ?? "#3b82f6"}
                    fillOpacity={settings.fillOpacity ?? 1}
                    strokeColor={settings.strokeColor ?? "#ffffff"}
                    strokeWidth={settings.strokeWidth ?? 2}
                    strokeOpacity={settings.strokeOpacity ?? 1}
                  />
                </div>
                <div className="min-w-0 w-full">
                  <p className="truncate font-semibold text-foreground text-[11px] leading-tight">
                    {item.label}
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* 2. Size & Scale Slider */}
      <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <Label className="font-semibold">Cursor Size ({Math.round(scale * 100)}%)</Label>
        </div>
        <Slider
          value={[scale]}
          min={0.5}
          max={3.0}
          step={0.1}
          onValueChange={([val]) => onChange({ scale: val })}
        />
        <div className="flex justify-between text-[10px]">
          <span>Cursor opacity</span>
          <span className="font-mono">{Math.round((settings.fillOpacity ?? 1) * 100)}%</span>
        </div>
        <Slider
          value={[settings.fillOpacity ?? 1]}
          min={0}
          max={1}
          step={0.05}
          aria-label="Cursor opacity"
          onValueChange={([val]) => onChange({ fillOpacity: val })}
        />
      </div>

      {/* 3. Colors & Outline */}
      <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
        <Label className="font-semibold text-[11px]">Fill & Outline</Label>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground">Fill Color</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={settings.fillColor ?? "#3b82f6"}
                onChange={(e) => onChange({ fillColor: e.target.value })}
                className="size-7 cursor-pointer rounded-lg border border-border bg-transparent"
              />
              <span className="font-mono text-[11px]">{settings.fillColor ?? "#3b82f6"}</span>
            </div>
          </div>

          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground">Stroke Color</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={settings.strokeColor ?? "#ffffff"}
                onChange={(e) => onChange({ strokeColor: e.target.value })}
                className="size-7 cursor-pointer rounded-lg border border-border bg-transparent"
              />
              <span className="font-mono text-[11px]">{settings.strokeColor ?? "#ffffff"}</span>
            </div>
          </div>
        </div>

        <div className="space-y-1.5 pt-1">
          <div className="flex justify-between text-[11px]">
            <span>Stroke Width</span>
            <span className="font-mono">{settings.strokeWidth ?? 2}px</span>
          </div>
          <Slider
            value={[settings.strokeWidth ?? 2]}
            min={0}
            max={8}
            step={0.5}
            onValueChange={([val]) => onChange({ strokeWidth: val })}
          />
        </div>
      </div>

      {/* 4. Drop Shadow Controls */}
      <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <Sparkles className="size-3.5 text-warning" />
            <span>Drop Shadow</span>
          </div>
          <Switch
            checked={settings.shadowEnabled ?? true}
            onCheckedChange={(val) => onChange({ shadowEnabled: val })}
          />
        </div>

        {settings.shadowEnabled ? (
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">Shadow Color</span>
              <input
                type="color"
                value={settings.shadowColor ?? "#000000"}
                onChange={(e) => onChange({ shadowColor: e.target.value })}
                className="size-6 cursor-pointer rounded border border-border bg-transparent"
              />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[10px]">
                <span>Blur Radius</span>
                <span className="font-mono">{settings.shadowBlur ?? 8}px</span>
              </div>
              <Slider
                value={[settings.shadowBlur ?? 8]}
                min={0}
                max={25}
                step={1}
                onValueChange={([val]) => onChange({ shadowBlur: val })}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* 5. Click Feedback Animations */}
      <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center gap-2 font-semibold">
          <Zap className="size-3.5 text-primary" />
          <span>Click Feedback Animation</span>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {(["ripple", "pulse", "spotlight", "none"] as const).map((kind) => (
            <Button
              key={kind}
              variant={settings.clickFeedback === kind ? "secondary" : "outline"}
              size="sm"
              className="h-8 capitalize text-[10px]"
              onClick={() => onChange({ clickFeedback: kind })}
            >
              {kind}
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <div className="flex items-center justify-between rounded-lg border border-border px-2 py-1.5">
            <span className="text-[10px]">Left click</span>
            <Switch
              checked={settings.leftClickEnabled ?? true}
              onCheckedChange={(value) => onChange({ leftClickEnabled: value })}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border px-2 py-1.5">
            <span className="text-[10px]">Right click</span>
            <Switch
              checked={settings.rightClickEnabled ?? true}
              onCheckedChange={(value) => onChange({ rightClickEnabled: value })}
            />
          </div>
        </div>

        {settings.clickFeedback !== "none" ? (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">Ring / Glow Color</span>
              <input
                type="color"
                value={settings.clickColor ?? "#60a5fa"}
                onChange={(e) => onChange({ clickColor: e.target.value })}
                className="size-6 cursor-pointer rounded border border-border bg-transparent"
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* 6. Motion & Focus Spotlight */}
      <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center gap-2 font-semibold">
          <Sliders className="size-3.5 text-success" />
          <span>Motion & Focus Mode</span>
        </div>

        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="font-medium text-[11px]">Motion Smoothing</p>
              <p className="text-[10px] text-muted-foreground">
                Removes mouse jitter during playback
              </p>
            </div>
            <Switch
              checked={settings.smoothMovement ?? true}
              onCheckedChange={(val) => onChange({ smoothMovement: val })}
            />
          </div>

          {settings.smoothMovement ? (
            <div className="space-y-1 pt-1">
              <div className="flex justify-between text-[10px]">
                <span>Smoothing strength</span>
                <span className="font-mono">
                  {Math.round((1 - (settings.smoothFactor ?? 0.25)) * 100)}%
                </span>
              </div>
              <Slider
                value={[settings.smoothFactor ?? 0.25]}
                min={0.05}
                max={1}
                step={0.05}
                aria-label="Cursor smoothing strength"
                onValueChange={([value]) => onChange({ smoothFactor: value })}
              />
            </div>
          ) : null}

          <div className="flex items-center justify-between pt-1">
            <div className="space-y-0.5">
              <p className="font-medium text-[11px]">Hide when idle</p>
              <p className="text-[10px] text-muted-foreground">
                Hide after a quiet stretch of telemetry
              </p>
            </div>
            <Switch
              checked={settings.autoHideIdle ?? false}
              onCheckedChange={(value) => onChange({ autoHideIdle: value })}
            />
          </div>

          {settings.autoHideIdle ? (
            <div className="space-y-1 pl-2 border-l-2 border-success/40 pt-1">
              <div className="flex justify-between text-[10px]">
                <span>Idle timeout</span>
                <span className="font-mono">{settings.idleTimeoutMs ?? 2000}ms</span>
              </div>
              <Slider
                value={[settings.idleTimeoutMs ?? 2000]}
                min={500}
                max={10000}
                step={100}
                onValueChange={([value]) => onChange({ idleTimeoutMs: value })}
              />
            </div>
          ) : null}

          <div className="flex items-center justify-between pt-1">
            <div className="space-y-0.5">
              <p className="font-medium text-[11px]">Focus Spotlight Mode</p>
              <p className="text-[10px] text-muted-foreground">Dims background around cursor</p>
            </div>
            <Switch
              checked={settings.spotlightMode ?? false}
              onCheckedChange={(val) => onChange({ spotlightMode: val })}
            />
          </div>

          {settings.spotlightMode ? (
            <div className="space-y-2 pl-2 border-l-2 border-primary/40 pt-1">
              <div className="space-y-1">
                <div className="flex justify-between text-[10px]">
                  <span>Spotlight Radius</span>
                  <span className="font-mono">{settings.spotlightRadius ?? 120}px</span>
                </div>
                <Slider
                  value={[settings.spotlightRadius ?? 120]}
                  min={50}
                  max={250}
                  step={10}
                  onValueChange={([val]) => onChange({ spotlightRadius: val })}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
