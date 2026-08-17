import { z } from "zod"
import {
  overlayAnimationSchema,
  textAlignmentSchema,
  textAnimationSchema,
  textBackdropStyleSchema,
  textFontFamilySchema,
  type OverlayAnimation,
  type TextAnimation,
  type TextBackdropStyle,
  type TextClip,
  type TextFontFamily,
  type TextFontWeight,
  type TitlePresetCategory,
} from "@recordforge/domain"
import textPresetCatalogJson from "./presets/text-presets.json"
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
  rotation?: number
  anchorX?: number
  anchorY?: number
  zIndex?: number
  opacity?: number
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
  rotation: z.number().optional(),
  anchorX: z.number().min(0).max(1).optional(),
  anchorY: z.number().min(0).max(1).optional(),
  zIndex: z.number().int().optional(),
  opacity: z.number().min(0).max(1).optional(),
})

export const TEXT_PRESET_CATALOG: PresetCatalog<TextPresetValues> = parsePresetCatalog(
  textPresetCatalogJson,
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
  const found = TEXT_PRESET_CATALOG.presets.find((preset) => preset.id === presetId)
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

  let x = Math.round((canvasWidth - preset.width) / 2)
  let y = Math.round((canvasHeight - preset.height) / 2)
  if (preset.category === "lower-third") {
    x = 80
    y = canvasHeight - preset.height - 90
  } else if (preset.category === "callout" || preset.category === "badge") {
    x = 80
    y = 80
  } else if (preset.category === "minimal") {
    y = canvasHeight - preset.height - 80
  }

  const animation = {
    inType: preset.overlayAnimation?.inType ?? toOverlayAnimationIn(preset.animationIn),
    outType: preset.overlayAnimation?.outType ?? toOverlayAnimationOut(preset.animationOut),
    inDurationMs: preset.overlayAnimation?.inDurationMs ?? 350,
    outDurationMs: preset.overlayAnimation?.outDurationMs ?? 350,
    easing: preset.overlayAnimation?.easing ?? "expo-out",
  }

  return {
    id,
    assetId: `synthetic:text:${id}`,
    kind: "text",
    presetId: preset.id,
    category: preset.category,
    primaryText: preset.defaultPrimaryText,
    secondaryText: preset.defaultSecondaryText,
    tagText: preset.defaultTagText,
    startMs,
    durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: preset.width,
    height: preset.height,
    rotation: preset.rotation ?? 0,
    anchorX: preset.anchorX ?? 0.5,
    anchorY: preset.anchorY ?? 0.5,
    zIndex: preset.zIndex ?? 0,
    opacity: preset.opacity ?? 1,
    alignment: preset.alignment,
    fontFamily: preset.fontFamily,
    fontSize: preset.fontSize,
    fontWeight: preset.fontWeight,
    textColor: preset.textColor,
    secondaryTextColor: preset.secondaryTextColor,
    accentColor: preset.accentColor,
    backdropStyle: preset.backdropStyle,
    backdropColor: preset.backdropColor,
    backdropOpacity: preset.backdropOpacity,
    backdropBlur: preset.backdropBlur,
    backdropBorderRadius: preset.backdropBorderRadius,
    backdropPaddingX: preset.backdropPaddingX,
    backdropPaddingY: preset.backdropPaddingY,
    shadowEnabled: preset.shadowEnabled,
    shadowColor: preset.shadowColor,
    shadowBlur: preset.shadowBlur,
    animationIn: preset.animationIn,
    animationOut: preset.animationOut,
    overlayAnimation: animation,
    enabled: true,
    locked: false,
  }
}

export function applyPresetToTextClip(clip: TextClip, presetId: string): TextClip {
  return applyTextPresetToClip(clip, getTextPresetById(presetId))
}

export function applyTextPresetToClip(clip: TextClip, preset: TextPresetDefinition): TextClip {
  const overlayAnimation = preset.overlayAnimation
    ? { ...clip.overlayAnimation, ...preset.overlayAnimation }
    : {
        ...clip.overlayAnimation,
        inType: toOverlayAnimationIn(preset.animationIn),
        outType: toOverlayAnimationOut(preset.animationOut),
      }

  return {
    ...clip,
    presetId: preset.id,
    category: preset.category,
    fontFamily: preset.fontFamily,
    fontSize: preset.fontSize,
    fontWeight: preset.fontWeight,
    textColor: preset.textColor,
    secondaryTextColor: preset.secondaryTextColor,
    accentColor: preset.accentColor,
    backdropStyle: preset.backdropStyle,
    backdropColor: preset.backdropColor,
    backdropOpacity: preset.backdropOpacity,
    backdropBlur: preset.backdropBlur,
    backdropBorderRadius: preset.backdropBorderRadius,
    backdropPaddingX: preset.backdropPaddingX,
    backdropPaddingY: preset.backdropPaddingY,
    shadowEnabled: preset.shadowEnabled,
    shadowColor: preset.shadowColor,
    shadowBlur: preset.shadowBlur,
    animationIn: preset.animationIn,
    animationOut: preset.animationOut,
    overlayAnimation,
    width: preset.width,
    height: preset.height,
    alignment: preset.alignment,
    ...(preset.rotation !== undefined ? { rotation: preset.rotation } : {}),
    ...(preset.anchorX !== undefined ? { anchorX: preset.anchorX } : {}),
    ...(preset.anchorY !== undefined ? { anchorY: preset.anchorY } : {}),
    ...(preset.zIndex !== undefined ? { zIndex: preset.zIndex } : {}),
    ...(preset.opacity !== undefined ? { opacity: preset.opacity } : {}),
  }
}

export function textPresetFromClip(
  clip: TextClip,
  metadata: { name: string; description: string; category?: TitlePresetCategory; tags?: string[] },
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
      overlayAnimation: clip.overlayAnimation,
      rotation: clip.rotation,
      anchorX: clip.anchorX,
      anchorY: clip.anchorY,
      zIndex: clip.zIndex,
      opacity: clip.opacity,
    },
  }
}
