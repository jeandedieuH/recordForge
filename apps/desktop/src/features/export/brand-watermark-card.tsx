import { open } from "@tauri-apps/plugin-dialog"
import { X } from "lucide-react"
import type { BrandCards, BrandWatermark } from "@recordforge/contracts"
import {
  Button,
  ColorPicker,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Switch,
} from "@recordforge/ui"
import { ProBadge } from "../licensing/pro-badge"
import { useLicenseStore } from "../../stores/license-store"

interface BrandWatermarkCardProps {
  watermark: BrandWatermark
  cards: BrandCards
  disabled?: boolean
  onChange: (watermark: BrandWatermark) => void
  onCardsChange: (cards: BrandCards) => void
}

const POSITIONS = [
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
] as const

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

const CARD_DURATIONS = [
  { value: "0", label: "Off" },
  { value: "1500", label: "1.5s" },
  { value: "2500", label: "2.5s" },
  { value: "4000", label: "4s" },
  { value: "6000", label: "6s" },
] as const

export function BrandWatermarkCard({
  watermark,
  cards,
  disabled,
  onChange,
  onCardsChange,
}: BrandWatermarkCardProps) {
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)

  function gate(): boolean {
    if (isPro) return false
    openUpgradeDialog(["brand-kit"])
    return true
  }

  async function handlePickLogo() {
    if (gate()) return
    const selected = await open({
      multiple: false,
      title: "Select watermark logo",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    })
    if (typeof selected === "string") {
      onChange({ ...watermark, logoPath: selected, enabled: true })
    }
  }

  async function handlePickFont() {
    if (gate()) return
    const selected = await open({
      multiple: false,
      title: "Select brand font",
      filters: [{ name: "Fonts", extensions: ["ttf", "otf", "ttc"] }],
    })
    if (typeof selected === "string") {
      onCardsChange({ ...cards, fontPath: selected })
    }
  }

  const cardsEnabled = cards.enabled && (cards.introMs > 0 || cards.outroMs > 0)

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex w-full items-center justify-between p-4">
        <span className="flex items-center gap-2 font-label text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Branding
          {!isPro ? <ProBadge /> : null}
        </span>
        <Switch
          checked={watermark.enabled}
          disabled={disabled}
          aria-label="Logo watermark"
          onCheckedChange={(enabled) => {
            if (enabled && gate()) return
            onChange({ ...watermark, enabled })
          }}
        />
      </div>
      {watermark.enabled ? (
        <div className="flex flex-col gap-4 border-t border-border p-5 text-xs text-subtle-foreground">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handlePickLogo} disabled={disabled}>
              {watermark.logoPath ? "Change logo" : "Choose logo"}
            </Button>
            {watermark.logoPath ? (
              <>
                <span
                  className="min-w-0 flex-1 truncate text-foreground"
                  title={watermark.logoPath}
                >
                  {fileName(watermark.logoPath)}
                </span>
                <IconButton
                  label="Remove logo"
                  onClick={() => onChange({ ...watermark, logoPath: null, enabled: false })}
                >
                  <X className="size-4" aria-hidden />
                </IconButton>
              </>
            ) : (
              <span>PNG, JPG, or WebP with transparency works best.</span>
            )}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-foreground">Position</span>
            <Select
              value={watermark.position}
              onValueChange={(position) =>
                onChange({
                  ...watermark,
                  position: position as BrandWatermark["position"],
                })
              }
              disabled={disabled}
            >
              <SelectTrigger className="h-8 w-full" aria-label="Watermark position">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POSITIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="flex justify-between text-foreground">
              <span>Size</span>
              <span className="text-subtle-foreground">{watermark.scalePercent}% of width</span>
            </span>
            <Slider
              value={[watermark.scalePercent]}
              onValueChange={([scalePercent]) => onChange({ ...watermark, scalePercent })}
              min={2}
              max={30}
              step={1}
              disabled={disabled}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="flex justify-between text-foreground">
              <span>Opacity</span>
              <span className="text-subtle-foreground">{Math.round(watermark.opacity * 100)}%</span>
            </span>
            <Slider
              value={[Math.round(watermark.opacity * 100)]}
              onValueChange={([opacity]) => onChange({ ...watermark, opacity: opacity / 100 })}
              min={10}
              max={100}
              step={5}
              disabled={disabled}
            />
          </label>
        </div>
      ) : null}

      {/* Intro/outro cards — solid brand-color segments rendered at the
          head/tail of the export with the logo + custom font. */}
      <div className="flex w-full items-center justify-between border-t border-border p-4">
        <span className="flex items-center gap-2 font-label text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Intro / outro cards
        </span>
        <Switch
          checked={cards.enabled}
          disabled={disabled}
          aria-label="Intro and outro cards"
          onCheckedChange={(enabled) => {
            if (enabled && gate()) return
            onCardsChange({
              ...cards,
              enabled,
              // Sensible defaults so flipping the switch does something.
              introMs: enabled && cards.introMs === 0 && cards.outroMs === 0 ? 2500 : cards.introMs,
              outroMs: enabled && cards.introMs === 0 && cards.outroMs === 0 ? 2500 : cards.outroMs,
            })
          }}
        />
      </div>
      {cards.enabled ? (
        <div className="flex flex-col gap-4 border-t border-border p-5 text-xs text-subtle-foreground">
          <label className="flex flex-col gap-1.5">
            <span className="text-foreground">Title</span>
            <Input
              value={cards.title ?? ""}
              onChange={(event) => onCardsChange({ ...cards, title: event.target.value || null })}
              maxLength={120}
              placeholder="Made with RecordForge"
              disabled={disabled}
              className="h-8"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-foreground">Subtitle</span>
            <Input
              value={cards.subtitle ?? ""}
              onChange={(event) =>
                onCardsChange({ ...cards, subtitle: event.target.value || null })
              }
              maxLength={200}
              placeholder="Optional second line"
              disabled={disabled}
              className="h-8"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-foreground">Intro</span>
              <Select
                value={String(cards.introMs)}
                onValueChange={(v) => onCardsChange({ ...cards, introMs: Number(v) })}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 w-full" aria-label="Intro duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CARD_DURATIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-foreground">Outro</span>
              <Select
                value={String(cards.outroMs)}
                onValueChange={(v) => onCardsChange({ ...cards, outroMs: Number(v) })}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 w-full" aria-label="Outro duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CARD_DURATIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-foreground">Background</span>
              <ColorPicker
                value={cards.background}
                onChange={(background) => onCardsChange({ ...cards, background })}
                disabled={disabled}
                size="sm"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-foreground">Text</span>
              <ColorPicker
                value={cards.textColor}
                onChange={(textColor) => onCardsChange({ ...cards, textColor })}
                disabled={disabled}
                size="sm"
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handlePickFont} disabled={disabled}>
              {cards.fontPath ? "Change font" : "Choose font"}
            </Button>
            {cards.fontPath ? (
              <>
                <span className="min-w-0 flex-1 truncate text-foreground" title={cards.fontPath}>
                  {fileName(cards.fontPath)}
                </span>
                <IconButton
                  label="Use default font"
                  onClick={() => onCardsChange({ ...cards, fontPath: null })}
                >
                  <X className="size-4" aria-hidden />
                </IconButton>
              </>
            ) : (
              <span>Defaults to Inter; the picked logo appears on the cards too.</span>
            )}
          </div>
          {cardsEnabled ? null : (
            <span className="font-medium text-warning">
              Set an intro or outro duration for the cards to render.
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}
