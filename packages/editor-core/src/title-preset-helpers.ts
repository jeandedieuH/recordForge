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
