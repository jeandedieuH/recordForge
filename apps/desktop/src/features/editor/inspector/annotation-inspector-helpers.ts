import {
  annotationAnimationSchema,
  type AnnotationClip,
  type AnnotationType,
  type OverlayAnimation,
} from "@recordforge/contracts"
import {
  applyPresetToAnnotationClip,
  getAnnotationShapePreset,
  type AnnotationShapePreset,
} from "@recordforge/editor-core"

export interface AnnotationInspectorProps {
  clip: AnnotationClip
  onChange: (update: Partial<AnnotationClip>) => void
}

export function isAnnotationLine(type: AnnotationType) {
  return type === "arrow" || type === "line"
}

export function changeAnnotationType(
  clip: AnnotationClip,
  annotationType: AnnotationType,
): Partial<AnnotationClip> {
  if (annotationType === clip.annotationType) return {}
  const defaults = getAnnotationShapePreset(annotationType)
  const wasLine = isAnnotationLine(clip.annotationType)
  const isLine = isAnnotationLine(annotationType)
  const update: Partial<AnnotationClip> = { annotationType, presetId: "" }

  // Endpoints are absolute canvas coordinates, not offsets from the shape's origin.
  if (isLine) {
    update.endX = wasLine ? (clip.endX ?? clip.x + clip.width) : clip.x + clip.width
    update.endY = wasLine ? (clip.endY ?? clip.y + clip.height) : clip.y + clip.height
    update.arrowStartHead = "none"
    update.arrowEndHead = annotationType === "arrow" ? "arrow" : "none"
  } else {
    update.endX = undefined
    update.endY = undefined
    update.arrowStartHead = "none"
    update.arrowEndHead = "none"
    // A backwards connector becomes a box around its visible segment, not a displaced box.
    if (wasLine) {
      const endX = clip.endX ?? clip.x + clip.width
      const endY = clip.endY ?? clip.y + clip.height
      update.x = Math.min(clip.x, endX)
      update.y = Math.min(clip.y, endY)
      update.width = Math.max(10, Math.abs(endX - clip.x))
      update.height = Math.max(10, Math.abs(endY - clip.y))
    }
  }
  if (annotationType === "rounded-rect" || annotationType === "callout") {
    update.cornerRadius = defaults.defaultCornerRadius
  }
  if (annotationType === "callout" || annotationType === "badge") {
    update.text = clip.text || defaults.text || (annotationType === "callout" ? "Note here" : "IMPORTANT")
    update.fillColor = defaults.defaultFillColor
    update.fillOpacity = defaults.defaultFillOpacity
  }
  if (annotationType === "spotlight") {
    update.fillColor = defaults.defaultFillColor
    update.fillOpacity = defaults.defaultFillOpacity
    update.strokeWidth = defaults.defaultStrokeWidth
  }
  return update
}

export function changeAnnotationLayout(
  clip: AnnotationClip,
  update: Partial<Pick<AnnotationClip, "x" | "y" | "width" | "height" | "endX" | "endY">>,
): Partial<AnnotationClip> {
  if (!isAnnotationLine(clip.annotationType)) return update
  const x = update.x ?? clip.x
  const y = update.y ?? clip.y
  const dx = (clip.endX ?? clip.x + clip.width) - clip.x
  const dy = (clip.endY ?? clip.y + clip.height) - clip.y
  // Moving translates both ends; resizing preserves backwards-pointing connectors.
  const endX = update.endX ?? x + (update.width === undefined ? dx : (Math.sign(dx) || 1) * update.width)
  const endY = update.endY ?? y + (update.height === undefined ? dy : (Math.sign(dy) || 1) * update.height)
  return { ...update, endX, endY, width: Math.abs(endX - x), height: Math.abs(endY - y) }
}

export function changeAnnotationAnimation(
  clip: AnnotationClip,
  update: Partial<OverlayAnimation>,
): Partial<AnnotationClip> {
  const overlayAnimation = { ...clip.overlayAnimation, ...update }
  // Preview/export consume the canonical object. Keep legacy fields useful for preset round-trips.
  const intro = annotationAnimationSchema.safeParse(overlayAnimation.inType)
  const outro = annotationAnimationSchema.safeParse(overlayAnimation.outType)
  return {
    overlayAnimation,
    animationIn: intro.success ? intro.data : "fade",
    animationOut: outro.success ? outro.data : "fade",
  }
}

export function applyAnnotationInspectorPreset(clip: AnnotationClip, shape: AnnotationShapePreset): AnnotationClip {
  const updated = applyPresetToAnnotationClip(clip, shape)
  // Older custom presets may only supply legacy animation fields. Do not retain stale engine motion.
  const legacyOut = shape.animationOut === "draw" || shape.animationOut === "scale-up"
    ? "scale-down" : shape.animationOut
  const motion = changeAnnotationAnimation(updated, {
    ...clip.overlayAnimation,
    ...(shape.animationIn !== undefined ? { inType: shape.animationIn } : {}),
    ...(legacyOut !== undefined ? { outType: legacyOut } : {}),
    ...shape.overlayAnimation,
  })
  return { ...updated, ...motion }
}
