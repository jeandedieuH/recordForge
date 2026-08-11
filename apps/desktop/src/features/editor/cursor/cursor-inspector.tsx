import type { CursorIconPreset, CursorSettings } from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/contracts"
import { MousePointer2, Sliders } from "lucide-react"
import {
  Button,
  Label,
  Slider,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@recordforge/ui"
import { RenderCursorPreset } from "./cursor-asset"

interface CursorInspectorProps {
  settings?: CursorSettings
  onChange: (updated: Partial<CursorSettings>) => void
  onReset?: () => void
  resetLabel?: string
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

const CLICK_EMPHASIS: { id: CursorSettings["clickFeedback"]; label: string }[] = [
  { id: "ripple", label: "Ripple" },
  { id: "pulse", label: "Pulse" },
  { id: "spotlight", label: "Spotlight" },
  { id: "none", label: "Off" },
]

export function CursorInspector({
  settings = defaultCursorSettings,
  onChange,
  onReset,
  resetLabel = "Reset",
}: CursorInspectorProps) {
  const activePreset = settings.preset ?? "modern-neon"
  const scale = settings.scale ?? 1.0

  return (
    <div className="space-y-4 text-xs text-foreground p-1">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2 font-semibold">
          <MousePointer2 className="size-4 text-primary" aria-hidden />
          <span>Cursor</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => (onReset ? onReset() : onChange(defaultCursorSettings))}
        >
          {resetLabel}
        </Button>
      </div>

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

      <Tabs defaultValue="basic" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="basic">Basic</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>

        <TabsContent value="basic" className="space-y-4 pt-2">
          <BasicCursorSettings
            settings={settings}
            onChange={onChange}
            activePreset={activePreset}
            scale={scale}
          />
        </TabsContent>

        <TabsContent value="advanced" className="space-y-4 pt-2">
          <AdvancedCursorSettings settings={settings} onChange={onChange} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface BasicCursorSettingsProps {
  settings: CursorSettings
  onChange: (updated: Partial<CursorSettings>) => void
  activePreset: CursorIconPreset
  scale: number
}

function BasicCursorSettings({
  settings,
  onChange,
  activePreset,
  scale,
}: BasicCursorSettingsProps) {
  return (
    <>
      <div className="space-y-2">
        <Label className="text-[11px] font-semibold text-muted-foreground">Style</Label>
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

      <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <Label className="font-semibold">Size ({Math.round(scale * 100)}%)</Label>
        </div>
        <Slider
          value={[scale]}
          min={0.5}
          max={3.0}
          step={0.1}
          onValueChange={([val]) => onChange({ scale: val })}
          aria-label="Cursor size"
        />
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="font-medium text-[11px]">Natural motion</p>
            <p className="text-[10px] text-muted-foreground">Smooths small mouse jitters</p>
          </div>
          <Switch
            checked={settings.smoothMovement ?? true}
            onCheckedChange={(value) => onChange({ smoothMovement: value })}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-[11px] font-semibold text-muted-foreground">Click emphasis</Label>
          <div className="grid grid-cols-4 gap-1.5">
            {CLICK_EMPHASIS.map((kind) => (
              <Button
                key={kind.id}
                variant={settings.clickFeedback === kind.id ? "secondary" : "outline"}
                size="sm"
                className="h-8 text-[10px] capitalize"
                onClick={() => onChange({ clickFeedback: kind.id })}
              >
                {kind.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <div className="space-y-0.5">
            <p className="font-medium text-[11px]">Hide when idle</p>
            <p className="text-[10px] text-muted-foreground">Fade after a quiet stretch</p>
          </div>
          <Switch
            checked={settings.autoHideIdle ?? false}
            onCheckedChange={(value) => onChange({ autoHideIdle: value })}
          />
        </div>
      </div>
    </>
  )
}

interface AdvancedCursorSettingsProps {
  settings: CursorSettings
  onChange: (updated: Partial<CursorSettings>) => void
}

function AdvancedCursorSettings({ settings, onChange }: AdvancedCursorSettingsProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
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
                aria-label="Fill color"
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
                aria-label="Stroke color"
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
            aria-label="Stroke width"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px]">
            <span>Cursor opacity</span>
            <span className="font-mono">{Math.round((settings.fillOpacity ?? 1) * 100)}%</span>
          </div>
          <Slider
            value={[settings.fillOpacity ?? 1]}
            min={0}
            max={1}
            step={0.05}
            onValueChange={([val]) => onChange({ fillOpacity: val })}
            aria-label="Cursor opacity"
          />
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <Sliders className="size-3.5 text-warning" aria-hidden />
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
                aria-label="Shadow color"
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
                aria-label="Shadow blur"
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
        <Label className="font-semibold text-[11px]">Click Feedback</Label>

        {settings.clickFeedback !== "none" ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
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

            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">Ring / Glow Color</span>
              <input
                type="color"
                value={settings.clickColor ?? "#60a5fa"}
                onChange={(e) => onChange({ clickColor: e.target.value })}
                className="size-6 cursor-pointer rounded border border-border bg-transparent"
                aria-label="Click effect color"
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[10px]">
                <span>Ring Size</span>
                <span className="font-mono">{settings.clickSize ?? 36}px</span>
              </div>
              <Slider
                value={[settings.clickSize ?? 36]}
                min={10}
                max={100}
                step={1}
                onValueChange={([val]) => onChange({ clickSize: val })}
                aria-label="Click effect size"
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[10px]">
                <span>Effect Duration</span>
                <span className="font-mono">{settings.clickDurationMs ?? 350}ms</span>
              </div>
              <Slider
                value={[settings.clickDurationMs ?? 350]}
                min={100}
                max={2000}
                step={50}
                onValueChange={([val]) => onChange({ clickDurationMs: val })}
                aria-label="Click effect duration"
              />
            </div>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            Turn on a click emphasis style in Basic to adjust these options.
          </p>
        )}
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="font-medium text-[11px]">Focus Spotlight</p>
            <p className="text-[10px] text-muted-foreground">Dim background around cursor</p>
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
                aria-label="Spotlight radius"
              />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[10px]">
                <span>Dim opacity</span>
                <span className="font-mono">
                  {Math.round((settings.spotlightDimOpacity ?? 0.5) * 100)}%
                </span>
              </div>
              <Slider
                value={[settings.spotlightDimOpacity ?? 0.5]}
                min={0}
                max={0.9}
                step={0.05}
                onValueChange={([val]) => onChange({ spotlightDimOpacity: val })}
                aria-label="Spotlight dim opacity"
              />
            </div>
          </div>
        ) : null}

        {settings.autoHideIdle ? (
          <div className="space-y-1 pl-2 border-l-2 border-success/40 pt-2">
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
              aria-label="Idle timeout"
            />
          </div>
        ) : null}

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
      </div>
    </div>
  )
}
