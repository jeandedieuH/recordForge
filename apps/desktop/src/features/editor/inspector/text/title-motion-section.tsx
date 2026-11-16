import type {
  OverlayEasing,
  TextAnimation,
  TitleAnimationEasing,
  TitleAnimationPreset,
  TitleAnimationSpec,
  TitleAnimationUnit,
} from "@recordforge/contracts"
import { Button } from "@recordforge/ui"
import { Play } from "lucide-react"
import { useTimelineStore } from "../../../../stores/timeline-store"
import { InspectorSection } from "../fields"
import { TitleSelect, TitleSlider, type TitleSectionProps } from "./title-inspector-fields"

const inOptions: readonly (readonly [TitleAnimationPreset, string])[] = [
  ["none", "None"],
  ["fade", "Fade"],
  ["rise", "Rise"],
  ["drop", "Drop"],
  ["slide-left", "Slide from right"],
  ["slide-right", "Slide from left"],
  ["scale-pop", "Scale pop"],
  ["zoom", "Zoom"],
  ["blur-in", "Blur in"],
  ["typewriter", "Typewriter"],
  ["mask-wipe", "Mask wipe"],
  ["split-reveal", "Split reveal"],
  ["tracking-expand", "Tracking expand"],
  ["flip", "Flip"],
  ["bounce", "Bounce"],
  ["highlight-sweep", "Highlight sweep"],
  ["underline-draw", "Underline draw"],
  ["counter", "Counter"],
]

const outOptions: readonly (readonly [TitleAnimationPreset, string])[] = [
  ["none", "None"],
  ["fade", "Fade"],
  ["rise", "Rise away"],
  ["drop", "Drop away"],
  ["slide-left", "Slide to left"],
  ["slide-right", "Slide to right"],
  ["scale-pop", "Scale out"],
  ["zoom", "Zoom out"],
]

const unitOptions: readonly (readonly [TitleAnimationUnit, string])[] = [
  ["block", "Whole block"],
  ["line", "Line by line"],
  ["word", "Word by word"],
  ["char", "Character by character"],
]

const easingOptions: readonly (readonly [TitleAnimationEasing, string])[] = [
  ["expo-out", "Expo out · snappy"],
  ["expo-in", "Expo in"],
  ["expo-in-out", "Expo in/out"],
  ["cubic-out", "Cubic out"],
  ["cubic-in", "Cubic in"],
  ["cubic-in-out", "Cubic in/out"],
  ["back-out", "Back · overshoot"],
  ["elastic-out", "Elastic"],
  ["spring", "Spring"],
  ["linear", "Linear"],
]

function SpecEditor({
  title,
  spec,
  presets,
  onChange,
}: {
  title: string
  spec: TitleAnimationSpec
  presets: readonly (readonly [TitleAnimationPreset, string])[]
  onChange: (spec: TitleAnimationSpec) => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-surface-dim p-2">
      <span className="text-xs font-medium">{title}</span>
      <div className="grid grid-cols-2 gap-2">
        <TitleSelect<TitleAnimationPreset>
          label="Preset"
          value={spec.preset}
          options={presets}
          onChange={(preset) => onChange({ ...spec, preset })}
        />
        <TitleSelect<TitleAnimationUnit>
          label="Per"
          value={spec.unit}
          options={unitOptions}
          onChange={(unit) => onChange({ ...spec, unit })}
        />
      </div>
      <TitleSlider
        label="Duration"
        value={spec.durationMs}
        min={0}
        max={3000}
        step={50}
        unit="ms"
        onChange={(durationMs) => onChange({ ...spec, durationMs })}
      />
      <TitleSlider
        label="Stagger"
        value={spec.staggerMs}
        min={0}
        max={800}
        step={10}
        unit="ms"
        onChange={(staggerMs) => onChange({ ...spec, staggerMs })}
      />
      <TitleSelect<TitleAnimationEasing>
        label="Easing"
        value={spec.easing}
        options={easingOptions}
        onChange={(easing) => onChange({ ...spec, easing })}
      />
    </div>
  )
}

export function TitleMotionSection({ clip, onChange }: TitleSectionProps) {
  const design = clip.titleDesign
  function replay() {
    const timeline = useTimelineStore.getState()
    timeline.pause()
    timeline.seek(clip.startMs)
    timeline.play()
  }
  return (
    <InspectorSection title="Animation">
      {design ? (
        <>
          <SpecEditor
            title="In"
            spec={design.animation.in}
            presets={inOptions}
            onChange={(spec) =>
              onChange({ titleDesign: { ...design, animation: { ...design.animation, in: spec } } })
            }
          />
          <SpecEditor
            title="Out"
            spec={design.animation.out}
            presets={outOptions}
            onChange={(spec) =>
              onChange({
                titleDesign: { ...design, animation: { ...design.animation, out: spec } },
              })
            }
          />
          <TitleSelect
            label="Emphasis loop"
            value={design.animation.emphasis?.preset ?? "none"}
            options={[
              ["none", "None"],
              ["pulse", "Pulse"],
              ["shimmer", "Shimmer"],
              ["float", "Float"],
            ]}
            onChange={(preset) =>
              onChange({
                titleDesign: {
                  ...design,
                  animation: {
                    ...design.animation,
                    emphasis:
                      preset === "none"
                        ? undefined
                        : {
                            preset,
                            periodMs: design.animation.emphasis?.periodMs ?? 2400,
                            amplitude: design.animation.emphasis?.amplitude ?? 0.5,
                          },
                  },
                },
              })
            }
          />
          <TitleSlider
            label="Tempo"
            value={design.tempo}
            min={0.5}
            max={2}
            step={0.1}
            unit="×"
            onChange={(tempo) => onChange({ titleDesign: { ...design, tempo } })}
          />
          <p className="text-xs text-muted-foreground">
            Clip length: {(clip.durationMs / 1000).toFixed(1)} s. Higher tempo makes every
            transition faster.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          This title uses legacy motion. Fine-tune its intro, outro, timing, and easing in
          Advanced.
        </p>
      )}
      <Button variant="outline" size="sm" onClick={replay} className="gap-2">
        <Play className="size-3" aria-hidden />
        Replay in canvas
      </Button>
    </InspectorSection>
  )
}

const introOptions: readonly (readonly [TextAnimation, string])[] = [
  ["none", "None"],
  ["fade", "Fade"],
  ["slide-up", "Slide up"],
  ["slide-down", "Slide down"],
  ["slide-left", "Slide left"],
  ["slide-right", "Slide right"],
  ["zoom-punch", "Zoom punch"],
  ["expand-bar", "Expand bar"],
  ["pop-in", "Pop in"],
  ["bounce", "Bounce"],
  ["typewriter", "Typewriter"],
]

export function LegacyMotionControls({ clip, onChange }: TitleSectionProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <TitleSelect<TextAnimation>
          label="Legacy intro"
          value={clip.animationIn}
          options={introOptions}
          onChange={(animationIn) => onChange({ animationIn })}
        />
        <TitleSelect<TextAnimation>
          label="Legacy outro"
          value={clip.animationOut}
          options={introOptions}
          onChange={(animationOut) => onChange({ animationOut })}
        />
      </div>
      <TitleSlider
        label="In duration"
        value={clip.overlayAnimation.inDurationMs}
        min={0}
        max={1500}
        step={50}
        unit="ms"
        onChange={(inDurationMs) =>
          onChange({ overlayAnimation: { ...clip.overlayAnimation, inDurationMs } })
        }
      />
      <TitleSlider
        label="Out duration"
        value={clip.overlayAnimation.outDurationMs}
        min={0}
        max={1500}
        step={50}
        unit="ms"
        onChange={(outDurationMs) =>
          onChange({ overlayAnimation: { ...clip.overlayAnimation, outDurationMs } })
        }
      />
      <TitleSelect<OverlayEasing>
        label="Legacy easing"
        value={clip.overlayAnimation.easing}
        options={[
          ["expo-out", "Expo out · snappy"],
          ["ease-out", "Ease out · smooth"],
          ["ease-in-out", "Ease in/out · natural"],
          ["ease-in", "Ease in · accelerate"],
          ["linear", "Linear · constant"],
        ]}
        onChange={(easing) => onChange({ overlayAnimation: { ...clip.overlayAnimation, easing } })}
      />
    </>
  )
}
