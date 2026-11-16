import { z } from "zod"

// ─── v2 template catalog ──────────────────────────────────────────────────────
// The curated M5 catalog. `hook-emphasis` exists so the v1 `emphasis` template
// has a dedicated migration target that renders a highlighted phrase.

export const titleTemplateSchema = z.enum([
  "hook",
  "hook-emphasis",
  "clean",
  "editorial",
  "chapter",
  "lower-third-bar",
  "lower-third-glass",
  "lower-third-line",
  "social-handle",
  "cta",
  "cta-follow",
  "cta-link",
  "step",
  "checklist",
  "shortcut",
  "terminal",
  "callout",
  "quote",
  "stat",
  "stat-before-after",
  "countdown",
  "location",
  "banner",
  "highlight",
  "kinetic",
  "agenda",
  "outro",
  "source",
])

export type TitleTemplate = z.infer<typeof titleTemplateSchema>

// ─── v1 schema (kept for load-time migration) ────────────────────────────────

export const titleTemplateV1Schema = z.enum([
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

export type TitleTemplateV1 = z.infer<typeof titleTemplateV1Schema>

const titleDesignV1Schema = z.object({
  version: z.literal(1),
  template: titleTemplateV1Schema,
  appearance: z.enum(["dark", "light", "transparent"]).default("dark"),
  motion: z.enum(["designed", "subtle", "none"]).default("designed"),
  tempo: z.number().min(0.5).max(2).default(1),
  fontSizes: z
    .object({
      primary: z.number().min(4).max(600).optional(),
      secondary: z.number().min(4).max(600).optional(),
      tag: z.number().min(4).max(600).optional(),
      metric: z.number().min(4).max(600).optional(),
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
    .default(() => ({ from: 0, to: 98, decimals: 0, prefix: "", suffix: "%" })),
})

export type TitleDesignV1 = z.infer<typeof titleDesignV1Schema>

// v1 → v2 template migration map from the M5 plan.
export const TITLE_TEMPLATE_V1_TO_V2: Record<TitleTemplateV1, TitleTemplate> = {
  "clean-text": "clean",
  emphasis: "hook-emphasis",
  "editorial-opener": "editorial",
  "kinetic-hook": "hook",
  "chapter-marker": "chapter",
  "speaker-id": "lower-third-bar",
  "source-credit": "source",
  "step-guide": "step",
  shortcut: "shortcut",
  "command-line": "terminal",
  note: "callout",
  "pull-quote": "quote",
  metric: "stat",
  "call-to-action": "cta",
}

// ─── v2 building blocks ───────────────────────────────────────────────────────

export const titleFontFamilySchema = z.enum([
  "sans",
  "serif",
  "mono",
  "heading",
  "inter",
  "outfit",
  "display",
  "grotesk",
])
export type TitleFontFamily = z.infer<typeof titleFontFamilySchema>

export const titleFontWeightSchema = z.enum([
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
])
export type TitleFontWeight = z.infer<typeof titleFontWeightSchema>

export const titleTextTransformSchema = z.enum([
  "none",
  "uppercase",
  "lowercase",
  "capitalize",
])
export type TitleTextTransform = z.infer<typeof titleTextTransformSchema>

export const titleTextAlignSchema = z.enum(["left", "center", "right"])
export type TitleTextAlign = z.infer<typeof titleTextAlignSchema>

// Global typography defaults. `family`/`align` fall back to the clip's own
// fontFamily/alignment when unset so preset application keeps a single source
// of truth for the base face.
export const titleTypographySchema = z.object({
  family: titleFontFamilySchema.optional(),
  align: titleTextAlignSchema.optional(),
  letterSpacing: z.number().min(-0.05).max(0.5).default(0),
  lineHeight: z.number().min(0.8).max(2.2).default(1.15),
  textTransform: titleTextTransformSchema.default("none"),
})
export type TitleTypography = z.infer<typeof titleTypographySchema>

// Per-element overrides. Only set fields win over the template/global defaults.
export const titleElementStyleSchema = z.object({
  family: titleFontFamilySchema.optional(),
  size: z.number().min(4).max(1200).optional(),
  weight: titleFontWeightSchema.optional(),
  letterSpacing: z.number().min(-0.05).max(0.5).optional(),
  lineHeight: z.number().min(0.8).max(2.2).optional(),
  textTransform: titleTextTransformSchema.optional(),
  color: z.string().min(1).optional(),
})
export type TitleElementStyle = z.infer<typeof titleElementStyleSchema>

export const titleElementsSchema = z.object({
  tag: titleElementStyleSchema.optional(),
  primary: titleElementStyleSchema.optional(),
  secondary: titleElementStyleSchema.optional(),
  metric: titleElementStyleSchema.optional(),
})
export type TitleElements = z.infer<typeof titleElementsSchema>

export const titleGradientStopSchema = z.object({
  offset: z.number().min(0).max(1),
  color: z.string().min(1),
})
export type TitleGradientStop = z.infer<typeof titleGradientStopSchema>

// `gradientAngle` uses CSS bearings: 0 = up, 90 = right, 180 = down.
export const titleFillSchema = z.object({
  kind: z.enum(["solid", "gradient"]).default("solid"),
  gradientAngle: z.number().min(0).max(360).default(135),
  gradientStops: z
    .array(titleGradientStopSchema)
    .min(2)
    .max(6)
    .default([
      { offset: 0, color: "#fafafa" },
      { offset: 1, color: "#93c5fd" },
    ]),
})
export type TitleFill = z.infer<typeof titleFillSchema>

export const titleStrokeSchema = z.object({
  color: z.string().min(1),
  width: z.number().min(0.25).max(40).default(2),
})
export type TitleStroke = z.infer<typeof titleStrokeSchema>

export const titleShadowSchema = z.object({
  color: z.string().min(1).default("rgba(0, 0, 0, 0.45)"),
  blur: z.number().min(0).max(200).default(24),
  offsetX: z.number().min(-200).max(200).default(0),
  offsetY: z.number().min(-200).max(200).default(8),
})
export type TitleShadow = z.infer<typeof titleShadowSchema>

// Glow color falls back to the clip accent color when unset.
export const titleGlowSchema = z.object({
  color: z.string().min(1).optional(),
  blur: z.number().min(1).max(200).default(36),
})
export type TitleGlow = z.infer<typeof titleGlowSchema>

export const titleEmphasisStyleSchema = z.enum([
  "color",
  "marker",
  "underline",
  "strike",
  "box",
])
export type TitleEmphasisStyle = z.infer<typeof titleEmphasisStyleSchema>

export const titleEmphasisSchema = z.object({
  text: z.string().max(500).default(""),
  style: titleEmphasisStyleSchema.default("color"),
  color: z.string().min(1).optional(),
})
export type TitleEmphasis = z.infer<typeof titleEmphasisSchema>

export const titleBackdropStyleSchema = z.enum([
  "none",
  "box",
  "pill",
  "glass",
  "bar",
  "brackets",
  "split",
])
export type TitleBackdropStyleV2 = z.infer<typeof titleBackdropStyleSchema>

// Unset fields fall back to the clip's backdrop color/opacity/radius/padding so
// existing palette controls keep working.
export const titleBackdropSchema = z.object({
  style: titleBackdropStyleSchema.default("none"),
  color: z.string().min(1).optional(),
  opacity: z.number().min(0).max(1).optional(),
  radius: z.number().min(0).max(400).optional(),
  paddingX: z.number().min(0).max(400).optional(),
  paddingY: z.number().min(0).max(400).optional(),
})
export type TitleBackdrop = z.infer<typeof titleBackdropSchema>

export const titleAccentSchema = z.object({
  style: z.enum(["none", "bar", "dot", "number"]).default("none"),
  color: z.string().min(1).optional(),
})
export type TitleAccent = z.infer<typeof titleAccentSchema>

// 9-point anchor inside the canvas safe area plus a px offset (from dragging).
// Render-plan builders resolve anchor+margins to x/y so titles re-adapt when a
// project moves between 16:9, 9:16 and 1:1 canvases.
export const titlePlacementAnchorSchema = z.enum([
  "tl",
  "tc",
  "tr",
  "cl",
  "cc",
  "cr",
  "bl",
  "bc",
  "br",
])
export type TitlePlacementAnchor = z.infer<typeof titlePlacementAnchorSchema>

export const titlePlacementSchema = z.object({
  anchor: titlePlacementAnchorSchema.default("cc"),
  marginX: z.number().min(0).default(96),
  marginY: z.number().min(0).default(96),
  offsetX: z.number().default(0),
  offsetY: z.number().default(0),
})
export type TitlePlacement = z.infer<typeof titlePlacementSchema>

// ─── Animation system ─────────────────────────────────────────────────────────

export const titleAnimationPresetSchema = z.enum([
  "none",
  "fade",
  "rise",
  "drop",
  "slide-left",
  "slide-right",
  "scale-pop",
  "zoom",
  "blur-in",
  "typewriter",
  "mask-wipe",
  "split-reveal",
  "tracking-expand",
  "flip",
  "bounce",
  "highlight-sweep",
  "underline-draw",
  "counter",
])
export type TitleAnimationPreset = z.infer<typeof titleAnimationPresetSchema>

export const titleAnimationUnitSchema = z.enum(["block", "line", "word", "char"])
export type TitleAnimationUnit = z.infer<typeof titleAnimationUnitSchema>

export const titleAnimationEasingSchema = z.enum([
  "linear",
  "cubic-in",
  "cubic-out",
  "cubic-in-out",
  "expo-in",
  "expo-out",
  "expo-in-out",
  "back-out",
  "elastic-out",
  "spring",
])
export type TitleAnimationEasing = z.infer<typeof titleAnimationEasingSchema>

export const titleAnimationDirectionSchema = z.enum([
  "normal",
  "reverse",
  "center-out",
  "edges-in",
  "random",
])
export type TitleAnimationDirection = z.infer<typeof titleAnimationDirectionSchema>

export const titleAnimationSpecSchema = z.object({
  preset: titleAnimationPresetSchema.default("fade"),
  unit: titleAnimationUnitSchema.default("block"),
  durationMs: z.number().min(0).max(10_000).default(450),
  staggerMs: z.number().min(0).max(2_000).default(60),
  easing: titleAnimationEasingSchema.default("expo-out"),
  direction: titleAnimationDirectionSchema.default("normal"),
})
export type TitleAnimationSpec = z.infer<typeof titleAnimationSpecSchema>

export const titleEmphasisLoopSchema = z.object({
  preset: z.enum(["none", "pulse", "shimmer", "float"]).default("none"),
  periodMs: z.number().min(200).max(10_000).default(2400),
  amplitude: z.number().min(0).max(1).default(0.5),
})
export type TitleEmphasisLoop = z.infer<typeof titleEmphasisLoopSchema>

export const titleAnimationSchema = z.object({
  in: titleAnimationSpecSchema.default({
    preset: "fade",
    unit: "block",
    durationMs: 450,
    staggerMs: 60,
    easing: "expo-out",
    direction: "normal",
  }),
  out: titleAnimationSpecSchema.default({
    preset: "fade",
    unit: "block",
    durationMs: 300,
    staggerMs: 40,
    easing: "expo-in",
    direction: "normal",
  }),
  emphasis: titleEmphasisLoopSchema.optional(),
})
export type TitleAnimation = z.infer<typeof titleAnimationSchema>

export const titleMetricSchema = z.object({
  from: z.number().min(-1_000_000_000).max(1_000_000_000).default(0),
  to: z.number().min(-1_000_000_000).max(1_000_000_000).default(98),
  decimals: z.number().int().min(0).max(3).default(0),
  prefix: z.string().max(20).default(""),
  suffix: z.string().max(20).default("%"),
})
export type TitleMetric = z.infer<typeof titleMetricSchema>

// ─── v2 root schema ───────────────────────────────────────────────────────────

export const titleDesignV2Schema = z.object({
  version: z.literal(2),
  template: titleTemplateSchema,
  tempo: z.number().min(0.5).max(2).default(1),
  typography: titleTypographySchema.default(() => titleTypographySchema.parse({})),
  elements: titleElementsSchema.default(() => titleElementsSchema.parse({})),
  fill: titleFillSchema.default(() => titleFillSchema.parse({})),
  stroke: titleStrokeSchema.optional(),
  shadow: titleShadowSchema.optional(),
  glow: titleGlowSchema.optional(),
  emphasis: titleEmphasisSchema.default(() => titleEmphasisSchema.parse({})),
  backdrop: titleBackdropSchema.default(() => titleBackdropSchema.parse({})),
  accent: titleAccentSchema.default(() => titleAccentSchema.parse({})),
  placement: titlePlacementSchema.default(() => titlePlacementSchema.parse({})),
  animation: titleAnimationSchema.default(() => titleAnimationSchema.parse({})),
  metric: titleMetricSchema.default(() => titleMetricSchema.parse({})),
  noteTone: z.enum(["note", "tip", "warning"]).default("tip"),
})
export type TitleDesignV2 = z.infer<typeof titleDesignV2Schema>
export type TitleDesign = TitleDesignV2

// ─── v1 → v2 migration ────────────────────────────────────────────────────────

// Motion mapping: "subtle" → a quiet fade; "designed" → per-template defaults
// (mirroring TITLE_ANIMATION_DEFAULTS in the Rust engine); "none" → no motion.
const SUBTLE_IN: z.input<typeof titleAnimationSpecSchema> = {
  preset: "rise",
  unit: "block",
  durationMs: 420,
  staggerMs: 0,
  easing: "expo-out",
  direction: "normal",
}
const SUBTLE_OUT: z.input<typeof titleAnimationSpecSchema> = {
  preset: "fade",
  unit: "block",
  durationMs: 260,
  staggerMs: 0,
  easing: "expo-in",
  direction: "normal",
}
const NO_MOTION: z.input<typeof titleAnimationSpecSchema> = {
  preset: "none",
  unit: "block",
  durationMs: 0,
  staggerMs: 0,
  easing: "linear",
  direction: "normal",
}

function designedAnimationIn(template: TitleTemplate): z.input<typeof titleAnimationSpecSchema> {
  switch (template) {
    case "kinetic":
    case "hook":
    case "hook-emphasis":
      return { preset: "scale-pop", unit: "word", durationMs: 480, staggerMs: 70, easing: "back-out", direction: "normal" }
    case "terminal":
      return { preset: "typewriter", unit: "char", durationMs: 700, staggerMs: 24, easing: "linear", direction: "normal" }
    case "highlight":
      return { preset: "highlight-sweep", unit: "line", durationMs: 520, staggerMs: 120, easing: "expo-out", direction: "normal" }
    case "countdown":
      return { preset: "counter", unit: "block", durationMs: 600, staggerMs: 0, easing: "expo-out", direction: "normal" }
    case "stat":
    case "stat-before-after":
      return { preset: "counter", unit: "block", durationMs: 900, staggerMs: 0, easing: "expo-out", direction: "normal" }
    case "lower-third-bar":
    case "lower-third-glass":
    case "lower-third-line":
      return { preset: "slide-left", unit: "block", durationMs: 380, staggerMs: 80, easing: "expo-out", direction: "normal" }
    case "checklist":
    case "agenda":
      return { preset: "rise", unit: "line", durationMs: 400, staggerMs: 110, easing: "expo-out", direction: "normal" }
    case "banner":
      return { preset: "mask-wipe", unit: "block", durationMs: 500, staggerMs: 0, easing: "expo-out", direction: "normal" }
    default:
      return { preset: "rise", unit: "line", durationMs: 460, staggerMs: 90, easing: "expo-out", direction: "normal" }
  }
}

function designedAnimationOut(): z.input<typeof titleAnimationSpecSchema> {
  return { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" }
}

export interface TitleDesignV1ClipContext {
  backdropStyle?: string
  shadowEnabled?: boolean
  shadowColor?: string
  shadowBlur?: number
}

/**
 * Migrate a v1 design object (raw JSON) to v2 input. `clip` context lets the
 * text-clip schema preserve the legacy backdrop/shadow fields the v1 engine
 * read from sibling clip fields; standalone parses (presets, render plans)
 * use sensible defaults instead.
 */
export function migrateTitleDesignV1(
  input: Record<string, unknown>,
  clip?: TitleDesignV1ClipContext,
): Record<string, unknown> {
  // Safe-parse inside the preprocess: a thrown ZodError would escape
  // `safeParse` on the outer schema, so invalid v1 payloads fall through to
  // the v2 parser and surface as a normal validation failure.
  const parsed = titleDesignV1Schema.safeParse(input)
  if (!parsed.success) return input
  const v1 = parsed.data
  const template = TITLE_TEMPLATE_V1_TO_V2[v1.template]
  const elements: Record<string, unknown> = {}
  const sizeMap: Record<string, number | undefined> = {
    primary: v1.fontSizes.primary,
    secondary: v1.fontSizes.secondary,
    tag: v1.fontSizes.tag,
    metric: v1.fontSizes.metric,
  }
  for (const [role, size] of Object.entries(sizeMap)) {
    if (size !== undefined) elements[role] = { size }
  }

  let backdropStyle: string = "box"
  if (v1.appearance === "transparent") {
    backdropStyle = "none"
  } else if (clip?.backdropStyle) {
    // Legacy clips styled the backdrop via clip fields; preserve the mapping so
    // loaded projects look unchanged.
    backdropStyle =
      clip.backdropStyle === "none"
        ? "none"
        : clip.backdropStyle === "accent-bar"
          ? "bar"
          : clip.backdropStyle === "gradient" || clip.backdropStyle === "outline"
            ? "box"
            : clip.backdropStyle
  }

  const animation =
    v1.motion === "none"
      ? { in: NO_MOTION, out: NO_MOTION }
      : v1.motion === "subtle"
        ? { in: SUBTLE_IN, out: SUBTLE_OUT }
        : { in: designedAnimationIn(template), out: designedAnimationOut() }

  return {
    version: 2,
    template,
    tempo: v1.tempo,
    typography: {
      letterSpacing: v1.letterSpacing,
      lineHeight: v1.lineHeight,
      textTransform: "none",
    },
    elements,
    fill: { kind: "solid" },
    ...(clip?.shadowEnabled
      ? {
          shadow: {
            color: clip.shadowColor ?? "rgba(0, 0, 0, 0.45)",
            blur: clip.shadowBlur ?? 24,
            offsetX: 0,
            offsetY: 8,
          },
        }
      : {}),
    emphasis: {
      text: v1.emphasisText,
      // v1 rendered an accent highlight + underline on the emphasis phrase.
      style: "marker",
    },
    backdrop: { style: backdropStyle },
    accent: { style: "none" },
    placement: { anchor: "cc", marginX: 96, marginY: 96, offsetX: 0, offsetY: 0 },
    animation,
    metric: v1.metric,
    noteTone: v1.noteTone,
  }
}

function preprocessTitleDesign(input: unknown): unknown {
  if (typeof input === "object" && input !== null) {
    const version = (input as Record<string, unknown>).version
    if (version === 1) return migrateTitleDesignV1(input as Record<string, unknown>)
    // Older app builds may have written `version: 2` designs; anything without a
    // recognizable version is left for the v2 parser to reject.
    if (version === 2) return input
  }
  return input
}

// Version-tolerant schema: v1 payloads migrate at load time (project files,
// custom presets, render plans) so all downstream code sees v2 only.
export const titleDesignSchema: z.ZodType<TitleDesignV2, unknown> = z.preprocess(
  preprocessTitleDesign,
  titleDesignV2Schema,
) as z.ZodType<TitleDesignV2, unknown>

// ─── Scene output ─────────────────────────────────────────────────────────────
// Scene elements are vector paths in item-local space. `gradient`/`stroke`
// extend the flat-fill model; coordinates live in path-local space (the same
// space the element's translate/scale maps from) so canvas and SVG renderers
// agree without either knowing the element's bounds.

export const titleSceneGradientSchema = z.object({
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
  stops: z.array(titleGradientStopSchema).min(2).max(6),
})
export type TitleSceneGradient = z.infer<typeof titleSceneGradientSchema>

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
  gradient: titleSceneGradientSchema.optional(),
  stroke: z
    .object({
      color: z.string(),
      width: z.number().min(0),
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
