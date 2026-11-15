import { z } from "zod"
import {
  overlayAnimationSchema,
  textAlignmentSchema,
  textAnimationSchema,
  textBackdropStyleSchema,
  textFontFamilySchema,
  titleDesignSchema,
  type TitleDesign,
  type OverlayAnimation,
  type TextAnimation,
  type TextBackdropStyle,
  type TextClip,
  type TextFontFamily,
  type TextFontWeight,
  type TitlePresetCategory,
} from "@recordforge/domain"
import textPresetCatalogJson from "./presets/text-presets.json"
import { CREATOR_TITLE_PRESET_CATALOG } from "./creator-title-presets"
import {
  parsePresetCatalog,
  type PresetCatalog,
  type PresetDefinition,
} from "./presets/preset-registry"

function toOverlayAnimationIn(animation: TextAnimation): OverlayAnimation["inType"] {
  if (animation === "zoom-punch") return "scale-up"
  if (animation === "expand-bar") return "slide-up"
  return animation
}

function toOverlayAnimationOut(animation: TextAnimation): OverlayAnimation["outType"] {
  if (animation === "zoom-punch") return "scale-down"
  if (animation === "expand-bar") return "slide-down"
  if (animation === "typewriter") return "fade"
  if (animation === "pop-in" || animation === "bounce") return "scale-down"
  return animation
}

export interface TextPresetDefinition {
  id: string
  name: string
  description: string
  category: TitlePresetCategory
  defaultPrimaryText: string
  defaultSecondaryText?: string
  defaultTagText?: string
  width: number
  height: number
  alignment: "left" | "center" | "right"
  fontFamily: TextFontFamily
  fontSize: number
  fontWeight: TextFontWeight
  textColor: string
  secondaryTextColor: string
  accentColor: string
  backdropStyle: TextBackdropStyle
  backdropColor: string
  backdropOpacity: number
  backdropBlur: number
  backdropBorderRadius: number
  backdropPaddingX: number
  backdropPaddingY: number
  shadowEnabled: boolean
  shadowColor: string
  shadowBlur: number
  animationIn: TextAnimation
  animationOut: TextAnimation
  overlayAnimation?: Partial<OverlayAnimation>
  autoScaleText?: boolean
  titleDesign?: TitleDesign
  rotation?: number
  anchorX?: number
  anchorY?: number
  zIndex?: number
  opacity?: number
  /**
   * Canvas scale the preset's absolute geometry was authored at (1 = 1080p).
   * Custom presets saved from 1440p/4K clips use this to avoid double scaling.
   */
  designScale?: number
}

export type TextPresetValues = Omit<
  TextPresetDefinition,
  "id" | "name" | "description" | "category"
>
export type TextPresetRecord = PresetDefinition<TextPresetValues>

export const textPresetValuesSchema = z.object({
  defaultPrimaryText: z.string().min(1),
  defaultSecondaryText: z.string().optional(),
  defaultTagText: z.string().optional(),
  width: z.number().min(20),
  height: z.number().min(20),
  alignment: textAlignmentSchema,
  fontFamily: textFontFamilySchema,
  fontSize: z.number().min(8).max(200),
  fontWeight: z.enum(["400", "500", "600", "700", "800", "900"]),
  textColor: z.string().min(1),
  secondaryTextColor: z.string().min(1),
  accentColor: z.string().min(1),
  backdropStyle: textBackdropStyleSchema,
  backdropColor: z.string().min(1),
  backdropOpacity: z.number().min(0).max(1),
  backdropBlur: z.number().min(0).max(64),
  backdropBorderRadius: z.number().min(0).max(100),
  backdropPaddingX: z.number().min(0).max(200),
  backdropPaddingY: z.number().min(0).max(200),
  shadowEnabled: z.boolean(),
  shadowColor: z.string().min(1),
  shadowBlur: z.number().min(0).max(100),
  animationIn: textAnimationSchema,
  animationOut: textAnimationSchema,
  overlayAnimation: overlayAnimationSchema.partial().optional(),
  autoScaleText: z.boolean().optional(),
  // The registry models normalized values as both input and output; parsing still fills defaults.
  titleDesign: (titleDesignSchema as z.ZodType<TitleDesign>).optional(),
  rotation: z.number().optional(),
  anchorX: z.number().min(0).max(1).optional(),
  anchorY: z.number().min(0).max(1).optional(),
  zIndex: z.number().int().optional(),
  opacity: z.number().min(0).max(1).optional(),
  designScale: z.number().positive().max(16).optional(),
})

export const LEGACY_TEXT_PRESET_CATALOG: PresetCatalog<TextPresetValues> = parsePresetCatalog(
  textPresetCatalogJson,
  textPresetValuesSchema,
)

export const TEXT_PRESET_CATALOG: PresetCatalog<TextPresetValues> = parsePresetCatalog(
  CREATOR_TITLE_PRESET_CATALOG,
  textPresetValuesSchema,
)

export const TEXT_PRESETS: TextPresetDefinition[] =
  TEXT_PRESET_CATALOG.presets.map(textPresetToDefinition)

export function textPresetToDefinition(preset: TextPresetRecord): TextPresetDefinition {
  return {
    ...preset.definition,
    id: preset.id,
    name: preset.name,
    description: preset.description,
    category: preset.category as TitlePresetCategory,
  }
}

export function getTextPresetRecordById(presetId: string): TextPresetRecord {
  const found =
    TEXT_PRESET_CATALOG.presets.find((preset) => preset.id === presetId) ??
    LEGACY_TEXT_PRESET_CATALOG.presets.find((preset) => preset.id === presetId)
  return found ?? TEXT_PRESET_CATALOG.presets[0]
}

export function getTextPresetById(presetId: string): TextPresetDefinition {
  return textPresetToDefinition(getTextPresetRecordById(presetId))
}

export function listTextPresetsByCategory(category?: TitlePresetCategory): TextPresetDefinition[] {
  const presets = category
    ? TEXT_PRESETS.filter((preset) => preset.category === category)
    : TEXT_PRESETS
  return presets
}

export function createTextClipFromPreset(
  presetId: string,
  options?: {
    id?: string
    startMs?: number
    durationMs?: number
    canvasWidth?: number
    canvasHeight?: number
  },
): TextClip {
  return createTextClipFromDefinition(getTextPresetById(presetId), options)
}

// Element size overrides are absolute clip units, so they scale with the clip's
// authored font size when a preset is placed on a differently sized canvas.
function scaleTitleFontSizes(
  sizes: TitleDesign["fontSizes"],
  factor: number,
): TitleDesign["fontSizes"] {
  const clamp = (value?: number) =>
    value === undefined ? undefined : Math.min(600, Math.max(4, value * factor))
  return {
    primary: clamp(sizes.primary),
    secondary: clamp(sizes.secondary),
    tag: clamp(sizes.tag),
    metric: clamp(sizes.metric),
  }
}

/** Uniform design scale for a project canvas (1 = 1920x1080). */
export function titleCanvasDesignScale(canvasWidth: number, canvasHeight: number): number {
  return Math.min(canvasWidth / 1920, canvasHeight / 1080)
}

function snapLegacyDesignScale(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio < 0.9) return 1
  return Math.min(4, Math.max(1, Math.round(ratio * 4) / 4))
}

/**
 * One-time migration for custom presets saved before `designScale` existed.
 * Their geometry is in the canvas pixels of the source clip, so a 4K preset
 * would otherwise be scaled by 2 again on every reuse. The source canvas is
 * unknowable from the preset alone; infer it from the template's 1080p design
 * box (unmodified preset geometry gives an exact 2x/1.5x signal) and persist
 * the result so the inference never compounds.
 */
export function migrateTextPresetDesignScale(
  preset: TextPresetValues,
  presetId: string,
): TextPresetValues {
  if (preset.designScale && preset.designScale > 0) return preset
  if (!presetId.startsWith("custom-") || !preset.titleDesign) return preset
  const template = preset.titleDesign.template
  const basis = TEXT_PRESET_CATALOG.presets.find(
    (candidate) => candidate.definition.titleDesign?.template === template,
  )
  if (!basis) return preset
  const ratio = Math.max(
    preset.width / Math.max(1, basis.definition.width),
    preset.height / Math.max(1, basis.definition.height),
  )
  const designScale = snapLegacyDesignScale(ratio)
  return designScale > 1 ? { ...preset, designScale } : preset
}

/**
 * Scale a designed title preset to a project canvas. Legacy presets retain
 * their authored pixel geometry; only versioned templates opt into scaling.
 */
export function scaleTextPresetForCanvas(
  preset: TextPresetDefinition,
  canvasWidth: number,
  canvasHeight: number,
): TextPresetDefinition {
  if (!preset.titleDesign) return preset
  const basisScale = titleCanvasDesignScale(canvasWidth, canvasHeight)
  const sourceScale = preset.designScale && preset.designScale > 0 ? preset.designScale : 1
  // Compare the available canvas against the preset's design-space box so a
  // custom preset saved from a high-resolution canvas is not fitted twice.
  const baseWidth = preset.width / sourceScale
  const baseHeight = preset.height / sourceScale
  const margin = 80 * basisScale
  const targetScale = Math.min(
    basisScale,
    (canvasWidth - margin * 2) / baseWidth,
    (canvasHeight - margin * 2) / baseHeight,
  )
  return scaleTextPresetValues(preset, targetScale / sourceScale)
}

function scaleTextPresetValues(preset: TextPresetDefinition, scale: number): TextPresetDefinition {
  if (!Number.isFinite(scale) || Math.abs(scale - 1) < 1e-6) return preset
  return {
    ...preset,
    width: preset.width * scale,
    height: preset.height * scale,
    fontSize: Math.min(200, Math.max(8, preset.fontSize * scale)),
    backdropBlur: Math.min(64, preset.backdropBlur * scale),
    backdropBorderRadius: Math.min(100, preset.backdropBorderRadius * scale),
    backdropPaddingX: Math.min(200, preset.backdropPaddingX * scale),
    backdropPaddingY: Math.min(200, preset.backdropPaddingY * scale),
    shadowBlur: Math.min(100, preset.shadowBlur * scale),
    titleDesign: preset.titleDesign
      ? {
          ...preset.titleDesign,
          fontSizes: scaleTitleFontSizes(preset.titleDesign.fontSizes, scale),
        }
      : undefined,
  }
}

export function createTextClipFromDefinition(
  preset: TextPresetDefinition,
  options?: {
    id?: string
    startMs?: number
    durationMs?: number
    canvasWidth?: number
    canvasHeight?: number
  },
): TextClip {
  const id = options?.id ?? `text-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const startMs = options?.startMs ?? 0
  const durationMs = options?.durationMs ?? 4000
  const canvasWidth = options?.canvasWidth ?? 1920
  const canvasHeight = options?.canvasHeight ?? 1080
  const scaledPreset = scaleTextPresetForCanvas(preset, canvasWidth, canvasHeight)
  const titleDesign = scaledPreset.titleDesign
    ? titleDesignSchema.parse(scaledPreset.titleDesign)
    : undefined
  // Legacy clips retain their original pixel geometry and category-based placement.
  const basisScale = titleDesign ? Math.min(canvasWidth / 1920, canvasHeight / 1080) : 1
  const margin = 80 * basisScale
  const width = scaledPreset.width
  const height = scaledPreset.height

  let x = Math.round((canvasWidth - width) / 2)
  let y = Math.round((canvasHeight - height) / 2)
  if (titleDesign) {
    const template = titleDesign.template
    if (template === "speaker-id" || template === "source-credit") {
      x = margin
      y = canvasHeight - height - margin
    } else if (template === "step-guide" || template === "note") {
      x = margin
      y = margin
    } else if (
      template === "shortcut" ||
      template === "command-line" ||
      template === "call-to-action"
    ) {
      y = canvasHeight - height - margin
    }
    x = Math.min(Math.max(margin, x), canvasWidth - width - margin)
    y = Math.min(Math.max(margin, y), canvasHeight - height - margin)
  } else if (preset.category === "lower-third") {
    x = 80
    y = canvasHeight - height - 90
  } else if (preset.category === "callout" || preset.category === "badge") {
    x = 80
    y = 80
  } else if (preset.category === "minimal") {
    y = canvasHeight - height - 80
  }

  const animation = {
    inType: scaledPreset.overlayAnimation?.inType ?? toOverlayAnimationIn(scaledPreset.animationIn),
    outType:
      scaledPreset.overlayAnimation?.outType ?? toOverlayAnimationOut(scaledPreset.animationOut),
    inDurationMs: scaledPreset.overlayAnimation?.inDurationMs ?? 350,
    outDurationMs: scaledPreset.overlayAnimation?.outDurationMs ?? 350,
    easing: scaledPreset.overlayAnimation?.easing ?? "expo-out",
  }

  return {
    id,
    assetId: `synthetic:text:${id}`,
    kind: "text",
    presetId: scaledPreset.id,
    category: scaledPreset.category,
    primaryText: scaledPreset.defaultPrimaryText,
    secondaryText: scaledPreset.defaultSecondaryText,
    tagText: scaledPreset.defaultTagText,
    startMs,
    durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
    x: Math.max(0, x),
    y: Math.max(0, y),
    width,
    height,
    rotation: scaledPreset.rotation ?? 0,
    anchorX: scaledPreset.anchorX ?? 0.5,
    anchorY: scaledPreset.anchorY ?? 0.5,
    zIndex: scaledPreset.zIndex ?? 0,
    opacity: scaledPreset.opacity ?? 1,
    alignment: scaledPreset.alignment,
    fontFamily: scaledPreset.fontFamily,
    fontSize: scaledPreset.fontSize,
    fontWeight: scaledPreset.fontWeight,
    textColor: scaledPreset.textColor,
    secondaryTextColor: scaledPreset.secondaryTextColor,
    accentColor: scaledPreset.accentColor,
    backdropStyle: scaledPreset.backdropStyle,
    backdropColor: scaledPreset.backdropColor,
    backdropOpacity: scaledPreset.backdropOpacity,
    backdropBlur: scaledPreset.backdropBlur,
    backdropBorderRadius: scaledPreset.backdropBorderRadius,
    backdropPaddingX: scaledPreset.backdropPaddingX,
    backdropPaddingY: scaledPreset.backdropPaddingY,
    shadowEnabled: scaledPreset.shadowEnabled,
    shadowColor: scaledPreset.shadowColor,
    shadowBlur: scaledPreset.shadowBlur,
    animationIn: scaledPreset.animationIn,
    animationOut: scaledPreset.animationOut,
    overlayAnimation: animation,
    autoScaleText: scaledPreset.autoScaleText ?? true,
    ...(titleDesign ? { titleDesign } : {}),
    enabled: true,
    locked: false,
  }
}

export interface ApplyTextPresetOptions {
  // Omitted options retain the original reset semantics; browser swaps should opt in.
  preserveLayout?: boolean
  preserveStyle?: boolean
  /** Scale the preset's 1080p-authored geometry to the project canvas. */
  canvasWidth?: number
  canvasHeight?: number
}

export function applyPresetToTextClip(
  clip: TextClip,
  presetId: string,
  options?: ApplyTextPresetOptions,
): TextClip {
  return applyTextPresetToClip(clip, getTextPresetById(presetId), options)
}

export function applyTextPresetToClip(
  clip: TextClip,
  preset: TextPresetDefinition,
  options?: ApplyTextPresetOptions,
): TextClip {
  // Replacing on a 4K/portrait canvas must use the same design scale as adding
  // the preset, otherwise the new look arrives at 1080p pixel sizes.
  const target =
    options?.canvasWidth && options?.canvasHeight
      ? scaleTextPresetForCanvas(preset, options.canvasWidth, options.canvasHeight)
      : preset
  const overlayAnimation = target.overlayAnimation
    ? { ...clip.overlayAnimation, ...target.overlayAnimation }
    : {
        ...clip.overlayAnimation,
        inType: toOverlayAnimationIn(target.animationIn),
        outType: toOverlayAnimationOut(target.animationOut),
      }

  return {
    ...clip,
    presetId: target.id,
    category: target.category,
    fontFamily: target.fontFamily,
    fontSize: target.fontSize,
    fontWeight: target.fontWeight,
    textColor: target.textColor,
    secondaryTextColor: target.secondaryTextColor,
    accentColor: target.accentColor,
    backdropStyle: target.backdropStyle,
    backdropColor: target.backdropColor,
    backdropOpacity: target.backdropOpacity,
    backdropBlur: target.backdropBlur,
    backdropBorderRadius: target.backdropBorderRadius,
    backdropPaddingX: target.backdropPaddingX,
    backdropPaddingY: target.backdropPaddingY,
    shadowEnabled: target.shadowEnabled,
    shadowColor: target.shadowColor,
    shadowBlur: target.shadowBlur,
    animationIn: target.animationIn,
    animationOut: target.animationOut,
    overlayAnimation,
    width: target.width,
    height: target.height,
    alignment: target.alignment,
    ...(target.rotation !== undefined ? { rotation: target.rotation } : {}),
    ...(target.anchorX !== undefined ? { anchorX: target.anchorX } : {}),
    ...(target.anchorY !== undefined ? { anchorY: target.anchorY } : {}),
    ...(target.zIndex !== undefined ? { zIndex: target.zIndex } : {}),
    ...(target.opacity !== undefined ? { opacity: target.opacity } : {}),
    ...(target.autoScaleText !== undefined ? { autoScaleText: target.autoScaleText } : {}),
    ...(options?.preserveLayout
      ? {
          width: clip.width,
          height: clip.height,
          rotation: clip.rotation,
          anchorX: clip.anchorX,
          anchorY: clip.anchorY,
          zIndex: clip.zIndex,
        }
      : {}),
    ...(options?.preserveStyle
      ? {
          alignment: clip.alignment,
          fontFamily: clip.fontFamily,
          fontSize: clip.fontSize,
          fontWeight: clip.fontWeight,
          textColor: clip.textColor,
          secondaryTextColor: clip.secondaryTextColor,
          accentColor: clip.accentColor,
          backdropStyle: clip.backdropStyle,
          backdropColor: clip.backdropColor,
          backdropOpacity: clip.backdropOpacity,
          backdropBlur: clip.backdropBlur,
          backdropBorderRadius: clip.backdropBorderRadius,
          backdropPaddingX: clip.backdropPaddingX,
          backdropPaddingY: clip.backdropPaddingY,
          shadowEnabled: clip.shadowEnabled,
          shadowColor: clip.shadowColor,
          shadowBlur: clip.shadowBlur,
          opacity: clip.opacity,
          animationIn: clip.animationIn,
          animationOut: clip.animationOut,
          overlayAnimation: { ...clip.overlayAnimation },
          autoScaleText: clip.autoScaleText,
        }
      : {}),
    titleDesign: target.titleDesign
      ? titleDesignSchema.parse({
          ...target.titleDesign,
          ...(options?.preserveStyle ? clip.titleDesign : {}),
          version: target.titleDesign.version,
          template: target.titleDesign.template,
        })
      : undefined,
  }
}

export function textPresetFromClip(
  clip: TextClip,
  metadata: {
    name: string
    description: string
    category?: string
    tags?: string[]
    designScale?: number
  },
): TextPresetRecord {
  return {
    id: `custom-${clip.id}`,
    name: metadata.name,
    description: metadata.description,
    category: metadata.category ?? clip.category,
    tags: metadata.tags ?? [clip.category, clip.fontFamily],
    definition: {
      defaultPrimaryText: clip.primaryText,
      defaultSecondaryText: clip.secondaryText,
      defaultTagText: clip.tagText,
      width: clip.width,
      height: clip.height,
      alignment: clip.alignment,
      fontFamily: clip.fontFamily,
      fontSize: clip.fontSize,
      fontWeight: clip.fontWeight,
      textColor: clip.textColor,
      secondaryTextColor: clip.secondaryTextColor,
      accentColor: clip.accentColor,
      backdropStyle: clip.backdropStyle,
      backdropColor: clip.backdropColor,
      backdropOpacity: clip.backdropOpacity,
      backdropBlur: clip.backdropBlur,
      backdropBorderRadius: clip.backdropBorderRadius,
      backdropPaddingX: clip.backdropPaddingX,
      backdropPaddingY: clip.backdropPaddingY,
      shadowEnabled: clip.shadowEnabled,
      shadowColor: clip.shadowColor,
      shadowBlur: clip.shadowBlur,
      animationIn: clip.animationIn,
      animationOut: clip.animationOut,
      overlayAnimation: { ...clip.overlayAnimation },
      autoScaleText: clip.autoScaleText,
      ...(clip.titleDesign ? { titleDesign: titleDesignSchema.parse(clip.titleDesign) } : {}),
      rotation: clip.rotation,
      anchorX: clip.anchorX,
      anchorY: clip.anchorY,
      zIndex: clip.zIndex,
      opacity: clip.opacity,
      ...(metadata.designScale && metadata.designScale > 0
        ? { designScale: metadata.designScale }
        : {}),
    },
  }
}
