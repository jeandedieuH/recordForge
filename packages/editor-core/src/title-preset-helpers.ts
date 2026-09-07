import {
  titleDesignSchema,
  type TextClip,
  type TitleDesign,
  type TitleTemplate,
} from "@recordforge/domain"

export type TitlePresetGroup =
  "essentials" | "openers" | "identity" | "tutorials" | "highlights" | "legacy"
export type TitleAppearance = TitleDesign["appearance"]

export interface TitleContentLabels {
  primary: string
  secondary: string
  tag: string
}

const titleGroups: Record<TitleTemplate, TitlePresetGroup> = {
  "clean-text": "essentials",
  emphasis: "essentials",
  "editorial-opener": "openers",
  "kinetic-hook": "openers",
  "chapter-marker": "openers",
  "speaker-id": "identity",
  "source-credit": "identity",
  "step-guide": "tutorials",
  shortcut: "tutorials",
  "command-line": "tutorials",
  note: "tutorials",
  "pull-quote": "highlights",
  metric: "highlights",
  "call-to-action": "highlights",
}

const titleLabels: Record<TitleTemplate, TitleContentLabels> = {
  "clean-text": { primary: "Title", secondary: "Subtitle", tag: "Tag" },
  emphasis: { primary: "Statement", secondary: "Supporting text", tag: "Tag" },
  "editorial-opener": { primary: "Headline", secondary: "Subtitle", tag: "Eyebrow" },
  "kinetic-hook": { primary: "Hook", secondary: "Supporting text", tag: "Tag" },
  "chapter-marker": { primary: "Chapter title", secondary: "Description", tag: "Chapter number" },
  "speaker-id": { primary: "Name", secondary: "Role", tag: "Tag" },
  "source-credit": { primary: "Source", secondary: "Credit or URL", tag: "Label" },
  "step-guide": { primary: "Instruction", secondary: "Detail", tag: "Step number" },
  shortcut: { primary: "Keys", secondary: "Action", tag: "Platform" },
  "command-line": { primary: "Command", secondary: "Description", tag: "Shell" },
  note: { primary: "Note", secondary: "Detail", tag: "Label" },
  "pull-quote": { primary: "Quote", secondary: "Attribution", tag: "Source" },
  metric: { primary: "Metric label", secondary: "Context", tag: "Period" },
  "call-to-action": { primary: "Action", secondary: "Supporting text", tag: "Link or handle" },
}

export function getTitlePresetGroup(template?: TitleTemplate): TitlePresetGroup {
  return template ? titleGroups[template] : "legacy"
}

export function getTitleContentLabels(template?: TitleTemplate): TitleContentLabels {
  return {
    ...(template
      ? titleLabels[template]
      : { primary: "Primary text", secondary: "Secondary text", tag: "Tag" }),
  }
}

export interface TitleFontSizeRatios {
  primary: number
  secondary: number
  tag: number
  metric: number
}

// Mirrors `size_ratios` in packages/overlay-engine/src/title_layout.rs: each element's
// default size is `fontSize * ratio`. An explicit `TitleDesign.fontSizes` override
// replaces that default so elements can be sized independently.
const titleFontSizeRatios: Record<TitleTemplate, TitleFontSizeRatios> = {
  "clean-text": { primary: 1, secondary: 0.34, tag: 0.27, metric: 1 },
  emphasis: { primary: 1.05, secondary: 0.32, tag: 0.24, metric: 1 },
  "editorial-opener": { primary: 1.15, secondary: 0.3, tag: 0.23, metric: 1 },
  "kinetic-hook": { primary: 1.25, secondary: 0.3, tag: 0.24, metric: 1 },
  "chapter-marker": { primary: 1, secondary: 0.33, tag: 1.8, metric: 1 },
  "speaker-id": { primary: 1, secondary: 0.36, tag: 0.24, metric: 1 },
  "source-credit": { primary: 0.7, secondary: 0.28, tag: 0.23, metric: 1 },
  "step-guide": { primary: 0.9, secondary: 0.33, tag: 0.7, metric: 1 },
  shortcut: { primary: 0.57, secondary: 0.33, tag: 0.24, metric: 1 },
  "command-line": { primary: 0.62, secondary: 0.25, tag: 0.22, metric: 1 },
  note: { primary: 0.85, secondary: 0.31, tag: 0.25, metric: 1 },
  "pull-quote": { primary: 1, secondary: 0.27, tag: 0.23, metric: 1 },
  metric: { primary: 0.34, secondary: 0.24, tag: 0.23, metric: 1.7 },
  "call-to-action": { primary: 1, secondary: 0.33, tag: 0.24, metric: 1 },
}

export type TitleFontSizeKey = keyof TitleFontSizeRatios

/** Effective per-element sizes in clip units: the explicit override, else `fontSize * ratio`. */
export function resolveTitleFontSizes(
  design: TitleDesign,
  baseFontSize: number,
): Record<TitleFontSizeKey, number> {
  const ratios = titleFontSizeRatios[design.template]
  const overrides = design.fontSizes
  return {
    primary: overrides.primary ?? baseFontSize * ratios.primary,
    secondary: overrides.secondary ?? baseFontSize * ratios.secondary,
    tag: overrides.tag ?? baseFontSize * ratios.tag,
    metric: overrides.metric ?? baseFontSize * ratios.metric,
  }
}

export function hasTitleFontSizeOverrides(design: TitleDesign): boolean {
  return Object.values(design.fontSizes).some((value) => value !== undefined)
}

// These are authored overlay colors, not shell UI tokens; export must work without CSS.
export const TITLE_APPEARANCE_COLORS = {
  dark: {
    textColor: "rgb(250, 250, 250)",
    secondaryTextColor: "rgb(180, 180, 180)",
    backdropColor: "rgb(18, 18, 18)",
  },
  light: {
    textColor: "rgb(20, 20, 20)",
    secondaryTextColor: "rgb(90, 90, 90)",
    backdropColor: "rgb(250, 250, 250)",
  },
  transparent: {
    textColor: "rgb(250, 250, 250)",
    secondaryTextColor: "rgb(210, 210, 210)",
    backdropColor: "rgb(18, 18, 18)",
  },
} satisfies Record<
  TitleAppearance,
  Pick<TextClip, "textColor" | "secondaryTextColor" | "backdropColor">
>

export function applyTitleAppearance(
  clip: TextClip,
  appearance: TitleAppearance,
): Partial<TextClip> {
  if (!clip.titleDesign) return {}
  return {
    ...TITLE_APPEARANCE_COLORS[appearance],
    backdropOpacity: appearance === "transparent" ? 0 : 0.96,
    titleDesign: titleDesignSchema.parse({ ...clip.titleDesign, appearance }),
  }
}
