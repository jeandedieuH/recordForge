import { z } from "zod"
import {
  backgroundFitSchema,
  borderStyleSchema,
  borderGradientSchema,
  canvasAspectRatioSchema,
  cameraLayoutCornerSchema,
  cameraPlacementPresetSchema,
  cameraColorSchema,
  cameraCutoutSchema,
  motionBlurSettingsSchema,
} from "./timeline"
import { cursorSettingsSchema } from "./cursor"

// Whole-look presets (M5): a versioned bundle of canvas, camera and cursor
// styling that applies in one undoable `apply-look` command. Optional fields
// stay partial so a look only overrides what it declares — a "Minimal dark"
// look need not repeat the cursor defaults.
export const lookCanvasSchema = z.object({
  background: z.string().optional(),
  padding: z.number().min(0).optional(),
  borderRadius: z.number().min(0).optional(),
  shadow: z.boolean().optional(),
  shadowColor: z.string().optional(),
  shadowBlur: z.number().min(0).optional(),
  shadowOffsetX: z.number().optional(),
  shadowOffsetY: z.number().optional(),
  backgroundBlur: z.number().min(0).max(100).optional(),
  backgroundDim: z.number().min(0).max(1).optional(),
  backgroundFit: backgroundFitSchema.optional(),
  borderWidth: z.number().min(0).max(200).optional(),
  borderColor: z.string().optional(),
  borderOpacity: z.number().min(0).max(1).optional(),
  borderStyle: borderStyleSchema.optional(),
  borderGradient: borderGradientSchema.optional(),
  // Vertical video placement inside the padded frame (0 = top … 1 = bottom).
  videoPositionY: z.number().min(0).max(1).optional(),
  // M2 effects captured wholesale; enabling motion blur stays Pro-gated at
  // export like any other opt-in.
  motionBlur: motionBlurSettingsSchema.optional(),
})
export type LookCanvas = z.infer<typeof lookCanvasSchema>

// Camera styling is source-agnostic: it generalizes across every camera clip
// transform rather than copying one clip's pixel geometry.
export const lookCameraSchema = z.object({
  shape: z.enum(["rectangle", "rounded", "circle"]).optional(),
  borderWidth: z.number().min(0).optional(),
  borderColor: z.string().optional(),
  borderOpacity: z.number().min(0).max(1).optional(),
  borderStyle: borderStyleSchema.optional(),
  borderGradient: borderGradientSchema.optional(),
  shadowEnabled: z.boolean().optional(),
  shadowColor: z.string().optional(),
  shadowBlur: z.number().min(0).optional(),
  shadowOffsetX: z.number().optional(),
  shadowOffsetY: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  // Named placement preset on the clip transform (camera-only, vertical-pip…).
  preset: cameraPlacementPresetSchema.optional(),
  // Colour grade + LUT reuse the camera schema's bounds; a look can set a
  // bundled `look:*` LUT id or a project `.cube` asset.
  color: cameraColorSchema.partial().optional(),
  // Portrait cutout fields — `enabled` + background mode per #4b.
  cutout: cameraCutoutSchema.partial().optional(),
  // PiP layout intent for camera-layout segments (modern-features #5):
  // `layout` flips enabled pip segments' corner/size; a `custom` corner needs
  // explicit x/y pins.
  layout: z
    .object({
      corner: cameraLayoutCornerSchema,
      sizeFraction: z.number().min(0.05).max(0.6),
      x: z.number().min(0).max(1).optional(),
      y: z.number().min(0).max(1).optional(),
    })
    .optional(),
})
export type LookCamera = z.infer<typeof lookCameraSchema>

export const lookValuesSchema = z.object({
  version: z.literal(1),
  canvas: lookCanvasSchema.default({}),
  camera: lookCameraSchema.default({}),
  // cursorSettings.partial() keeps every field optional while reusing the
  // canonical field bounds.
  cursor: cursorSettingsSchema.partial().default({}),
  // Optional aspect change, applied only when the caller opts in — a look
  // should never silently re-crop the user's canvas.
  aspectRatio: canvasAspectRatioSchema.optional(),
})
export type LookValues = z.infer<typeof lookValuesSchema>

export const lookScopeSchema = z.enum(["all", "canvas", "camera", "cursor"])
export type LookScope = z.infer<typeof lookScopeSchema>
