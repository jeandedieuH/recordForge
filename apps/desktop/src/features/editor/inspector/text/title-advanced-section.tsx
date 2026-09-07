import { InspectorSection, NumberField } from "../fields"
import { LegacySurfaceControls } from "./title-design-section"
import { LegacyMotionControls } from "./title-motion-section"
import { TitleSlider, type TitleSectionProps } from "./title-inspector-fields"
import { fitTitleLayout, type TitleCanvas } from "./title-layout"

export function TitleAdvancedSection({
  clip,
  onChange,
  canvas,
}: TitleSectionProps & { canvas: TitleCanvas }) {
  const design = clip.titleDesign
  return (
    <InspectorSection title="Advanced" defaultOpen={false}>
      {design ? (
        <>
          <TitleSlider
            label="Letter spacing"
            value={design.letterSpacing}
            min={-0.05}
            max={0.2}
            step={0.01}
            unit="em"
            onChange={(letterSpacing) => onChange({ titleDesign: { ...design, letterSpacing } })}
          />
          <TitleSlider
            label="Line height"
            value={design.lineHeight}
            min={0.9}
            max={1.8}
            step={0.05}
            unit="×"
            onChange={(lineHeight) => onChange({ titleDesign: { ...design, lineHeight } })}
          />
        </>
      ) : (
        <>
          <LegacyMotionControls clip={clip} onChange={onChange} />
          <LegacySurfaceControls clip={clip} onChange={onChange} />
        </>
      )}
      {/* Transform & Geometry */}
      <fieldset disabled={clip.locked} className="grid grid-cols-2 gap-2 disabled:opacity-50">
        <NumberField
          label="X position"
          value={Math.round(clip.x)}
          max={canvas.width}
          onChange={(x) => onChange(fitTitleLayout(clip, canvas, { x }))}
        />
        <NumberField
          label="Y position"
          value={Math.round(clip.y)}
          max={canvas.height}
          onChange={(y) => onChange(fitTitleLayout(clip, canvas, { y }))}
        />
        <NumberField
          label="Rotation"
          value={clip.rotation}
          min={-180}
          max={180}
          unit="°"
          onChange={(rotation) => onChange(fitTitleLayout(clip, canvas, { rotation }))}
        />
        <NumberField
          label="Layer order"
          value={clip.zIndex}
          min={-1000}
          max={1000}
          step={1}
          onChange={(zIndex) => onChange({ zIndex: Math.round(zIndex) })}
        />
      </fieldset>
      <TitleSlider
        label="Title opacity"
        value={clip.opacity}
        min={0}
        max={1}
        step={0.05}
        onChange={(opacity) => onChange({ opacity })}
      />
    </InspectorSection>
  )
}
