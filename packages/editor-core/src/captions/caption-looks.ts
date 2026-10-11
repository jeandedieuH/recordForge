import type { CaptionStylePreset } from "@recordforge/contracts"

// Caption looks express chrome (chip, outline, shadow, highlight) in *em*
// units relative to the resolved CSS font size, so a look scales cleanly with
// sizeScale and canvas tier. "accent" is a placeholder resolved against the
// design's accentColor (or the look's accentDefault) at layout time.
export interface CaptionLook {
  id: CaptionStylePreset
  label: string
  description: string
  fontWeight: 600 | 700 | 800
  letterSpacingEm: number
  uppercase: boolean
  textColor: string
  chip: {
    color: string | "accent"
    opacity: number
    radiusEm: number
    padXEm: number
    padYEm: number
  } | null
  outline: { color: string; opacity: number; widthEm: number } | null
  shadow: { color: string; opacity: number; blurEm: number; offsetYEm: number } | null
  highlight: {
    mode: "word" | "focus"
    activeColor: string | "accent"
    inactiveOpacity: number
  } | null
  animation: { inMs: number; outMs: number; fromScale: number }
  usesAccent: boolean
  accentDefault: string
}

export const CAPTION_ACCENT_PRESETS = [
  "#FACC15",
  "#4ADE80",
  "#22D3EE",
  "#F472B6",
  "#FB923C",
  "#FFFFFF",
] as const

export const CAPTION_LOOKS: Record<CaptionStylePreset, CaptionLook> = {
  default: {
    id: "default",
    label: "Clean",
    description: "Soft rounded chip",
    fontWeight: 600,
    letterSpacingEm: 0,
    uppercase: false,
    textColor: "#FFFFFF",
    chip: { color: "#0B0F17", opacity: 0.76, radiusEm: 0.34, padXEm: 0.6, padYEm: 0.28 },
    outline: null,
    shadow: { color: "#000000", opacity: 0.3, blurEm: 0.3, offsetYEm: 0.1 },
    highlight: null,
    animation: { inMs: 140, outMs: 100, fromScale: 0.96 },
    usesAccent: false,
    accentDefault: "#FACC15",
  },
  minimal: {
    id: "minimal",
    label: "Subtitle",
    description: "Outlined text, no chip",
    fontWeight: 700,
    letterSpacingEm: 0,
    uppercase: false,
    textColor: "#FFFFFF",
    chip: null,
    outline: { color: "#000000", opacity: 0.95, widthEm: 0.075 },
    shadow: { color: "#000000", opacity: 0.55, blurEm: 0.12, offsetYEm: 0.05 },
    highlight: null,
    animation: { inMs: 120, outMs: 90, fromScale: 1 },
    usesAccent: false,
    accentDefault: "#FACC15",
  },
  boxed: {
    id: "boxed",
    label: "Solid",
    description: "High-contrast box",
    fontWeight: 700,
    letterSpacingEm: 0,
    uppercase: false,
    textColor: "#FFFFFF",
    chip: { color: "#000000", opacity: 0.92, radiusEm: 0.14, padXEm: 0.5, padYEm: 0.22 },
    outline: null,
    shadow: null,
    highlight: null,
    animation: { inMs: 120, outMs: 90, fromScale: 1 },
    usesAccent: false,
    accentDefault: "#FACC15",
  },
  highlight: {
    id: "highlight",
    label: "Marker",
    description: "Accent chip, dark text",
    fontWeight: 700,
    letterSpacingEm: 0,
    uppercase: false,
    textColor: "#111827",
    chip: { color: "accent", opacity: 1, radiusEm: 0.24, padXEm: 0.5, padYEm: 0.2 },
    outline: null,
    shadow: { color: "#000000", opacity: 0.25, blurEm: 0.2, offsetYEm: 0.07 },
    highlight: null,
    animation: { inMs: 140, outMs: 100, fromScale: 0.96 },
    usesAccent: true,
    accentDefault: "#FACC15",
  },
  pop: {
    id: "pop",
    label: "Pop",
    description: "Bold outline, word highlight",
    fontWeight: 800,
    letterSpacingEm: 0,
    uppercase: true,
    textColor: "#FFFFFF",
    chip: null,
    outline: { color: "#000000", opacity: 1, widthEm: 0.11 },
    shadow: { color: "#000000", opacity: 0.6, blurEm: 0.14, offsetYEm: 0.07 },
    highlight: { mode: "word", activeColor: "accent", inactiveOpacity: 1 },
    animation: { inMs: 100, outMs: 80, fromScale: 0.9 },
    usesAccent: true,
    accentDefault: "#FACC15",
  },
  focus: {
    id: "focus",
    label: "Focus",
    description: "Chip, active word in focus",
    fontWeight: 700,
    letterSpacingEm: 0,
    uppercase: false,
    textColor: "#FFFFFF",
    chip: { color: "#0B0F17", opacity: 0.78, radiusEm: 0.34, padXEm: 0.6, padYEm: 0.28 },
    outline: null,
    shadow: { color: "#000000", opacity: 0.3, blurEm: 0.3, offsetYEm: 0.1 },
    highlight: { mode: "focus", activeColor: "accent", inactiveOpacity: 0.5 },
    animation: { inMs: 140, outMs: 100, fromScale: 0.96 },
    usesAccent: true,
    accentDefault: "#FFFFFF",
  },
}

// Ordered for the picker UI — default first, focus last.
export const CAPTION_LOOK_LIST: CaptionLook[] = [
  CAPTION_LOOKS.default,
  CAPTION_LOOKS.minimal,
  CAPTION_LOOKS.boxed,
  CAPTION_LOOKS.highlight,
  CAPTION_LOOKS.pop,
  CAPTION_LOOKS.focus,
]
