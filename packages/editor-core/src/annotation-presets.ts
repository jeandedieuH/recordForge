import { z } from "zod"
import {
  annotationArrowStyleSchema,
  annotationHeadSchema,
  annotationStrokeStyleSchema,
  annotationTypeSchema,
  annotationAnimationSchema,
  overlayAnimationSchema,
  type AnnotationAnimation,
  type AnnotationArrowStyle,
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
  defaultArrowStyle?: AnnotationArrowStyle
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
  /**
   * Canvas scale the preset's absolute geometry was authored at (1 = 1080p).
   * Custom presets saved from 1440p/4K clips use this to avoid double scaling.
   */
  designScale?: number
}

export type AnnotationPresetValues = Omit<AnnotationShapePreset, "name" | "description">
export type AnnotationPresetRecord = PresetDefinition<AnnotationPresetValues>

/** Annotation presets are authored against the same 1920x1080 design canvas as titles. */
export const ANNOTATION_DESIGN_CANVAS_WIDTH = 1920
export const ANNOTATION_DESIGN_CANVAS_HEIGHT = 1080

/**
 * Uniform design scale for a project canvas. Using the short-edge ratio keeps
 * a preset's relative size identical on 4K, 1440p, 1080p and portrait canvases.
 */
export function annotationCanvasScale(
  canvasWidth: number = ANNOTATION_DESIGN_CANVAS_WIDTH,
  canvasHeight: number = ANNOTATION_DESIGN_CANVAS_HEIGHT,
): number {
  const width = Math.max(1, canvasWidth)
  const height = Math.max(1, canvasHeight)
  return Math.min(width / ANNOTATION_DESIGN_CANVAS_WIDTH, height / ANNOTATION_DESIGN_CANVAS_HEIGHT)
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function snapLegacyDesignScale(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio < 0.9) return 1
  return Math.min(4, Math.max(1, Math.round(ratio * 4) / 4))
}

/**
 * One-time migration for custom presets saved before `designScale` existed.
 * The original canvas is not recorded, so infer it from the built-in preset's
 * 1080p authored box (an unmodified preset saved at 4K yields ~2x). The
 * inferred value is persisted by the registry so reusing the preset no longer
 * compounds the scale.
 */
export function migrateAnnotationPresetDesignScale(
  preset: AnnotationPresetValues,
  presetId: string,
): AnnotationPresetValues {
  if (preset.designScale && preset.designScale > 0) return preset
  const isLegacyCustom =
    presetId.startsWith("custom-") || (preset.presetId?.startsWith("custom-") ?? false)
  if (!isLegacyCustom) return preset
  const basis = getAnnotationShapePreset(preset.type)
  const ratio = Math.max(
    preset.defaultWidth / Math.max(1, basis.defaultWidth),
    preset.defaultHeight / Math.max(1, basis.defaultHeight),
    (preset.fontSize ?? 16) / Math.max(1, basis.fontSize ?? 16),
  )
  const designScale = snapLegacyDesignScale(ratio)
  return designScale > 1 ? { ...preset, designScale } : preset
}

/**
 * Scale a preset's authored geometry, stroke width, and typography to the
 * project canvas. Explicit user values (a drawn width, an edited stroke) are
 * project pixels and must not pass through this helper.
 */
export function scaleAnnotationPresetForCanvas(
  preset: AnnotationShapePreset,
  canvasWidth?: number,
  canvasHeight?: number,
): AnnotationShapePreset {
  const targetScale = annotationCanvasScale(canvasWidth, canvasHeight)
  const sourceScale = preset.designScale && preset.designScale > 0 ? preset.designScale : 1
  const scale = targetScale / sourceScale
  if (Math.abs(scale - 1) < 1e-6) return preset
  return {
    ...preset,
    defaultWidth: Math.max(1, preset.defaultWidth * scale),
    defaultHeight: Math.max(1, preset.defaultHeight * scale),
    defaultStrokeWidth: clampNumber(preset.defaultStrokeWidth * scale, 0, 64),
    defaultCornerRadius: clampNumber(preset.defaultCornerRadius * scale, 0, 100),
    fontSize: clampNumber((preset.fontSize ?? 16) * scale, 8, 120),
    shadowBlur: clampNumber((preset.shadowBlur ?? 10) * scale, 0, 100),
  }
}

export const annotationPresetValuesSchema = z.object({
  presetId: z.string().optional(),
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
  defaultArrowStyle: annotationArrowStyleSchema.optional(),
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
  designScale: z.number().positive().max(16).optional(),
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
    presetId: preset.definition.presetId ?? preset.id,
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

/** True for annotation types whose shape is defined by endX/endY endpoints or a pointer target. */
export function annotationHasEndpoints(type: AnnotationType): boolean {
  return type === "arrow" || type === "line" || type === "callout"
}

/**
 * Default leader target for a callout box: below the box, biased toward the
 * left so the pointer reads like the classic speech tail direction.
 */
export function calloutDefaultTarget(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return { x: x + width * 0.25, y: y + height + Math.max(48, height * 0.35) }
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
    arrowStyle?: AnnotationArrowStyle
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
    arrowStyle?: AnnotationArrowStyle
    strokeColor?: string
    strokeWidth?: number
    text?: string
    canvasWidth?: number
    canvasHeight?: number
    /**
     * Scale preset-authored values to the canvas. Thumbnails deliberately opt
     * out so a small style preview stays legible instead of shrinking to the
     * exact 1080p-relative size.
     */
    scaleToCanvas?: boolean
  },
): AnnotationClip {
  const id = options?.id ?? `annot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const startMs = options?.startMs ?? 0
  const durationMs = options?.durationMs ?? 3000
  const canvasWidth = options?.canvasWidth ?? ANNOTATION_DESIGN_CANVAS_WIDTH
  const canvasHeight = options?.canvasHeight ?? ANNOTATION_DESIGN_CANVAS_HEIGHT
  let scaled = preset
  if (options?.scaleToCanvas === false) {
    // Style thumbnails stay at their design size, but custom presets saved
    // from a high-resolution canvas are still normalized to 1080p units.
    if (preset.designScale) {
      scaled = scaleAnnotationPresetForCanvas(
        preset,
        ANNOTATION_DESIGN_CANVAS_WIDTH,
        ANNOTATION_DESIGN_CANVAS_HEIGHT,
      )
    }
  } else {
    scaled = scaleAnnotationPresetForCanvas(preset, canvasWidth, canvasHeight)
  }
  const width = options?.width ?? scaled.defaultWidth
  const height = options?.height ?? scaled.defaultHeight
  const x = options?.x ?? Math.max(40, Math.round((canvasWidth - width) / 2))
  const y = options?.y ?? Math.max(40, Math.round((canvasHeight - height) / 2))
  const animationIn = scaled.animationIn ?? "fade"
  const animationOut = scaled.animationOut ?? "fade"
  const isLine = scaled.type === "arrow" || scaled.type === "line"
  const calloutTarget =
    scaled.type === "callout" ? calloutDefaultTarget(x, y, width, height) : undefined

  return {
    id,
    assetId: `synthetic:annotation:${id}`,
    kind: "annotation",
    annotationType: scaled.type,
    presetId: scaled.presetId ?? "",
    startMs,
    durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
    x,
    y,
    width,
    height,
    rotation: scaled.rotation ?? 0,
    anchorX: scaled.anchorX ?? 0.5,
    anchorY: scaled.anchorY ?? 0.5,
    zIndex: scaled.zIndex ?? 0,
    opacity: scaled.opacity ?? 1,
    endX: options?.endX ?? (isLine ? x + width : calloutTarget?.x),
    endY: options?.endY ?? (isLine ? y + height : calloutTarget?.y),
    strokeColor: options?.strokeColor ?? scaled.defaultStrokeColor,
    strokeWidth: options?.strokeWidth ?? scaled.defaultStrokeWidth,
    strokeStyle: scaled.defaultStrokeStyle,
    fillColor: scaled.defaultFillColor,
    fillOpacity: scaled.defaultFillOpacity,
    cornerRadius: scaled.defaultCornerRadius,
    arrowStartHead: scaled.defaultArrowStartHead,
    arrowEndHead: scaled.defaultArrowEndHead,
    arrowStyle: options?.arrowStyle ?? scaled.defaultArrowStyle ?? "straight",
    shadowEnabled: scaled.shadowEnabled ?? true,
    shadowColor: scaled.shadowColor ?? "rgba(0, 0, 0, 0.5)",
    shadowBlur: scaled.shadowBlur ?? 10,
    text:
      options?.text ?? scaled.text ?? (scaled.type === "callout" ? "Add note here..." : undefined),
    textColor: scaled.textColor ?? "#ffffff",
    fontSize: scaled.fontSize ?? 16,
    animationIn,
    animationOut,
    overlayAnimation: {
      inType: scaled.overlayAnimation?.inType ?? animationIn,
      outType: scaled.overlayAnimation?.outType ?? toOverlayAnimationOut(animationOut),
      inDurationMs: scaled.overlayAnimation?.inDurationMs ?? 350,
      outDurationMs: scaled.overlayAnimation?.outDurationMs ?? 350,
      easing: scaled.overlayAnimation?.easing ?? "expo-out",
    },
    enabled: true,
    locked: false,
  }
}

export function applyPresetToAnnotationClip(
  clip: AnnotationClip,
  preset: AnnotationShapePreset | AnnotationPresetRecord,
  options?: { canvasWidth?: number; canvasHeight?: number },
): AnnotationClip {
  const source = "definition" in preset ? annotationPresetToShapePreset(preset) : preset
  const shape = scaleAnnotationPresetForCanvas(source, options?.canvasWidth, options?.canvasHeight)
  const nextWidth = Math.min(shape.defaultWidth, options?.canvasWidth ?? shape.defaultWidth)
  const nextHeight = Math.min(shape.defaultHeight, options?.canvasHeight ?? shape.defaultHeight)
  const isLine = shape.type === "arrow" || shape.type === "line"
  const isCallout = shape.type === "callout"
  const calloutTarget = isCallout
    ? calloutDefaultTarget(clip.x, clip.y, nextWidth, nextHeight)
    : undefined
  const animationIn = shape.animationIn ?? clip.animationIn
  const animationOut = shape.animationOut ?? clip.animationOut

  return {
    ...clip,
    annotationType: shape.type,
    presetId: shape.presetId ?? "",
    width: nextWidth,
    height: nextHeight,
    endX: isLine ? clip.x + nextWidth : isCallout ? (clip.endX ?? calloutTarget?.x) : undefined,
    endY: isLine ? clip.y + nextHeight : isCallout ? (clip.endY ?? calloutTarget?.y) : undefined,
    strokeWidth: shape.defaultStrokeWidth,
    strokeColor: shape.defaultStrokeColor,
    strokeStyle: shape.defaultStrokeStyle,
    fillColor: shape.defaultFillColor,
    fillOpacity: shape.defaultFillOpacity,
    cornerRadius: shape.defaultCornerRadius,
    arrowStartHead: shape.defaultArrowStartHead,
    arrowEndHead: shape.defaultArrowEndHead,
    arrowStyle: shape.defaultArrowStyle ?? "straight",
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
  metadata: {
    name: string
    description: string
    category?: string
    tags?: string[]
    designScale?: number
  },
): AnnotationPresetRecord {
  const id = `custom-${clip.id}`
  return {
    id,
    name: metadata.name,
    description: metadata.description,
    category: metadata.category ?? annotationCategoryForType(clip.annotationType),
    tags: metadata.tags ?? [clip.annotationType],
    definition: {
      presetId: id,
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
      defaultArrowStyle: clip.arrowStyle,
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
      ...(metadata.designScale && metadata.designScale > 0
        ? { designScale: metadata.designScale }
        : {}),
    },
  }
}

export function annotationCategoryForType(type: AnnotationType): string {
  if (type === "rectangle" || type === "rounded-rect") return "frame"
  if (type === "circle") return "highlight"
  if (type === "arrow" || type === "line") return "pointer"
  return type
}
