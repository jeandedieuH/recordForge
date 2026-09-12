import type {
  AnnotationArrowStyle,
  AnnotationHead,
  AnnotationStrokeStyle,
  AnnotationType,
} from "@recordforge/contracts"
import { calloutDefaultTarget } from "@recordforge/editor-core"
import { ColorPicker, Switch, Textarea, ToggleGroup, ToggleGroupItem } from "@recordforge/ui"
import { InspectorSection } from "./fields"
import {
  AnnotationNumberField,
  AnnotationSelect,
  AnnotationSlider,
} from "./annotation-inspector-fields"
import {
  changeAnnotationType,
  isAnnotationLine,
  type AnnotationInspectorProps,
} from "./annotation-inspector-helpers"

export function AnnotationStyleTab({ clip, onChange }: AnnotationInspectorProps) {
  const isLine = isAnnotationLine(clip.annotationType)
  const isCallout = clip.annotationType === "callout"
  const hasPointerTarget = isCallout && clip.endX !== undefined && clip.endY !== undefined
  const hasText = clip.annotationType === "callout" || clip.annotationType === "badge"
  return (
    <div className="flex flex-col gap-4">
      {/* Shape Type Selector */}
      <AnnotationSelect<AnnotationType>
        label="Shape"
        value={clip.annotationType}
        options={SHAPE_OPTIONS}
        disabled={clip.locked}
        onChange={(type) => onChange(changeAnnotationType(clip, type))}
      />
      {clip.locked && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Unlock position to change shape. Colors and styling remain editable.
        </p>
      )}

      {/* Text Settings for Callouts & Badges */}
      {hasText && (
        <InspectorSection title="Text content">
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            <span>Label / note text</span>
            <Textarea
              value={clip.text ?? ""}
              onChange={(event) => onChange({ text: event.target.value })}
              placeholder="Enter annotation text…"
              rows={2}
              className="min-h-16 resize-y text-xs"
            />
          </label>
          <div className="grid grid-cols-2 items-end gap-3">
            <AnnotationNumberField
              label="Font size"
              value={clip.fontSize}
              min={8}
              max={120}
              onChange={(fontSize) => onChange({ fontSize })}
            />
            <ColorRow
              label="Text"
              value={clip.textColor}
              onChange={(textColor) => onChange({ textColor })}
            />
          </div>
        </InspectorSection>
      )}

      {/* Stroke & Color Style */}
      <InspectorSection title="Appearance">
        <div className="grid grid-cols-2 gap-3">
          <ColorRow
            label="Stroke"
            value={clip.strokeColor}
            onChange={(strokeColor) => onChange({ strokeColor })}
          />
          {/* Fill & Background */}
          {!isLine && (
            <ColorRow
              label="Fill"
              value={clip.fillColor}
              onChange={(fillColor) => onChange({ fillColor })}
            />
          )}
        </div>
        <AnnotationSlider
          label="Stroke width"
          value={clip.strokeWidth}
          displayValue={`${clip.strokeWidth} px`}
          max={64}
          onChange={(strokeWidth) => onChange({ strokeWidth })}
        />
        <ToggleGroup
          type="single"
          value={clip.strokeStyle}
          aria-label="Stroke style"
          onValueChange={(value) =>
            value && onChange({ strokeStyle: value as AnnotationStrokeStyle })
          }
          className="grid grid-cols-3 rounded-md border border-border bg-surface-dim p-0.5"
        >
          {(["solid", "dashed", "dotted"] as const).map((style) => (
            <ToggleGroupItem key={style} value={style} className="h-7 px-2 text-xs capitalize">
              {style}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {!isLine && (
          <AnnotationSlider
            label={clip.annotationType === "spotlight" ? "Dimming" : "Fill opacity"}
            value={clip.fillOpacity}
            displayValue={`${Math.round(clip.fillOpacity * 100)}%`}
            max={1}
            step={0.05}
            onChange={(fillOpacity) => onChange({ fillOpacity })}
          />
        )}
        {(clip.annotationType === "rounded-rect" || clip.annotationType === "callout") && (
          <AnnotationSlider
            label="Corner radius"
            value={clip.cornerRadius}
            displayValue={`${clip.cornerRadius} px`}
            max={100}
            step={2}
            onChange={(cornerRadius) => onChange({ cornerRadius })}
          />
        )}
      </InspectorSection>

      {/* Connector routing & arrow heads for arrows/lines */}
      {isLine && (
        <InspectorSection title="Line ends">
          <AnnotationSelect<AnnotationArrowStyle>
            label="Connector"
            value={clip.arrowStyle}
            options={ARROW_STYLE_OPTIONS}
            onChange={(arrowStyle) => onChange({ arrowStyle })}
          />
          <div className="grid grid-cols-2 gap-3">
            <AnnotationSelect<AnnotationHead>
              label="Start head"
              value={clip.arrowStartHead}
              options={HEAD_OPTIONS}
              onChange={(arrowStartHead) => onChange({ arrowStartHead })}
            />
            <AnnotationSelect<AnnotationHead>
              label="End head"
              value={clip.arrowEndHead}
              options={HEAD_OPTIONS}
              onChange={(arrowEndHead) => onChange({ arrowEndHead })}
            />
          </div>
        </InspectorSection>
      )}

      {/* Callout leader: an optional arrow pointing at a target */}
      {isCallout && (
        <InspectorSection title="Pointer">
          <label className="flex items-center justify-between gap-2 text-xs text-foreground">
            Arrow pointer
            <Switch
              checked={hasPointerTarget}
              onCheckedChange={(enabled) => {
                if (!enabled) {
                  onChange({ endX: undefined, endY: undefined })
                  return
                }
                const target = calloutDefaultTarget(clip.x, clip.y, clip.width, clip.height)
                onChange({
                  endX: clip.endX ?? target.x,
                  endY: clip.endY ?? target.y,
                  arrowEndHead: clip.arrowEndHead === "none" ? "arrow" : clip.arrowEndHead,
                })
              }}
            />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {hasPointerTarget
              ? "Drag the tip handle on the canvas to point at content."
              : "A classic speech tail is drawn below the bubble instead."}
          </p>
          {hasPointerTarget && (
            <div className="grid grid-cols-2 gap-3">
              <AnnotationSelect<AnnotationArrowStyle>
                label="Pointer style"
                value={clip.arrowStyle}
                options={ARROW_STYLE_OPTIONS}
                onChange={(arrowStyle) => onChange({ arrowStyle })}
              />
              <AnnotationSelect<AnnotationHead>
                label="Tip"
                value={clip.arrowEndHead}
                options={HEAD_OPTIONS}
                onChange={(arrowEndHead) => onChange({ arrowEndHead })}
              />
            </div>
          )}
        </InspectorSection>
      )}

      {/* Shadow & Glow */}
      <InspectorSection title="Shadow" defaultOpen={false}>
        <label className="flex items-center justify-between gap-2 text-xs text-foreground">
          Drop shadow
          <Switch
            checked={clip.shadowEnabled}
            onCheckedChange={(shadowEnabled) => onChange({ shadowEnabled })}
          />
        </label>
        {clip.shadowEnabled && (
          <AnnotationSlider
            label="Shadow blur"
            value={clip.shadowBlur}
            displayValue={`${clip.shadowBlur} px`}
            max={100}
            onChange={(shadowBlur) => onChange({ shadowBlur })}
          />
        )}
      </InspectorSection>
    </div>
  )
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
      <span>{label}</span>
      {/* Stack labels so the swatch and value fit a narrow inspector's two-column fields. */}
      <ColorPicker
        aria-label={`${label} color`}
        size="sm"
        value={value}
        onChange={onChange}
        className="min-w-0 w-full"
        triggerClassName="h-8 min-w-0 w-full px-1.5 [&_span]:text-xs"
      />
    </div>
  )
}

const SHAPE_OPTIONS: { value: AnnotationType; label: string }[] = [
  { value: "rectangle", label: "Rectangle" },
  { value: "rounded-rect", label: "Rounded rectangle" },
  { value: "circle", label: "Circle" },
  { value: "arrow", label: "Arrow" },
  { value: "line", label: "Line" },
  { value: "callout", label: "Callout" },
  { value: "spotlight", label: "Spotlight" },
  { value: "badge", label: "Badge" },
]

const ARROW_STYLE_OPTIONS: { value: AnnotationArrowStyle; label: string }[] = [
  { value: "straight", label: "Straight" },
  { value: "elbow", label: "Elbow" },
  { value: "curved", label: "Curved" },
]

// The shared contract/renderer supports diamond heads; "square" was never a valid head value.
const HEAD_OPTIONS: { value: AnnotationHead; label: string }[] = [
  { value: "none", label: "None" },
  { value: "arrow", label: "Arrow" },
  { value: "circle", label: "Circle" },
  { value: "diamond", label: "Diamond" },
]
