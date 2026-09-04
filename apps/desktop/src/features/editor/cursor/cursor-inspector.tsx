import { useEffect, useState } from "react"
import type { CursorIconPreset, CursorSettings } from "@recordforge/contracts"
import { cursorSettingsSchema, defaultCursorSettings } from "@recordforge/contracts"
import { MousePointer2, Save, Sliders, Trash2 } from "lucide-react"
import { getSetting, isTauri, setSetting } from "../../../lib/settings"
import {
  Button,
  ColorPicker,
  IconButton,
  Input,
  Label,
  SimpleSelect,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@recordforge/ui"
import { RenderCursorPreset } from "./cursor-asset"
import { DebouncedSlider } from "../inspector/fields"

/** Motion presets that map to tested smoothing parameters. */
const MOTION_PRESETS: {
  id: string
  label: string
  smoothMovement: boolean
  smoothFactor: number
}[] = [
  { id: "precise", label: "Precise", smoothMovement: false, smoothFactor: 0.25 },
  { id: "natural", label: "Natural", smoothMovement: true, smoothFactor: 0.25 },
  { id: "cinematic", label: "Cinematic", smoothMovement: true, smoothFactor: 0.15 },
]

const CLICK_PRESETS: {
  id: string
  label: string
  clickFeedback: CursorSettings["clickFeedback"]
  clickSize?: number
  clickDurationMs?: number
}[] = [
  { id: "subtle", label: "Subtle", clickFeedback: "ripple", clickSize: 24, clickDurationMs: 250 },
  {
    id: "standard",
    label: "Standard",
    clickFeedback: "ripple",
    clickSize: 36,
    clickDurationMs: 350,
  },
  {
    id: "dramatic",
    label: "Dramatic",
    clickFeedback: "spotlight",
    clickSize: 64,
    clickDurationMs: 600,
  },
  { id: "off", label: "Off", clickFeedback: "none" },
]

interface CursorInspectorProps {
  settings?: CursorSettings
  onChange: (updated: Partial<CursorSettings>) => void
  onReset?: () => void
  resetLabel?: string
  /** When true, the user can save and load named cursor presets. */
  presetsEnabled?: boolean
}

// The editor only supports the recorded cursor style. Legacy presets are
// migrated to "recorded-system" when the project is loaded.
const PRESETS: { id: CursorIconPreset; label: string; desc: string }[] = [
  { id: "recorded-system", label: "Recorded / System", desc: "Use the captured system cursor" },
]

const CURSOR_PRESETS_KEY = "cursorPresets"

export function CursorInspector({
  settings = defaultCursorSettings,
  onChange,
  onReset,
  resetLabel = "Reset",
  presetsEnabled = true,
}: CursorInspectorProps) {
  const activePreset = settings.preset ?? "recorded-system"
  const scale = settings.scale ?? 1.0
  const [savedPresets, setSavedPresets] = useState<Record<string, CursorSettings>>({})
  const [presetName, setPresetName] = useState("")
  const [selectedPreset, setSelectedPreset] = useState("")
  const [presetsLoaded, setPresetsLoaded] = useState(false)

  useEffect(() => {
    if (!presetsEnabled) return
    async function load() {
      try {
        let raw = isTauri() ? await getSetting(CURSOR_PRESETS_KEY) : null
        if (!raw) {
          raw = localStorage.getItem(`recordforge:${CURSOR_PRESETS_KEY}`)
        }
        if (!raw) return
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed !== "object" || parsed === null) return
        const entries = Object.entries(parsed as Record<string, unknown>)
          .map(([name, value]) => {
            const validated = cursorSettingsSchema.safeParse(value)
            return validated.success ? ([name, validated.data] as const) : null
          })
          .filter((entry): entry is [string, CursorSettings] => entry !== null)
        setSavedPresets(Object.fromEntries(entries))
      } catch {
        // Ignore corrupted presets.
      } finally {
        setPresetsLoaded(true)
      }
    }
    void load()
  }, [presetsEnabled])

  async function persistPresets(next: Record<string, CursorSettings>) {
    setSavedPresets(next)
    const json = JSON.stringify(next)
    try {
      localStorage.setItem(`recordforge:${CURSOR_PRESETS_KEY}`, json)
    } catch {
      // Ignore localStorage errors
    }
    if (isTauri()) {
      try {
        await setSetting(CURSOR_PRESETS_KEY, json)
      } catch {
        // Settings may be unavailable during tests/dev.
      }
    }
  }

  function saveCurrentPreset() {
    const name = presetName.trim()
    if (!name) return
    const next = { ...savedPresets, [name]: { ...settings } }
    setSelectedPreset(name)
    void persistPresets(next)
    setPresetName("")
  }

  function loadPreset(name: string) {
    setSelectedPreset(name)
    const preset = savedPresets[name]
    if (!preset) return
    onChange(preset)
  }

  function deletePreset(name: string) {
    const { [name]: _, ...rest } = savedPresets
    void persistPresets(rest)
    if (selectedPreset === name) setSelectedPreset("")
  }

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

      {presetsEnabled ? (
        <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-[11px]">Saved presets</p>
            {presetsLoaded && Object.keys(savedPresets).length === 0 ? (
              <span className="text-[10px] text-muted-foreground">No saved presets</span>
            ) : null}
          </div>

          {Object.keys(savedPresets).length > 0 ? (
            <div className="flex items-center gap-2">
              <SimpleSelect
                aria-label="Load cursor preset"
                size="sm"
                value={selectedPreset}
                onValueChange={(val) => loadPreset(val)}
                className="flex-1 text-[10px]"
                placeholder="Load a preset…"
                options={Object.keys(savedPresets).map((name) => ({
                  value: name,
                  label: name,
                }))}
              />
              <IconButton
                label="Delete selected preset"
                variant="ghost"
                size="sm"
                className="size-7 text-recording"
                disabled={!selectedPreset}
                onClick={() => deletePreset(selectedPreset)}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <Input
              type="text"
              placeholder="Preset name"
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveCurrentPreset()
              }}
              className="h-7 flex-1 text-[10px]"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px]"
              disabled={!presetName.trim()}
              onClick={saveCurrentPreset}
            >
              <Save className="size-3.5 mr-1.5" />
              Save
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Save the current cursor profile so you can reuse it on other projects.
          </p>
        </div>
      ) : null}

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
                    className="size-7"
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
          <div className="flex items-center gap-1">
            {[0.5, 1.0, 1.5, 2.0].map((presetScale) => (
              <button
                key={presetScale}
                type="button"
                onClick={() => onChange({ scale: presetScale })}
                className={cn(
                  "px-1.5 py-0.5 text-[10px] font-mono rounded border transition-colors",
                  Math.abs(scale - presetScale) < 0.05
                    ? "border-primary bg-primary/10 text-primary font-semibold"
                    : "border-border bg-surface-dim hover:bg-surface-elevated text-muted-foreground",
                )}
              >
                {Math.round(presetScale * 100)}%
              </button>
            ))}
          </div>
        </div>
        <DebouncedSlider
          value={[scale]}
          min={0.5}
          max={4.0}
          step={0.1}
          onValueCommit={([val]) => onChange({ scale: val })}
          aria-label="Cursor size"
        />
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-0.5">
            <p className="font-medium text-[11px]">Motion style</p>
            <p className="text-[10px] text-muted-foreground">Choose how the cursor moves</p>
          </div>
          <SimpleSelect
            aria-label="Cursor motion style"
            size="sm"
            value={
              MOTION_PRESETS.find(
                (p) =>
                  p.smoothMovement === (settings.smoothMovement ?? true) &&
                  p.smoothFactor === (settings.smoothFactor ?? 0.25),
              )?.id ?? "custom"
            }
            onValueChange={(val) => {
              const preset = MOTION_PRESETS.find((p) => p.id === val)
              if (preset) {
                onChange({
                  smoothMovement: preset.smoothMovement,
                  smoothFactor: preset.smoothFactor,
                })
              }
            }}
            className="w-36 text-[10px]"
            options={[
              ...MOTION_PRESETS.map((preset) => ({
                value: preset.id,
                label: preset.label,
              })),
              { value: "custom", label: "Custom" },
            ]}
          />
        </div>

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

        <div className="flex items-center justify-between gap-2">
          <div className="space-y-0.5">
            <p className="font-medium text-[11px]">Click style</p>
            <p className="text-[10px] text-muted-foreground">Choose how clicks are emphasized</p>
          </div>
          <SimpleSelect
            aria-label="Cursor click style"
            size="sm"
            value={
              CLICK_PRESETS.find(
                (p) =>
                  p.clickFeedback === settings.clickFeedback &&
                  (p.clickSize === undefined || p.clickSize === settings.clickSize) &&
                  (p.clickDurationMs === undefined ||
                    p.clickDurationMs === settings.clickDurationMs),
              )?.id ?? "custom"
            }
            onValueChange={(val) => {
              const preset = CLICK_PRESETS.find((p) => p.id === val)
              if (preset) {
                onChange({
                  clickFeedback: preset.clickFeedback,
                  clickSize: preset.clickSize,
                  clickDurationMs: preset.clickDurationMs,
                })
              }
            }}
            className="w-36 text-[10px]"
            options={[
              ...CLICK_PRESETS.map((preset) => ({
                value: preset.id,
                label: preset.label,
              })),
              { value: "custom", label: "Custom" },
            ]}
          />
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
            <ColorPicker
              aria-label="Fill color"
              size="sm"
              value={settings.fillColor ?? "#3b82f6"}
              onChange={(fillColor) => onChange({ fillColor })}
              className="w-full"
              triggerClassName="w-full justify-between"
            />
          </div>

          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground">Stroke Color</span>
            <ColorPicker
              aria-label="Stroke color"
              size="sm"
              value={settings.strokeColor ?? "#ffffff"}
              onChange={(strokeColor) => onChange({ strokeColor })}
              className="w-full"
              triggerClassName="w-full justify-between"
            />
          </div>
        </div>

        <div className="space-y-1.5 pt-1">
          <div className="flex justify-between text-[11px]">
            <span>Stroke Width</span>
            <span className="font-mono">{settings.strokeWidth ?? 2}px</span>
          </div>
          <DebouncedSlider
            value={[settings.strokeWidth ?? 2]}
            min={0}
            max={8}
            step={0.5}
            onValueCommit={([val]) => onChange({ strokeWidth: val })}
            aria-label="Stroke width"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px]">
            <span>Cursor opacity</span>
            <span className="font-mono">{Math.round((settings.fillOpacity ?? 1) * 100)}%</span>
          </div>
          <DebouncedSlider
            value={[settings.fillOpacity ?? 1]}
            min={0}
            max={1}
            step={0.05}
            onValueCommit={([val]) => onChange({ fillOpacity: val })}
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
              <ColorPicker
                aria-label="Shadow color"
                size="sm"
                value={settings.shadowColor ?? "#000000"}
                onChange={(shadowColor) => onChange({ shadowColor })}
              />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[10px]">
                <span>Blur Radius</span>
                <span className="font-mono">{settings.shadowBlur ?? 8}px</span>
              </div>
              <DebouncedSlider
                value={[settings.shadowBlur ?? 8]}
                min={0}
                max={25}
                step={1}
                onValueCommit={([val]) => onChange({ shadowBlur: val })}
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
              <ColorPicker
                aria-label="Click effect color"
                size="sm"
                value={settings.clickColor ?? "#60a5fa"}
                onChange={(clickColor) => onChange({ clickColor })}
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[10px]">
                <span>Ring Size</span>
                <span className="font-mono">{settings.clickSize ?? 36}px</span>
              </div>
              <DebouncedSlider
                value={[settings.clickSize ?? 36]}
                min={10}
                max={100}
                step={1}
                onValueCommit={([val]) => onChange({ clickSize: val })}
                aria-label="Click effect size"
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[10px]">
                <span>Effect Duration</span>
                <span className="font-mono">{settings.clickDurationMs ?? 350}ms</span>
              </div>
              <DebouncedSlider
                value={[settings.clickDurationMs ?? 350]}
                min={100}
                max={2000}
                step={50}
                onValueCommit={([val]) => onChange({ clickDurationMs: val })}
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
              <DebouncedSlider
                value={[settings.spotlightRadius ?? 120]}
                min={50}
                max={250}
                step={10}
                onValueCommit={([val]) => onChange({ spotlightRadius: val })}
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
              <DebouncedSlider
                value={[settings.spotlightDimOpacity ?? 0.5]}
                min={0}
                max={0.9}
                step={0.05}
                onValueCommit={([val]) => onChange({ spotlightDimOpacity: val })}
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
            <DebouncedSlider
              value={[settings.idleTimeoutMs ?? 2000]}
              min={500}
              max={10000}
              step={100}
              onValueCommit={([value]) => onChange({ idleTimeoutMs: value })}
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
          <DebouncedSlider
            value={[settings.smoothFactor ?? 0.25]}
            min={0.05}
            max={1}
            step={0.05}
            aria-label="Cursor smoothing strength"
            onValueCommit={([value]) => onChange({ smoothFactor: value })}
          />
        </div>
      </div>
    </div>
  )
}
