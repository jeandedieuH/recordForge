import { InspectorSection } from "./fields"
import { AnnotationNumberField, AnnotationSlider } from "./annotation-inspector-fields"
import {
  changeAnnotationLayout,
  isAnnotationLine,
  type AnnotationInspectorProps,
} from "./annotation-inspector-helpers"

export function AnnotationLayoutTab({ clip, onChange }: AnnotationInspectorProps) {
  const isLine = isAnnotationLine(clip.annotationType)
  return (
    <div className="flex flex-col gap-4">
      {/* Geometry / Transform */}
      <fieldset disabled={clip.locked} className="min-w-0 flex flex-col gap-4 disabled:opacity-60">
        <InspectorSection title="Position & size">
          <div className="grid grid-cols-2 gap-3">
            <AnnotationNumberField
              label="X position"
              value={Math.round(clip.x)}
              unit="px"
              onChange={(x) => onChange(changeAnnotationLayout(clip, { x }))}
            />
            <AnnotationNumberField
              label="Y position"
              value={Math.round(clip.y)}
              unit="px"
              onChange={(y) => onChange(changeAnnotationLayout(clip, { y }))}
            />
            <AnnotationNumberField
              label="Width"
              value={Math.round(clip.width)}
              min={isLine ? 0 : 10}
              unit="px"
              onChange={(width) => onChange(changeAnnotationLayout(clip, { width }))}
            />
            <AnnotationNumberField
              label="Height"
              value={Math.round(clip.height)}
              min={isLine ? 0 : 10}
              unit="px"
              onChange={(height) => onChange(changeAnnotationLayout(clip, { height }))}
            />
          </div>
        </InspectorSection>
        {isLine && (
          <InspectorSection title="End point">
            <div className="grid grid-cols-2 gap-3">
              <AnnotationNumberField
                label="End X"
                value={Math.round(clip.endX ?? clip.x + clip.width)}
                unit="px"
                onChange={(endX) => onChange(changeAnnotationLayout(clip, { endX }))}
              />
              <AnnotationNumberField
                label="End Y"
                value={Math.round(clip.endY ?? clip.y + clip.height)}
                unit="px"
                onChange={(endY) => onChange(changeAnnotationLayout(clip, { endY }))}
              />
            </div>
          </InspectorSection>
        )}
        {clip.annotationType === "callout" &&
          clip.endX !== undefined &&
          clip.endY !== undefined && (
            <InspectorSection title="Pointer target">
              <div className="grid grid-cols-2 gap-3">
                <AnnotationNumberField
                  label="Target X"
                  value={Math.round(clip.endX)}
                  unit="px"
                  onChange={(endX) => onChange({ endX })}
                />
                <AnnotationNumberField
                  label="Target Y"
                  value={Math.round(clip.endY)}
                  unit="px"
                  onChange={(endY) => onChange({ endY })}
                />
              </div>
            </InspectorSection>
          )}
      </fieldset>
      {clip.locked && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Position is locked. Unlock in the header to adjust layout.
        </p>
      )}
      <AnnotationSlider
        label="Opacity"
        value={clip.opacity}
        displayValue={`${Math.round(clip.opacity * 100)}%`}
        max={1}
        step={0.05}
        onChange={(opacity) => onChange({ opacity })}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        Coordinates use the project canvas. Drag the annotation in the preview for quick placement.
      </p>
    </div>
  )
}
