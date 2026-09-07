import type { OverlayEasing, TextAnimation } from "@recordforge/contracts"
import { Button } from "@recordforge/ui"
import { Play } from "lucide-react"
import { useTimelineStore } from "../../../../stores/timeline-store"
import { InspectorSection } from "../fields"
import { TitleSelect, TitleSlider, type TitleSectionProps } from "./title-inspector-fields"

export function TitleMotionSection({ clip, onChange }: TitleSectionProps) {
  const design = clip.titleDesign
  function replay() {
    const timeline = useTimelineStore.getState()
    timeline.pause()
    timeline.seek(clip.startMs)
    timeline.play()
  }
  return (
    // Animation
    <InspectorSection title="Motion">
      {design ? (
        <>
          <TitleSelect
            label="Motion style"
            value={design.motion}
            options={[
              ["designed", "Designed · template choreography"],
              ["subtle", "Subtle · gentle movement"],
              ["none", "None · static title"],
            ]}
            onChange={(motion) => onChange({ titleDesign: { ...design, motion } })}
          />
          {design.motion !== "none" && (
            <TitleSlider
              label="Tempo"
              value={design.tempo}
              min={0.5}
              max={2}
              step={0.1}
              unit="×"
              onChange={(tempo) => onChange({ titleDesign: { ...design, tempo } })}
            />
          )}
          <div
            className="grid grid-cols-3 gap-1 rounded-md bg-surface-dim p-2 text-center text-xs"
            aria-label="Title motion phases"
          >
            <span>
              <strong className="block font-medium">In</strong>
              {design.motion === "none" ? "Immediate" : "Reveal"}
            </span>
            <span>
              <strong className="block font-medium">Hold</strong>Read
            </span>
            <span>
              <strong className="block font-medium">Out</strong>
              {design.motion === "none" ? "Cut" : "Resolve"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {design.motion === "none"
              ? "Your title stays still for the full clip."
              : "The template coordinates entrance, a readable hold, and exit. Higher tempo makes the transitions faster."}{" "}
            Clip length: {(clip.durationMs / 1000).toFixed(1)} s.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          This title uses legacy motion. Fine-tune its intro, outro, timing, and easing in Advanced.
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
