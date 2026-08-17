import { z } from "zod"
import {
  annotationHeadSchema,
  annotationStrokeStyleSchema,
  annotationTypeSchema,
  annotationAnimationSchema,
  overlayAnimationSchema,
  type AnnotationAnimation,
  type OverlayAnimationOutType,
  type AnnotationClip,
  type AnnotationHead,
  type AnnotationStrokeStyle,
  type AnnotationType,
  type OverlayAnimation,
} from "@recordforge/domain"
import annotationPresetCatalogJson from "./presets/annotation-presets.json"
import {
  parsePresetCatalog,
  type PresetCatalog,
  type PresetDefinition,
} from "./presets/preset-registry"

export interface AnnotationColorPalette {
  id: string
  name: string
  color: string
}

export const ANNOTATION_PALETTES: AnnotationColorPalette[] = [
  { id: "sky", name: "Sky Blue", color: "#38bdf8" },
  { id: "emerald", name: "Emerald", color: "#34d399" },
  { id: "violet", name: "Violet", color: "#a78bfa" },
  { id: "amber", name: "Sunset Amber", color: "#f59e0b" },
  { id: "rose", name: "Coral Rose", color: "#f43f5e" },
  { id: "white", name: "Pure White", color: "#ffffff" },
  { id: "yellow", name: "Vibrant Yellow", color: "#facc15" },
  { id: "cyan", name: "Neon Cyan", color: "#22d3ee" },
]

export interface AnnotationShapePreset {
  type: AnnotationType
  presetId?: string
  name: string
  description: string
  defaultWidth: number
  defaultHeight: number
  defaultStrokeWidth: number
  defaultStrokeColor: string
  defaultFillColor: string
  defaultFillOpacity: number
  defaultCornerRadius: number
  defaultArrowStartHead: AnnotationHead
  defaultArrowEndHead: AnnotationHead
  defaultStrokeStyle: AnnotationStrokeStyle
  text?: string
  textColor?: string
  fontSize?: number
  shadowEnabled?: boolean
  shadowColor?: string
  shadowBlur?: number
  animationIn?: AnnotationAnimation
  animationOut?: AnnotationAnimation
  overlayAnimation?: Partial<OverlayAnimation>
  rotation?: number
  anchorX?: number
  anchorY?: number
  zIndex?: number
  opacity?: number
}

export type AnnotationPresetValues = Omit<AnnotationShapePreset, "name" | "description">
export type AnnotationPresetRecord = PresetDefinition<AnnotationPresetValues>

export const annotationPresetValuesSchema = z.object({
  type: annotationTypeSchema,
  defaultWidth: z.number().positive(),
  defaultHeight: z.number().positive(),
  defaultStrokeWidth: z.number().min(0).max(64),
  defaultStrokeColor: z.string().min(1),
  defaultFillColor: z.string().min(1),
  defaultFillOpacity: z.number().min(0).max(1),
  defaultCornerRadius: z.number().min(0).max(100),
  defaultArrowStartHead: annotationHeadSchema,
  defaultArrowEndHead: annotationHeadSchema,
  defaultStrokeStyle: annotationStrokeStyleSchema,
  text: z.string().optional(),
  textColor: z.string().optional(),
  fontSize: z.number().min(8).max(120).optional(),
  shadowEnabled: z.boolean().optional(),
  shadowColor: z.string().optional(),
  shadowBlur: z.number().min(0).max(100).optional(),
  animationIn: annotationAnimationSchema.optional(),
  animationOut: annotationAnimationSchema.optional(),
  overlayAnimation: overlayAnimationSchema.partial().optional(),
  rotation: z.number().optional(),
  anchorX: z.number().min(0).max(1).optional(),
  anchorY: z.number().min(0).max(1).optional(),
  zIndex: z.number().int().optional(),
  opacity: z.number().min(0).max(1).optional(),
})

export const ANNOTATION_PRESET_CATALOG: PresetCatalog<AnnotationPresetValues> = parsePresetCatalog(
  annotationPresetCatalogJson,
  annotationPresetValuesSchema,
)

export const ANNOTATION_PRESETS: AnnotationPresetRecord[] = ANNOTATION_PRESET_CATALOG.presets

export function annotationPresetToShapePreset(
  preset: AnnotationPresetRecord,
): AnnotationShapePreset {
  return {
    ...preset.definition,
    presetId: preset.id,
    name: preset.name,
    description: preset.description,
  }
}

export const ANNOTATION_SHAPES: AnnotationShapePreset[] = ANNOTATION_PRESETS.map(
  annotationPresetToShapePreset,
)

export function getAnnotationPresetById(id: string): AnnotationPresetRecord {
  const found = ANNOTATION_PRESETS.find((preset) => preset.id === id)
  return found ?? ANNOTATION_PRESETS[0]
}

export function getAnnotationShapePreset(type: AnnotationType): AnnotationShapePreset {
  const found = ANNOTATION_SHAPES.find((preset) => preset.type === type)
  return found ?? ANNOTATION_SHAPES[0]
}

function toOverlayAnimationOut(animation: AnnotationAnimation): OverlayAnimationOutType {
  if (animation === "draw" || animation === "scale-up") return "scale-down"
  return animation
}

export function createAnnotationClip(
  type: AnnotationType,
  options?: {
    id?: string
    startMs?: number
    durationMs?: number
    x?: number
    y?: number
    width?: number
    height?: number
    endX?: number
    endY?: number
    strokeColor?: string
    strokeWidth?: number
    text?: string
    canvasWidth?: number
    canvasHeight?: number
  },
): AnnotationClip {
  return createAnnotationClipFromPreset(getAnnotationShapePreset(type), options)
}

export function createAnnotationClipFromPreset(
  preset: AnnotationShapePreset,
  options?: {
    id?: string
    startMs?: number
    durationMs?: number
    x?: number
    y?: number
    width?: number
    height?: number
    endX?: number
    endY?: number
    strokeColor?: string
    strokeWidth?: number
    text?: string
    canvasWidth?: number
    canvasHeight?: number
  },
): AnnotationClip {
  const id = options?.id ?? `annot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const startMs = options?.startMs ?? 0
  const durationMs = options?.durationMs ?? 3000
  const canvasWidth = options?.canvasWidth ?? 1920
  const canvasHeight = options?.canvasHeight ?? 1080
  const width = options?.width ?? preset.defaultWidth
  const height = options?.height ?? preset.defaultHeight
  const x = options?.x ?? Math.max(40, Math.round((canvasWidth - width) / 2))
  const y = options?.y ?? Math.max(40, Math.round((canvasHeight - height) / 2))
  const animationIn = preset.animationIn ?? "fade"
  const animationOut = preset.animationOut ?? "fade"

  return {
    id,
    assetId: `synthetic:annotation:${id}`,
    kind: "annotation",
    annotationType: preset.type,
    presetId: preset.presetId ?? "",
    startMs,
    durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
    x,
    y,
    width,
    height,
    rotation: preset.rotation ?? 0,
    anchorX: preset.anchorX ?? 0.5,
    anchorY: preset.anchorY ?? 0.5,
    zIndex: preset.zIndex ?? 0,
    opacity: preset.opacity ?? 1,
    endX:
      options?.endX ?? (preset.type === "arrow" || preset.type === "line" ? x + width : undefined),
    endY:
      options?.endY ?? (preset.type === "arrow" || preset.type === "line" ? y + height : undefined),
    strokeColor: options?.strokeColor ?? preset.defaultStrokeColor,
    strokeWidth: options?.strokeWidth ?? preset.defaultStrokeWidth,
    strokeStyle: preset.defaultStrokeStyle,
    fillColor: preset.defaultFillColor,
    fillOpacity: preset.defaultFillOpacity,
    cornerRadius: preset.defaultCornerRadius,
    arrowStartHead: preset.defaultArrowStartHead,
    arrowEndHead: preset.defaultArrowEndHead,
    shadowEnabled: preset.shadowEnabled ?? true,
    shadowColor: preset.shadowColor ?? "rgba(0, 0, 0, 0.5)",
    shadowBlur: preset.shadowBlur ?? 10,
    text:
      options?.text ?? preset.text ?? (preset.type === "callout" ? "Add note here..." : undefined),
    textColor: preset.textColor ?? "#ffffff",
    fontSize: preset.fontSize ?? 16,
    animationIn,
    animationOut,
    overlayAnimation: {
      inType: preset.overlayAnimation?.inType ?? animationIn,
      outType: preset.overlayAnimation?.outType ?? toOverlayAnimationOut(animationOut),
      inDurationMs: preset.overlayAnimation?.inDurationMs ?? 350,
      outDurationMs: preset.overlayAnimation?.outDurationMs ?? 350,
      easing: preset.overlayAnimation?.easing ?? "expo-out",
    },
    enabled: true,
    locked: false,
  }
}

export function applyPresetToAnnotationClip(
  clip: AnnotationClip,
  preset: AnnotationShapePreset | AnnotationPresetRecord,
): AnnotationClip {
  const shape = "definition" in preset ? annotationPresetToShapePreset(preset) : preset
  const nextWidth = shape.defaultWidth
  const nextHeight = shape.defaultHeight
  const isLine = shape.type === "arrow" || shape.type === "line"
  const animationIn = shape.animationIn ?? clip.animationIn
  const animationOut = shape.animationOut ?? clip.animationOut

  return {
    ...clip,
    annotationType: shape.type,
    presetId: shape.presetId ?? "",
    width: nextWidth,
    height: nextHeight,
    endX: isLine ? clip.x + nextWidth : undefined,
    endY: isLine ? clip.y + nextHeight : undefined,
    strokeWidth: shape.defaultStrokeWidth,
    strokeColor: shape.defaultStrokeColor,
    strokeStyle: shape.defaultStrokeStyle,
    fillColor: shape.defaultFillColor,
    fillOpacity: shape.defaultFillOpacity,
    cornerRadius: shape.defaultCornerRadius,
    arrowStartHead: shape.defaultArrowStartHead,
    arrowEndHead: shape.defaultArrowEndHead,
    ...(shape.text !== undefined ? { text: shape.text } : {}),
    ...(shape.textColor !== undefined ? { textColor: shape.textColor } : {}),
    ...(shape.fontSize !== undefined ? { fontSize: shape.fontSize } : {}),
    ...(shape.shadowEnabled !== undefined ? { shadowEnabled: shape.shadowEnabled } : {}),
    ...(shape.shadowColor !== undefined ? { shadowColor: shape.shadowColor } : {}),
    ...(shape.shadowBlur !== undefined ? { shadowBlur: shape.shadowBlur } : {}),
    ...(shape.rotation !== undefined ? { rotation: shape.rotation } : {}),
    ...(shape.anchorX !== undefined ? { anchorX: shape.anchorX } : {}),
    ...(shape.anchorY !== undefined ? { anchorY: shape.anchorY } : {}),
    ...(shape.zIndex !== undefined ? { zIndex: shape.zIndex } : {}),
    ...(shape.opacity !== undefined ? { opacity: shape.opacity } : {}),
    ...(animationIn !== undefined ? { animationIn } : {}),
    ...(animationOut !== undefined ? { animationOut } : {}),
    ...(shape.overlayAnimation !== undefined
      ? { overlayAnimation: { ...clip.overlayAnimation, ...shape.overlayAnimation } }
      : {}),
  }
}

export function annotationPresetFromClip(
  clip: AnnotationClip,
  metadata: { name: string; description: string; category?: string; tags?: string[] },
): AnnotationPresetRecord {
  return {
    id: `custom-${clip.id}`,
    name: metadata.name,
    description: metadata.description,
    category: metadata.category ?? annotationCategoryForType(clip.annotationType),
    tags: metadata.tags ?? [clip.annotationType],
    definition: {
      type: clip.annotationType,
      defaultWidth: clip.width,
      defaultHeight: clip.height,
      defaultStrokeWidth: clip.strokeWidth,
      defaultStrokeColor: clip.strokeColor,
      defaultFillColor: clip.fillColor,
      defaultFillOpacity: clip.fillOpacity,
      defaultCornerRadius: clip.cornerRadius,
      defaultArrowStartHead: clip.arrowStartHead,
      defaultArrowEndHead: clip.arrowEndHead,
      defaultStrokeStyle: clip.strokeStyle,
      text: clip.text,
      textColor: clip.textColor,
      fontSize: clip.fontSize,
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

function annotationCategoryForType(type: AnnotationType): string {
  if (type === "rectangle" || type === "rounded-rect") return "frame"
  if (type === "circle") return "highlight"
  if (type === "arrow" || type === "line") return "pointer"
  return type
}
