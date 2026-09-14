import type { CaptionPlacement, CaptionStylePreset } from "@recordforge/contracts"

export interface CaptionStyleOption {
  value: CaptionStylePreset
  label: string
  hint: string
}

export const CAPTION_STYLE_OPTIONS: CaptionStyleOption[] = [
  { value: "default", label: "Default", hint: "White on a soft black chip" },
  { value: "minimal", label: "Minimal", hint: "Outlined text, no chip" },
  { value: "boxed", label: "Boxed", hint: "White on a solid black box" },
  { value: "highlight", label: "Highlight", hint: "Black on an amber chip" },
]

export const CAPTION_PLACEMENT_OPTIONS: { value: CaptionPlacement; label: string }[] = [
  { value: "top", label: "Top" },
  { value: "center", label: "Center" },
  { value: "bottom", label: "Bottom" },
]

/**
 * Preview look for each preset. These mirror the libass styles written for
 * burn-in exports (src-tauri/src/exports/captions.rs) — keep them in sync so
 * the preview stays WYSIWYG. Padding is em-relative so chips scale with the
 * canvas-relative font size, like libass Outline padding does.
 */
export function captionTextClass(style: CaptionStylePreset): string {
  switch (style) {
    case "minimal":
      return "text-white [text-shadow:0_0_0.07em_rgba(0,0,0,0.85),0_0.05em_0.12em_rgba(0,0,0,0.65)]"
    case "boxed":
      return "rounded-[0.15em] bg-black/70 px-[0.3em] py-[0.08em] text-white"
    case "highlight":
      return "rounded-[0.15em] bg-warning/90 px-[0.25em] py-[0.08em] text-black"
    default:
      return "rounded-[0.15em] bg-black/60 px-[0.2em] py-[0.05em] text-white"
  }
}
