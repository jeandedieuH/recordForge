import type { CaptionStylePreset } from "@recordforge/contracts"
import { cn } from "@recordforge/ui"
import { CAPTION_STYLE_OPTIONS, captionTextClass } from "./caption-styles"

interface CaptionStylePickerProps {
  value: CaptionStylePreset
  onChange: (style: CaptionStylePreset) => void
  disabled?: boolean
  "aria-label"?: string
}

/** Radio-style swatch grid — each option previews the real burn-in look. */
export function CaptionStylePicker({
  value,
  onChange,
  disabled,
  "aria-label": ariaLabel = "Caption style",
}: CaptionStylePickerProps) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="grid grid-cols-2 gap-1.5">
      {CAPTION_STYLE_OPTIONS.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={cn(
              "group flex flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors duration-fast ease-forge",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
              "disabled:pointer-events-none disabled:opacity-50",
              selected
                ? "border-primary/60 bg-primary/10"
                : "border-border bg-surface hover:border-border-strong hover:bg-overlay",
            )}
          >
            <span className="flex h-8 items-center justify-center rounded-md bg-surface-dim">
              <span className={cn("text-[11px] leading-none", captionTextClass(option.value))}>
                Aa
              </span>
            </span>
            <span className="px-0.5 text-[11px] font-medium text-muted-foreground group-hover:text-foreground">
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
