import type { TitleDesign, TitleTemplate } from "@recordforge/domain"

// These are authored overlay colors, not shell UI tokens; export must work without CSS.
export const TITLE_APPEARANCE_COLORS = {
  dark: {
    textColor: "rgb(244, 247, 251)",
    secondaryTextColor: "rgba(244, 247, 251, 0.72)",
    backdropColor: "rgb(16, 19, 26)",
  },
  light: {
    textColor: "rgb(32, 36, 44)",
    secondaryTextColor: "rgba(32, 36, 44, 0.72)",
    backdropColor: "rgb(255, 255, 255)",
  },
} as const

export interface TitlePresetGroupMeta {
  id: string
  label: string
}

export const TITLE_PRESET_GROUPS: readonly TitlePresetGroupMeta[] = [
  { id: "openers", label: "Openers" },
  { id: "lower-thirds", label: "Lower thirds" },
  { id: "social", label: "Social" },
  { id: "tutorial", label: "Tutorial" },
  { id: "data", label: "Data" },
  { id: "outro", label: "Outro" },
] as const

const TEMPLATE_GROUP: Record<TitleTemplate, string> = {
  "clean": "openers",
  "hook": "openers",
  "hook-emphasis": "openers",
  "editorial": "openers",
  "chapter": "openers",
  "kinetic": "openers",
  "highlight": "openers",
  "banner": "openers",
  "lower-third-bar": "lower-thirds",
  "lower-third-glass": "lower-thirds",
  "lower-third-line": "lower-thirds",
  "source": "lower-thirds",
  "social-handle": "social",
  "cta-follow": "social",
  "cta-link": "social",
  "cta": "social",
  "step": "tutorial",
  "checklist": "tutorial",
  "shortcut": "tutorial",
  "terminal": "tutorial",
  "callout": "tutorial",
  "quote": "tutorial",
  "location": "tutorial",
  "stat": "data",
  "stat-before-after": "data",
  "countdown": "data",
  "agenda": "data",
  "outro": "outro",
}

export const TITLE_PRESET_LABELS: Record<TitleTemplate, string> = {
  "clean": "Clean Title",
  "hook": "Hook Headline",
  "hook-emphasis": "Emphasis",
  "editorial": "Editorial Opener",
  "chapter": "Chapter Card",
  "kinetic": "Kinetic Words",
  "highlight": "Marker Highlight",
  "banner": "Announcement Banner",
  "lower-third-bar": "Lower Third · Bar",
  "lower-third-glass": "Lower Third · Glass",
  "lower-third-line": "Lower Third · Line",
  "source": "Source Credit",
  "social-handle": "Social Handle",
  "cta-follow": "Subscribe / Follow CTA",
  "cta-link": "Link CTA",
  "cta": "Call to Action",
  "step": "Numbered Step",
  "checklist": "Checklist",
  "shortcut": "Keyboard Shortcut",
  "terminal": "Terminal Command",
  "callout": "Callout",
  "quote": "Quote / Testimonial",
  "location": "Location / Date Stamp",
  "stat": "Stat Counter",
  "stat-before-after": "Before → After",
  "countdown": "Countdown 3-2-1",
  "agenda": "Agenda / Progress List",
  "outro": "End Screen / Outro",
}

// Legacy v1 template ids still appear in older custom presets and project files.
// Mapped here once so preset UI and migration code share the table.
const V1_TEMPLATE_ALIASES: Record<string, TitleTemplate> = {
  "clean-text": "clean",
  "emphasis": "hook-emphasis",
  "editorial-opener": "editorial",
  "kinetic-hook": "hook",
  "chapter-marker": "chapter",
  "speaker-id": "lower-third-bar",
  "source-credit": "source",
  "step-guide": "step",
  "command-line": "terminal",
  "note": "callout",
  "pull-quote": "quote",
  "metric": "stat",
  "call-to-action": "cta",
}

export function resolveTitleTemplate(template: string | undefined): TitleTemplate {
  if (!template) return "clean"
  if (template in TEMPLATE_GROUP) return template as TitleTemplate
  const mapped = V1_TEMPLATE_ALIASES[template]
  return mapped ?? "clean"
}

export function getTitlePresetGroup(template: TitleTemplate | string | undefined): string {
  // Legacy presets carry no design; keep them in their own browser group.
  if (!template) return "legacy"
  return TEMPLATE_GROUP[resolveTitleTemplate(template)]
}

export function getTitleTemplateLabel(template: TitleTemplate | string | undefined): string {
  return TITLE_PRESET_LABELS[resolveTitleTemplate(template)]
}

export function getTitlePresetGroupLabel(groupId: string | undefined): string {
  const group = TITLE_PRESET_GROUPS.find((entry) => entry.id === groupId)
  return group?.label ?? "Openers"
}

export function getTitleStyleOverrides(template: TitleTemplate | string | undefined): {
  fontFamily?: "sans" | "serif" | "mono" | "heading" | "display" | "grotesk"
  fontWeight?: string
} {
  switch (resolveTitleTemplate(template)) {
    case "editorial":
    case "quote":
      return { fontFamily: "serif", fontWeight: "500" }
    case "terminal":
    case "shortcut":
      return { fontFamily: "mono", fontWeight: "500" }
    case "hook":
    case "kinetic":
    case "banner":
      return { fontFamily: "heading", fontWeight: "800" }
    case "stat":
    case "stat-before-after":
    case "countdown":
    case "outro":
      return { fontFamily: "heading", fontWeight: "700" }
    case "chapter":
    case "cta-follow":
    case "cta-link":
      return { fontFamily: "heading", fontWeight: "700" }
    default:
      return {}
  }
}

// Preview card aspect ratios: roughly how each template fills its design frame.
export function getTitlePresetHeightRatio(template: TitleTemplate | string | undefined): number {
  switch (resolveTitleTemplate(template)) {
    case "editorial":
    case "hook":
    case "kinetic":
    case "stat":
    case "stat-before-after":
    case "outro":
      return 0.62
    case "countdown":
      return 0.8
    case "checklist":
    case "agenda":
    case "quote":
    case "cta-link":
    case "cta-follow":
      return 0.5
    case "banner":
    case "chapter":
    case "cta":
      return 0.34
    case "source":
    case "location":
      return 0.26
    case "lower-third-bar":
    case "lower-third-glass":
    case "lower-third-line":
    case "social-handle":
    case "step":
    case "terminal":
    case "callout":
    case "shortcut":
      return 0.3
    case "clean":
    case "hook-emphasis":
    case "highlight":
      return 0.42
    default:
      return 0.32
  }
}

// ─── Editor-facing title helpers ─────────────────────────────────────────────

export interface TitleContentLabels {
  primary: string
  secondary: string
  tag: string
}

const titleLabels: Record<TitleTemplate, TitleContentLabels> = {
  clean: { primary: "Title", secondary: "Subtitle", tag: "Tag" },
  hook: { primary: "Hook", secondary: "Supporting text", tag: "Kicker" },
  "hook-emphasis": { primary: "Statement", secondary: "Supporting text", tag: "Kicker" },
  editorial: { primary: "Headline", secondary: "Subtitle", tag: "Eyebrow" },
  chapter: { primary: "Chapter title", secondary: "Description", tag: "Chapter number" },
  kinetic: { primary: "Hook", secondary: "Supporting text", tag: "Tag" },
  highlight: { primary: "Text to highlight", secondary: "Supporting text", tag: "Tag" },
  banner: { primary: "Announcement", secondary: "Detail", tag: "Label" },
  "lower-third-bar": { primary: "Name", secondary: "Role", tag: "Tag" },
  "lower-third-glass": { primary: "Name", secondary: "Role", tag: "Tag" },
  "lower-third-line": { primary: "Name", secondary: "Role", tag: "Tag" },
  source: { primary: "Source", secondary: "Credit or URL", tag: "Label" },
  "social-handle": { primary: "Handle", secondary: "Detail", tag: "Label" },
  "cta-follow": { primary: "Prompt", secondary: "Detail", tag: "Button" },
  "cta-link": { primary: "Action", secondary: "Detail", tag: "Destination" },
  cta: { primary: "Action", secondary: "Supporting text", tag: "Link or handle" },
  step: { primary: "Instruction", secondary: "Detail", tag: "Step number" },
  checklist: { primary: "List title", secondary: "Items (one per line)", tag: "Tag" },
  shortcut: { primary: "Keys", secondary: "Action", tag: "Platform" },
  terminal: { primary: "Command", secondary: "Description", tag: "Shell" },
  callout: { primary: "Note", secondary: "Detail", tag: "Label" },
  quote: { primary: "Quote", secondary: "Attribution", tag: "Source" },
  location: { primary: "Place", secondary: "Date or detail", tag: "Tag" },
  stat: { primary: "Metric label", secondary: "Context", tag: "Period" },
  "stat-before-after": { primary: "Metric label", secondary: "Context", tag: "Label" },
  countdown: { primary: "Label", secondary: "Detail", tag: "Tag" },
  agenda: { primary: "List title", secondary: "Items (one per line)", tag: "Tag" },
  outro: { primary: "Sign-off", secondary: "Detail", tag: "Handle" },
}

export function getTitleContentLabels(template?: TitleTemplate | string): TitleContentLabels {
  const resolved = resolveTitleTemplate(template)
  return {
    ...(template ? titleLabels[resolved] : { primary: "Primary text", secondary: "Secondary text", tag: "Tag" }),
  }
}

export interface TitleFontSizeRatios {
  primary: number
  secondary: number
  tag: number
  metric: number
}

// Mirrors `size_ratios` in packages/overlay-engine/src/title_layout.rs: each
// element's default size is `fontSize * ratio`. An explicit
// `titleDesign.elements.<role>.size` override replaces that default.
const titleFontSizeRatios: Record<TitleTemplate, TitleFontSizeRatios> = {
  hook: { primary: 1.3, secondary: 0.3, tag: 0.22, metric: 1 },
  "hook-emphasis": { primary: 1.15, secondary: 0.3, tag: 0.22, metric: 1 },
  clean: { primary: 1, secondary: 0.34, tag: 0.27, metric: 1 },
  editorial: { primary: 1.15, secondary: 0.3, tag: 0.23, metric: 1 },
  chapter: { primary: 1, secondary: 0.33, tag: 1.8, metric: 1 },
  "lower-third-bar": { primary: 1, secondary: 0.42, tag: 0.24, metric: 1 },
  "lower-third-glass": { primary: 1, secondary: 0.42, tag: 0.24, metric: 1 },
  "lower-third-line": { primary: 1, secondary: 0.42, tag: 0.24, metric: 1 },
  "social-handle": { primary: 0.9, secondary: 0.34, tag: 0.24, metric: 1 },
  "cta-follow": { primary: 0.9, secondary: 0.34, tag: 0.24, metric: 1 },
  "cta-link": { primary: 0.9, secondary: 0.34, tag: 0.24, metric: 1 },
  cta: { primary: 0.9, secondary: 0.34, tag: 0.24, metric: 1 },
  step: { primary: 0.9, secondary: 0.33, tag: 0.7, metric: 1 },
  checklist: { primary: 0.6, secondary: 0.4, tag: 0.24, metric: 1 },
  shortcut: { primary: 0.57, secondary: 0.33, tag: 0.24, metric: 1 },
  terminal: { primary: 0.62, secondary: 0.25, tag: 0.22, metric: 1 },
  callout: { primary: 0.85, secondary: 0.31, tag: 0.25, metric: 1 },
  quote: { primary: 1, secondary: 0.27, tag: 0.23, metric: 1 },
  location: { primary: 0.8, secondary: 0.3, tag: 0.22, metric: 1 },
  banner: { primary: 0.9, secondary: 0.3, tag: 0.2, metric: 1 },
  highlight: { primary: 1, secondary: 0.3, tag: 0.2, metric: 1 },
  kinetic: { primary: 1.25, secondary: 0.3, tag: 0.24, metric: 1 },
  agenda: { primary: 0.6, secondary: 0.36, tag: 0.24, metric: 1 },
  outro: { primary: 1.1, secondary: 0.3, tag: 0.26, metric: 1 },
  source: { primary: 0.7, secondary: 0.28, tag: 0.23, metric: 1 },
  stat: { primary: 0.34, secondary: 0.24, tag: 0.23, metric: 1.7 },
  "stat-before-after": { primary: 0.3, secondary: 0.22, tag: 0.2, metric: 1.5 },
  countdown: { primary: 0.2, secondary: 0.15, tag: 0.15, metric: 2.6 },
}

export type TitleFontSizeKey = keyof TitleFontSizeRatios

/** Effective per-element sizes in clip units: the explicit override, else `fontSize * ratio`. */
export function resolveTitleFontSizes(
  design: TitleDesign,
  baseFontSize: number,
): Record<TitleFontSizeKey, number> {
  const ratios = titleFontSizeRatios[design.template]
  const overrides = design.elements
  return {
    primary: overrides.primary?.size ?? baseFontSize * ratios.primary,
    secondary: overrides.secondary?.size ?? baseFontSize * ratios.secondary,
    tag: overrides.tag?.size ?? baseFontSize * ratios.tag,
    metric: overrides.metric?.size ?? baseFontSize * ratios.metric,
  }
}

export function hasTitleFontSizeOverrides(design: TitleDesign): boolean {
  return Object.values(design.elements).some((style) => style?.size !== undefined)
}

export interface TitlePreviewBackground {
  id: string
  label: string
  background: string
  surface?: string
}

export const TITLE_PREVIEW_BACKGROUNDS: readonly TitlePreviewBackground[] = [
  {
    id: "dark",
    label: "Dark",
    background:
      "linear-gradient(160deg, rgba(8, 12, 18, 1) 0%, rgba(18, 24, 34, 1) 45%, rgba(33, 42, 54, 1) 100%)",
  },
  {
    id: "light",
    label: "Light",
    background:
      "linear-gradient(160deg, rgba(250, 251, 254, 1) 0%, rgba(230, 234, 242, 1) 55%, rgba(214, 221, 232, 1) 100%)",
  },
  {
    id: "vibrant",
    label: "Vibrant",
    background:
      "radial-gradient(140% 120% at 18% 16%, rgba(124, 92, 255, 0.9) 0%, rgba(35, 33, 80, 0.95) 48%, rgba(7, 10, 20, 1) 100%)",
  },
  {
    id: "video",
    label: "Video",
    background:
      "linear-gradient(160deg, rgba(10, 30, 34, 0.94) 0%, rgba(7, 52, 64, 0.92) 40%, rgba(10, 12, 20, 0.98) 100%), linear-gradient(120deg, rgba(94, 234, 212, 0.28), rgba(59, 130, 246, 0.22) 55%, rgba(244, 114, 182, 0.2))",
  },
] as const
