import { z } from "zod"

export const titleTemplateSchema = z.enum([
  "clean-text",
  "emphasis",
  "editorial-opener",
  "kinetic-hook",
  "chapter-marker",
  "speaker-id",
  "source-credit",
  "step-guide",
  "shortcut",
  "command-line",
  "note",
  "pull-quote",
  "metric",
  "call-to-action",
])

export type TitleTemplate = z.infer<typeof titleTemplateSchema>

// Per-element absolute sizes (in clip units). A set field replaces the template's
// `fontSize * ratio` default for that element, so each line sizes independently.
const titleFontSizeSchema = z.number().min(4).max(600)

export const titleDesignSchema = z.object({
  version: z.literal(1),
  template: titleTemplateSchema,
  appearance: z.enum(["dark", "light", "transparent"]).default("dark"),
  motion: z.enum(["designed", "subtle", "none"]).default("designed"),
  tempo: z.number().min(0.5).max(2).default(1),
  fontSizes: z
    .object({
      primary: titleFontSizeSchema.optional(),
      secondary: titleFontSizeSchema.optional(),
      tag: titleFontSizeSchema.optional(),
      metric: titleFontSizeSchema.optional(),
    })
    .default({}),
  emphasisText: z.string().max(500).default(""),
  noteTone: z.enum(["note", "tip", "warning"]).default("tip"),
  letterSpacing: z.number().min(-0.05).max(0.2).default(0),
  lineHeight: z.number().min(0.9).max(1.8).default(1.15),
  metric: z
    .object({
      from: z.number().min(-1_000_000_000).max(1_000_000_000).default(0),
      to: z.number().min(-1_000_000_000).max(1_000_000_000).default(98),
      decimals: z.number().int().min(0).max(3).default(0),
      prefix: z.string().max(20).default(""),
      suffix: z.string().max(20).default("%"),
    })
    .default({}),
})

export type TitleDesign = z.infer<typeof titleDesignSchema>

export const titleSceneElementSchema = z.object({
  path: z.string(),
  fill: z.string(),
  opacity: z.number().min(0).max(1),
  translateX: z.number(),
  translateY: z.number(),
  scaleX: z.number(),
  scaleY: z.number(),
  clip: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().min(0),
      height: z.number().min(0),
    })
    .optional(),
})

export const titleSceneSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  elements: z.array(titleSceneElementSchema),
})

export type TitleSceneElement = z.infer<typeof titleSceneElementSchema>
export type TitleScene = z.infer<typeof titleSceneSchema>
