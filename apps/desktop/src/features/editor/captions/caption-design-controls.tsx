import type { TimelineTrack } from "@recordforge/contracts"
import {
  CAPTION_ACCENT_PRESETS,
  CAPTION_LOOK_LIST,
  CAPTION_LOOKS,
  createUpdateCaptionTrackCommand,
  resolveCaptionDesign,
  type CaptionLook,
} from "@recordforge/editor-core"
import { cn, Switch, ToggleGroup, ToggleGroupItem } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { DebouncedSlider } from "../inspector/fields"

interface CaptionDesignControlsProps {
  track: TimelineTrack
}

const PLACEMENTS = [
  { value: "top", label: "Top" },
  { value: "center", label: "Center" },
  { value: "bottom", label: "Bottom" },
] as const

/**
 * Track-level look editor: every control dispatches an update-caption-track
 * design patch (sliders coalesce into one undo step; discrete picks stay
 * separate). Resolved values come from `resolveCaptionDesign` so legacy
 * tracks migrate on first edit instead of wiping clip-inherited looks.
 */
export function CaptionDesignControls({ track }: CaptionDesignControlsProps) {
  const execute = useTimelineStore((state) => state.execute)
  const design = resolveCaptionDesign(track)
  const look = CAPTION_LOOKS[design.preset]
  const disabled = track.locked

  function patchDesign(designPatch: Parameters<typeof createUpdateCaptionTrackCommand>[1]) {
    execute(createUpdateCaptionTrackCommand(track.id, designPatch))
  }

  const accent = design.accentColor ?? look.accentDefault
  const uppercase = design.uppercase ?? look.uppercase

  return (
    <div className="flex flex-col gap-3" aria-disabled={disabled}>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground">Look</span>
        <div className="grid grid-cols-2 gap-1.5">
          {CAPTION_LOOK_LIST.map((entry) => (
            <CaptionLookSwatch
              key={entry.id}
              look={entry}
              accent={accent}
              selected={entry.id === design.preset}
              disabled={disabled}
              onSelect={() => patchDesign({ design: { preset: entry.id } })}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">Size</span>
          <span className="text-[11px] tabular-nums text-subtle-foreground">
            {Math.round(design.sizeScale * 100)}%
          </span>
        </div>
        <DebouncedSlider
          aria-label="Caption size"
          min={0.6}
          max={1.8}
          step={0.05}
          disabled={disabled}
          value={[design.sizeScale]}
          onValueCommit={([v]) => patchDesign({ design: { sizeScale: v } })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground">Position</span>
        <ToggleGroup
          type="single"
          value={design.placement}
          disabled={disabled}
          onValueChange={(value) => {
            if (value) patchDesign({ design: { placement: value as typeof design.placement } })
          }}
          className="flex w-full rounded-md border border-border"
          aria-label="Caption placement"
        >
          {PLACEMENTS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value} className="flex-1 text-xs">
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <DebouncedSlider
            aria-label="Vertical offset"
            min={-25}
            max={25}
            step={1}
            disabled={disabled}
            value={[Math.round(design.offsetY * 100)]}
            onValueCommit={([v]) => patchDesign({ design: { offsetY: v / 100 } })}
            className="flex-1"
          />
          <span className="w-10 text-right text-[11px] tabular-nums text-subtle-foreground">
            {Math.round(design.offsetY * 100) > 0 ? "+" : ""}
            {Math.round(design.offsetY * 100)}%
          </span>
        </div>
      </div>

      {look.usesAccent ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">Accent</span>
            {design.accentColor !== undefined ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => patchDesign({ design: { accentColor: null } })}
                className="text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                Reset
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            {CAPTION_ACCENT_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                title={color}
                aria-label={`Accent ${color}`}
                disabled={disabled}
                onClick={() => patchDesign({ design: { accentColor: color } })}
                className={cn(
                  "size-5 rounded-full border transition-transform duration-fast ease-forge",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  "disabled:pointer-events-none disabled:opacity-50",
                  accent.toLowerCase() === color.toLowerCase()
                    ? "scale-110 border-primary ring-2 ring-primary/40"
                    : "border-border-strong hover:scale-105",
                )}
                style={{ backgroundColor: color }}
              />
            ))}
            <input
              type="color"
              aria-label="Custom accent color"
              title="Custom accent color"
              disabled={disabled}
              value={accent}
              onChange={(event) => patchDesign({ design: { accentColor: event.target.value } })}
              className="size-6 cursor-pointer rounded border border-border bg-transparent p-0 disabled:pointer-events-none disabled:opacity-50"
            />
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Switch
            aria-label="All caps captions"
            checked={uppercase}
            disabled={disabled}
            onCheckedChange={(checked) => patchDesign({ design: { uppercase: checked } })}
          />
          <span className="text-xs font-medium text-foreground">All caps</span>
        </div>
        {design.uppercase !== undefined ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => patchDesign({ design: { uppercase: null } })}
            className="text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            Reset
          </button>
        ) : null}
      </div>

      {disabled ? (
        <p className="text-[11px] text-subtle-foreground">
          Unlock the captions track to change the look.
        </p>
      ) : null}
    </div>
  )
}

interface CaptionLookSwatchProps {
  look: CaptionLook
  accent: string
  selected: boolean
  disabled?: boolean
  onSelect: () => void
}

/** Mini caption rendered with the look's real em tokens (chip, outline,
 * casing, word accent) — the same recipe the preview chip applies. */
function CaptionLookSwatch({ look, accent, selected, disabled, onSelect }: CaptionLookSwatchProps) {
  const fontPx = 11
  const chip = look.chip
  const chipColor = chip ? (chip.color === "accent" ? accent : chip.color) : null
  const words = look.highlight ? ["your", "word"] : ["Aa"]
  return (
    <button
      type="button"
      title={look.description}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "group flex flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors duration-fast ease-forge",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
        "disabled:pointer-events-none disabled:opacity-50",
        selected
          ? "border-primary/60 bg-primary/10 ring-1 ring-primary/40"
          : "border-border bg-surface hover:border-border-strong hover:bg-overlay",
      )}
    >
      <span className="flex h-8 items-center justify-center overflow-hidden rounded-md bg-surface-dim">
        <span
          className="whitespace-nowrap"
          style={{
            ...(chip
              ? {
                  padding: `${(chip.padYEm * fontPx).toFixed(1)}px ${(chip.padXEm * fontPx).toFixed(1)}px`,
                  borderRadius: `${(chip.radiusEm * fontPx).toFixed(1)}px`,
                  background: hexToRgba(chipColor ?? "#000000", chip.opacity),
                }
              : {}),
          }}
        >
          {words.map((word, index) => {
            const active = look.highlight !== null && index === words.length - 1
            return (
              <span key={index}>
                {index > 0 ? " " : ""}
                <span
                  style={{
                    fontSize: fontPx,
                    fontWeight: look.fontWeight,
                    letterSpacing: `${(look.letterSpacingEm * fontPx).toFixed(2)}px`,
                    textTransform: look.uppercase ? "uppercase" : "none",
                    color: active ? accent : look.textColor,
                    // Focus looks dim non-active words — show that contrast
                    // in the swatch so the pick is WYSIWYG.
                    opacity: look.highlight && !active ? look.highlight.inactiveOpacity : undefined,
                    fontFamily: '"Inter Variable", Inter, system-ui, sans-serif',
                    ...(look.outline && !look.chip
                      ? {
                          WebkitTextStroke: `${look.outline.widthEm * fontPx * 2}px ${look.outline.color}`,
                          paintOrder: "stroke fill",
                        }
                      : {}),
                  }}
                >
                  {word}
                </span>
              </span>
            )
          })}
        </span>
      </span>
      <span className="px-0.5 text-[11px] font-medium text-muted-foreground group-hover:text-foreground">
        {look.label}
      </span>
    </button>
  )
}

function hexToRgba(hex: string, opacity: number): string {
  const value = hex.replace("#", "")
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}
