import { useEffect, useState } from "react"
import type { ClickFeedback, CursorIconPreset, CursorSettings } from "@recordforge/contracts"
import {
  cursorSettingsSchema,
  defaultCursorSettings,
  recommendedCursorSettings,
} from "@recordforge/contracts"
import { MousePointer2, Palette, Save, Sliders, Trash2 } from "lucide-react"
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
  ToggleGroup,
  ToggleGroupItem,
  cn,
} from "@recordforge/ui"
import { RenderCursorPreset } from "./cursor-asset"
import { DebouncedSlider } from "../inspector/fields"

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

/** Motion presets that map to tested smoothing parameters. Higher smoothFactor
 *  means the cursor tracks the raw input more closely (less smoothing). */
const MOTION_PRESETS: {
  id: string
  label: string
  smoothMovement: boolean
  smoothFactor: number
}[] = [
  { id: "precise", label: "Precise", smoothMovement: false, smoothFactor: 1 },
  { id: "natural", label: "Natural", smoothMovement: true, smoothFactor: 0.25 },
  { id: "smooth", label: "Smooth", smoothMovement: true, smoothFactor: 0.18 },
  { id: "cinematic", label: "Cinematic", smoothMovement: true, smoothFactor: 0.12 },
]

const CLICK_STYLE_OPTIONS: { value: ClickFeedback; label: string }[] = [
  { value: "ripple", label: "Ring" },
  { value: "pulse", label: "Pulse" },
  { value: "spotlight", label: "Glow" },
  { value: "none", label: "None" },
]

function motionPresetFor(settings: CursorSettings): string {
  if (!(settings.smoothMovement ?? true)) return "precise"
  const factor = settings.smoothFactor ?? 0.25
  return (
    MOTION_PRESETS.find(
      (preset) => preset.smoothMovement && Math.abs(preset.smoothFactor - factor) < 0.001,
    )?.id ?? ""
  )
}

function cursorThemeIdFor(settings: CursorSettings): string {
  const fill = (settings.fillColor ?? "").toLowerCase()
  const stroke = (settings.strokeColor ?? "").toLowerCase()
  const match = CURSOR_THEMES.find(
    (theme) => theme.fillColor.toLowerCase() === fill && theme.strokeColor.toLowerCase() === stroke,
  )
  return match?.id ?? "custom"
}

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
          onClick={() => (onReset ? onReset() : onChange(recommendedCursorSettings))}
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
  // The user may open the custom pickers while the colors still match a named
  // theme, so "Custom" stays reachable until they pick a theme again.
  const [customThemeOpen, setCustomThemeOpen] = useState(false)
  const activeThemeId = cursorThemeIdFor(settings)
  const showCustomColors = customThemeOpen || activeThemeId === "custom"
  const motionPresetId = motionPresetFor(settings)
  const clickStyle = settings.clickFeedback ?? "ripple"
  const styleMeta = PRESETS.find((preset) => preset.id === activePreset) ?? PRESETS[0]

  function applyTheme(theme: (typeof CURSOR_THEMES)[number]) {
    setCustomThemeOpen(false)
    onChange({
      fillColor: theme.fillColor,
      strokeColor: theme.strokeColor,
      strokeWidth: theme.strokeWidth,
    })
  }

  return (
    <>
      <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
        <Label className="text-[11px] font-semibold text-muted-foreground">Appearance</Label>

        {/* The editor supports a single recorded-system style — render it as a
            labelled row instead of a one-cell grid. */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-dim/60 p-2">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-dim shadow-inner">
            <RenderCursorPreset
              preset={styleMeta.id}
              isPreview
              className="size-7"
              fillColor={settings.fillColor ?? "#3b82f6"}
              fillOpacity={settings.fillOpacity ?? 1}
              strokeColor={settings.strokeColor ?? "#ffffff"}
              strokeWidth={settings.strokeWidth ?? 2}
              strokeOpacity={settings.strokeOpacity ?? 1}
            />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-foreground text-[11px] leading-tight">
              {styleMeta.label}
            </p>
            <p className="text-[10px] text-muted-foreground">{styleMeta.desc}</p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Cursor theme">
          {CURSOR_THEMES.map((theme) => {
            const isSelected = activeThemeId === theme.id
            return (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => applyTheme(theme)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-lg border p-1.5 transition-colors hover:bg-overlay",
                  isSelected
                    ? "border-primary bg-primary/10 ring-1 ring-primary"
                    : "border-border bg-surface",
                )}
              >
                <span className="flex size-7 items-center justify-center rounded-md bg-surface-dim">
                  <RenderCursorPreset
                    preset={styleMeta.id}
                    isPreview
                    className="size-5"
                    fillColor={theme.fillColor}
                    strokeColor={theme.strokeColor}
                    strokeWidth={theme.strokeWidth}
                  />
                </span>
                <span className="text-[10px] font-medium text-foreground">{theme.label}</span>
              </button>
            )
          })}
          <button
            type="button"
            role="radio"
            aria-checked={showCustomColors}
            onClick={() => setCustomThemeOpen(true)}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg border p-1.5 transition-colors hover:bg-overlay",
              showCustomColors
                ? "border-primary bg-primary/10 ring-1 ring-primary"
                : "border-border bg-surface",
            )}
          >
            <span className="flex size-7 items-center justify-center rounded-md bg-surface-dim text-muted-foreground">
              <Palette className="size-4" aria-hidden />
            </span>
            <span className="text-[10px] font-medium text-foreground">Custom</span>
          </button>
        </div>

        {showCustomColors ? (
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
        ) : null}
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
                    : "border-border bg-surface-dim hover:bg-overlay text-muted-foreground",
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
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="space-y-0.5">
              <p className="font-medium text-[11px]">Motion style</p>
              <p className="text-[10px] text-muted-foreground">Choose how the cursor moves</p>
            </div>
          </div>
          <ToggleGroup
            type="single"
            aria-label="Cursor motion style"
            value={motionPresetId}
            onValueChange={(value) => {
              if (!value) return
              const preset = MOTION_PRESETS.find((p) => p.id === value)
              if (!preset) return
              onChange({
                smoothMovement: preset.smoothMovement,
                smoothFactor: preset.smoothFactor,
              })
            }}
            className="flex w-full rounded-md border border-border"
          >
            {MOTION_PRESETS.map((preset) => (
              <ToggleGroupItem
                key={preset.id}
                value={preset.id}
                className="h-7 flex-1 px-1 text-[10px]"
              >
                {preset.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {motionPresetId === "" ? (
            <p className="text-[10px] text-muted-foreground">
              Custom — tune the smoothing strength in Advanced.
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <div className="space-y-0.5">
            <p className="font-medium text-[11px]">Click style</p>
            <p className="text-[10px] text-muted-foreground">Choose how clicks are emphasized</p>
          </div>
          <ToggleGroup
            type="single"
            aria-label="Cursor click style"
            value={clickStyle}
            onValueChange={(value) => {
              if (!value) return
              onChange({ clickFeedback: value as ClickFeedback })
            }}
            className="flex w-full rounded-md border border-border"
          >
            {CLICK_STYLE_OPTIONS.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                className="h-7 flex-1 gap-1 px-1 text-[10px]"
              >
                <ClickStyleGlyph kind={option.value} />
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="font-medium text-[11px]">Press animation</p>
            <p className="text-[10px] text-muted-foreground">Micro-press and spring on click</p>
          </div>
          <Switch
            checked={settings.clickPressAnimation ?? true}
            onCheckedChange={(value) => onChange({ clickPressAnimation: value })}
          />
        </div>

        <div className="space-y-2 pt-1 border-t border-border">
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
          {settings.autoHideIdle ? (
            <div className="space-y-1 pl-2 border-l-2 border-border-strong">
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
        </div>
      </div>
    </>
  )
}

/** Miniature click-effect previews for the click-style segmented control. */
function ClickStyleGlyph({ kind }: { kind: ClickFeedback }) {
  if (kind === "none") {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 text-muted-foreground" aria-hidden>
        <circle
          cx="8"
          cy="8"
          r="5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 2"
        />
      </svg>
    )
  }
  if (kind === "pulse") {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 text-primary" aria-hidden>
        <circle cx="8" cy="8" r="7" fill="currentColor" fillOpacity="0.25" />
        <circle cx="8" cy="8" r="4" fill="currentColor" fillOpacity="0.75" />
      </svg>
    )
  }
  if (kind === "spotlight") {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 text-primary" aria-hidden>
        <circle cx="8" cy="8" r="7" fill="currentColor" fillOpacity="0.2" />
        <circle cx="8" cy="8" r="4.5" fill="currentColor" fillOpacity="0.45" />
        <circle cx="8" cy="8" r="2" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 text-primary" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  )
}

interface AdvancedCursorSettingsProps {
  settings: CursorSettings
  onChange: (updated: Partial<CursorSettings>) => void
}

function AdvancedCursorSettings({ settings, onChange }: AdvancedCursorSettingsProps) {
  // smoothFactor is an EMA alpha: 1 follows raw input, lower values are
  // smoother. The slider exposes it as "strength" so higher = smoother.
  const smoothingStrength = 1 - (settings.smoothFactor ?? 0.25)

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
        <Label className="font-semibold text-[11px]">Stroke &amp; Opacity</Label>

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

      <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
        <Label className="font-semibold text-[11px]">Motion</Label>
        <div className="space-y-1 pt-1">
          <div className="flex justify-between text-[10px]">
            <span>Smoothing strength</span>
            <span className="font-mono">{Math.round(smoothingStrength * 100)}%</span>
          </div>
          <DebouncedSlider
            value={[smoothingStrength]}
            min={0}
            max={0.95}
            step={0.05}
            aria-label="Cursor smoothing strength"
            onValueCommit={([value]) =>
              onChange({
                smoothMovement: (value ?? 0) > 0,
                smoothFactor: Math.min(1, Math.max(0.05, 1 - (value ?? 0))),
              })
            }
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
      </div>
    </div>
  )
}

/**
 * Named fill/stroke looks for the cursor. These are actual render colors
 * (they ship into the exported video), so explicit values are intentional —
 * they mirror the DPI-consistent recommendedCursorSettings defaults.
 */
const CURSOR_THEMES: {
  id: "light" | "dark" | "accent"
  label: string
  fillColor: string
  strokeColor: string
  strokeWidth: number
}[] = [
  { id: "light", label: "Light", fillColor: "#ffffff", strokeColor: "#111111", strokeWidth: 1.5 },
  { id: "dark", label: "Dark", fillColor: "#111111", strokeColor: "#ffffff", strokeWidth: 1.5 },
  { id: "accent", label: "Accent", fillColor: "#3b82f6", strokeColor: "#ffffff", strokeWidth: 2 },
]
