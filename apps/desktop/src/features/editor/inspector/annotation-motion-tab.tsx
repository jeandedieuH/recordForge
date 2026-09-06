import type {
  OverlayAnimation,
  OverlayAnimationOutType,
  OverlayAnimationType,
  OverlayEasing,
} from "@recordforge/contracts"
import { InspectorSection } from "./fields"
import { AnnotationNumberField, AnnotationSelect } from "./annotation-inspector-fields"
import {
  changeAnnotationAnimation,
  type AnnotationInspectorProps,
} from "./annotation-inspector-helpers"

export function AnnotationMotionTab({ clip, onChange }: AnnotationInspectorProps) {
  const motion = clip.overlayAnimation
  // Typewriter is a text-engine effect; retain imported values without offering it for new shapes.
  const introOptions =
    motion.inType === "typewriter"
      ? [...INTRO_OPTIONS, { value: "typewriter" as const, label: "Typewriter (preset)" }]
      : INTRO_OPTIONS
  function updateMotion(update: Partial<OverlayAnimation>) {
    onChange(changeAnnotationAnimation(clip, update))
  }
  return (
    <div className="flex flex-col gap-4">
      {/* Animation */}
      <InspectorSection title="Entrance">
        <AnnotationSelect<OverlayAnimationType>
          label="Intro"
          value={motion.inType}
          options={introOptions}
          onChange={(inType) => updateMotion({ inType })}
        />
        <AnnotationNumberField
          label="Intro duration"
          unit="ms"
          value={motion.inDurationMs}
          min={0}
          step={50}
          disabled={motion.inType === "none"}
          onChange={(inDurationMs) => updateMotion({ inDurationMs: Math.round(inDurationMs) })}
        />
      </InspectorSection>
      <InspectorSection title="Exit">
        <AnnotationSelect<OverlayAnimationOutType>
          label="Outro"
          value={motion.outType}
          options={OUTRO_OPTIONS}
          onChange={(outType) => updateMotion({ outType })}
        />
        <AnnotationNumberField
          label="Outro duration"
          unit="ms"
          value={motion.outDurationMs}
          min={0}
          step={50}
          disabled={motion.outType === "none"}
          onChange={(outDurationMs) => updateMotion({ outDurationMs: Math.round(outDurationMs) })}
        />
      </InspectorSection>
      <AnnotationSelect<OverlayEasing>
        label="Easing"
        value={motion.easing}
        options={EASING_OPTIONS}
        onChange={(easing) => updateMotion({ easing })}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        Motion plays at the clip’s start and end. Scrub the timeline to preview.
      </p>
    </div>
  )
}

const OUTRO_OPTIONS: { value: OverlayAnimationOutType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "scale-down", label: "Shrink" },
  { value: "scale-up", label: "Scale up" },
  { value: "slide-down", label: "Slide down" },
  { value: "slide-up", label: "Slide up" },
  { value: "slide-left", label: "Slide left" },
  { value: "slide-right", label: "Slide right" },
]
const INTRO_OPTIONS: { value: OverlayAnimationType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "scale-up", label: "Pop scale" },
  { value: "draw", label: "Vector draw" },
  { value: "slide-up", label: "Slide up" },
  { value: "scale-down", label: "Scale down" },
  { value: "slide-down", label: "Slide down" },
  { value: "slide-left", label: "Slide left" },
  { value: "slide-right", label: "Slide right" },
  { value: "pop-in", label: "Pop in" },
  { value: "bounce", label: "Bounce" },
]
const EASING_OPTIONS: { value: OverlayEasing; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "ease-in", label: "Ease in" },
  { value: "ease-out", label: "Ease out" },
  { value: "ease-in-out", label: "Ease in & out" },
  { value: "expo-out", label: "Exponential out" },
]
