import { z } from "zod"
import {
  annotationHeadSchema,
  annotationStrokeStyleSchema,
  annotationTypeSchema,
  imageFitSchema,
  overlayAnimationSchema,
  textAlignmentSchema,
  textBackdropStyleSchema,
  textFontFamilySchema,
  textFontWeightSchema,
  titlePresetCategorySchema,
} from "./timeline"

// The overlay engine consumes this transport shape instead of persisted timeline clips.
// Keeping the engine DTO separate lets Phase 1 evolve project migration without changing
// the native/WASM display-list seam.
export const overlayCanvasSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

export type OverlayCanvas = z.infer<typeof overlayCanvasSchema>

export const overlayTransformSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().min(0).default(100),
  height: z.number().min(0).default(100),
  rotation: z.number().default(0),
  anchorX: z.number().min(0).max(1).default(0.5),
  anchorY: z.number().min(0).max(1).default(0.5),
  zIndex: z.number().int().default(0),
  opacity: z.number().min(0).max(1).default(1),
})

export type OverlayTransform = z.infer<typeof overlayTransformSchema>

const overlayRenderItemBaseSchema = z.object({
  id: z.string().min(1),
  startMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
  endMs: z.number().transform(Math.round).pipe(z.number().int().positive()),
  transform: overlayTransformSchema,
  animation: overlayAnimationSchema.default({}),
  enabled: z.boolean().default(true),
})

export const overlayAnnotationItemSchema = overlayRenderItemBaseSchema.extend({
  kind: z.literal("annotation"),
  annotationType: annotationTypeSchema,
  endX: z.number().optional(),
  endY: z.number().optional(),
  strokeColor: z.string(),
  strokeWidth: z.number().min(0),
  strokeStyle: annotationStrokeStyleSchema,
  fillColor: z.string(),
  fillOpacity: z.number().min(0).max(1),
  cornerRadius: z.number().min(0),
  arrowEndHead: annotationHeadSchema,
  arrowStartHead: annotationHeadSchema,
  shadowEnabled: z.boolean(),
  shadowColor: z.string(),
  shadowBlur: z.number().min(0),
  text: z.string().optional(),
  textColor: z.string(),
  fontSize: z.number().min(8),
})

export type OverlayAnnotationItem = z.infer<typeof overlayAnnotationItemSchema>

export const overlayTextItemSchema = overlayRenderItemBaseSchema.extend({
  kind: z.literal("text"),
  presetId: z.string(),
  category: titlePresetCategorySchema,
  primaryText: z.string().min(1),
  secondaryText: z.string().optional(),
  tagText: z.string().optional(),
  alignment: textAlignmentSchema,
  fontFamily: textFontFamilySchema,
  fontSize: z.number().min(8),
  fontWeight: textFontWeightSchema,
  textColor: z.string(),
  secondaryTextColor: z.string(),
  accentColor: z.string(),
  backdropStyle: textBackdropStyleSchema,
  backdropColor: z.string(),
  backdropOpacity: z.number().min(0).max(1),
  backdropBlur: z.number().min(0),
  backdropBorderRadius: z.number().min(0),
  backdropPaddingX: z.number().min(0),
  backdropPaddingY: z.number().min(0),
  shadowEnabled: z.boolean(),
  shadowColor: z.string(),
  shadowBlur: z.number().min(0),
  autoScaleText: z.boolean().default(true),
})

export type OverlayTextItem = z.infer<typeof overlayTextItemSchema>

export const overlayImageItemSchema = overlayRenderItemBaseSchema.extend({
  kind: z.literal("image"),
  assetId: z.string().min(1),
  fit: imageFitSchema,
  borderRadius: z.number().min(0),
  borderWidth: z.number().min(0),
  borderColor: z.string(),
  shadowEnabled: z.boolean(),
  shadowColor: z.string(),
  shadowBlur: z.number().min(0),
})

export type OverlayImageItem = z.infer<typeof overlayImageItemSchema>

export const overlayRenderItemSchema = z.discriminatedUnion("kind", [
  overlayAnnotationItemSchema,
  overlayTextItemSchema,
  overlayImageItemSchema,
])

export type OverlayRenderItem = z.infer<typeof overlayRenderItemSchema>

export const overlayAssetSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("image"),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  contentHash: z.string().optional(),
})

export type OverlayAsset = z.infer<typeof overlayAssetSchema>

export const overlayFontFamilySchema = z.enum(["sans", "serif", "mono", "heading"])
export type OverlayFontFamily = z.infer<typeof overlayFontFamilySchema>

export const overlayFontSchema = z.object({
  family: overlayFontFamilySchema,
  file: z.string().min(1),
  license: z.literal("OFL-1.1"),
})

export type OverlayFont = z.infer<typeof overlayFontSchema>

export const overlayRenderPlanSchema = z.object({
  version: z.literal(1).default(1),
  canvas: overlayCanvasSchema,
  items: z.array(overlayRenderItemSchema).default([]),
  assets: z.array(overlayAssetSchema).default([]),
  fonts: z.array(overlayFontSchema).default([]),
})

export type OverlayRenderPlan = z.infer<typeof overlayRenderPlanSchema>

const overlayDisplayItemBaseSchema = z.object({
  id: z.string().min(1),
  zIndex: z.number().int(),
  transform: overlayTransformSchema,
  animationProgress: z.number().min(0).max(1).default(1),
})

export const overlayDisplayAnnotationSchema = overlayDisplayItemBaseSchema.extend({
  kind: z.literal("annotation"),
  drawProgress: z.number().min(0).max(1).default(1),
  annotationType: annotationTypeSchema,
  endX: z.number().optional(),
  endY: z.number().optional(),
  strokeColor: z.string(),
  strokeWidth: z.number().min(0),
  strokeStyle: annotationStrokeStyleSchema,
  fillColor: z.string(),
  fillOpacity: z.number().min(0).max(1),
  cornerRadius: z.number().min(0),
  arrowEndHead: annotationHeadSchema,
  arrowStartHead: annotationHeadSchema,
  shadowEnabled: z.boolean(),
  shadowColor: z.string(),
  shadowBlur: z.number().min(0),
  text: z.string().optional(),
  textColor: z.string(),
  fontSize: z.number().min(8),
})

export const overlayDisplayTextSchema = overlayDisplayItemBaseSchema.extend({
  kind: z.literal("text"),
  textProgress: z.number().min(0).max(1).default(1),
  presetId: z.string(),
  category: titlePresetCategorySchema,
  primaryText: z.string(),
  secondaryText: z.string().optional(),
  tagText: z.string().optional(),
  alignment: textAlignmentSchema,
  fontFamily: textFontFamilySchema,
  fontSize: z.number().min(8),
  fontWeight: textFontWeightSchema,
  textColor: z.string(),
  secondaryTextColor: z.string(),
  accentColor: z.string(),
  backdropStyle: textBackdropStyleSchema,
  backdropColor: z.string(),
  backdropOpacity: z.number().min(0).max(1),
  backdropBlur: z.number().min(0),
  backdropBorderRadius: z.number().min(0),
  backdropPaddingX: z.number().min(0),
  backdropPaddingY: z.number().min(0),
  shadowEnabled: z.boolean(),
  shadowColor: z.string(),
  shadowBlur: z.number().min(0),
  autoScaleText: z.boolean().default(true),
})

export const overlayDisplayImageSchema = overlayDisplayItemBaseSchema.extend({
  kind: z.literal("image"),
  assetId: z.string().min(1),
  fit: imageFitSchema,
  borderRadius: z.number().min(0),
  borderWidth: z.number().min(0),
  borderColor: z.string(),
  shadowEnabled: z.boolean(),
  shadowColor: z.string(),
  shadowBlur: z.number().min(0),
})

export const overlayDisplayItemSchema = z.discriminatedUnion("kind", [
  overlayDisplayAnnotationSchema,
  overlayDisplayTextSchema,
  overlayDisplayImageSchema,
])

export type OverlayDisplayAnnotation = z.infer<typeof overlayDisplayAnnotationSchema>
export type OverlayDisplayText = z.infer<typeof overlayDisplayTextSchema>
export type OverlayDisplayImage = z.infer<typeof overlayDisplayImageSchema>
export type OverlayDisplayItem = z.infer<typeof overlayDisplayItemSchema>

export const overlayDisplayListSchema = z.object({
  timeMs: z.number().int().min(0),
  items: z.array(overlayDisplayItemSchema),
})

export type OverlayDisplayList = z.infer<typeof overlayDisplayListSchema>

