import type { ReactNode } from "react"
import type {
  TextAlignment,
  TextBackdropStyle,
  TextClip,
  TextFontFamily,
  TextFontWeight,
  TitleDesign,
} from "@recordforge/contracts"
import {
  getTitleContentLabels,
  hasTitleFontSizeOverrides,
  resolveTitleFontSizes,
  type TitleFontSizeKey,
} from "@recordforge/editor-core"
import { Button, ColorPicker, Label, Switch, ToggleGroup, ToggleGroupItem } from "@recordforge/ui"
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react"
import { InspectorSection, NumberField } from "../fields"
import { TitleSelect, TitleSlider, type TitleSectionProps } from "./title-inspector-fields"

function patch(design: TitleDesign, onChange: TitleSectionProps["onChange"]) {
  return (update: Partial<TitleDesign>) => onChange({ titleDesign: { ...design, ...update } })
}

export function TitleDesignSection({
  clip,
  onChange,
  children,
}: TitleSectionProps & { children?: ReactNode }) {
  const design = clip.titleDesign
  const set = design ? patch(design, onChange) : undefined
  return (
    <InspectorSection title="Style">
      {children}
      {/* Colors */}
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ["accentColor", "Accent"],
            ["textColor", "Type"],
            ["secondaryTextColor", "Secondary"],
            ["backdropColor", "Backdrop"],
          ] as const
        ).map(([field, label]) => (
          <div
            key={field}
            className="flex items-center justify-between gap-2 rounded-md bg-surface-dim p-2"
          >
            <span className="text-xs text-muted-foreground">{label}</span>
            <ColorPicker
              aria-label={`${label} color`}
              size="sm"
              value={clip[field]}
              onChange={(value) => onChange({ [field]: value })}
            />
          </div>
        ))}
      </div>
      {/* Typography */}
      <div className="grid grid-cols-2 gap-2">
        <TitleSelect<TextFontFamily>
          label="Typeface"
          value={
            clip.fontFamily === "inter"
              ? "sans"
              : clip.fontFamily === "outfit"
                ? "heading"
                : clip.fontFamily
          }
          options={[
            ["sans", "Inter · clean"],
            ["heading", "Outfit · display"],
            ["serif", "Source Serif · editorial"],
            ["mono", "JetBrains Mono · code"],
          ]}
          onChange={(fontFamily) => onChange({ fontFamily })}
        />
        <TitleSelect<TextFontWeight>
          label="Weight"
          value={clip.fontWeight}
          options={[
            ["400", "Regular"],
            ["500", "Medium"],
            ["600", "Semibold"],
            ["700", "Bold"],
            ["800", "Extra bold"],
            ["900", "Black"],
          ]}
          onChange={(fontWeight) => onChange({ fontWeight })}
        />
        {!design && (
          <NumberField
            label="Type size"
            value={clip.fontSize}
            min={8}
            max={200}
            unit="px"
            onChange={(fontSize) => onChange({ fontSize })}
          />
        )}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Text alignment</span>
          <ToggleGroup
            type="single"
            aria-label="Text alignment"
            value={clip.alignment}
            onValueChange={(value) => value && onChange({ alignment: value as TextAlignment })}
          >
            <ToggleGroupItem value="left" aria-label="Align text left" className="size-8 p-0">
              <AlignLeft className="size-4" aria-hidden />
            </ToggleGroupItem>
            <ToggleGroupItem value="center" aria-label="Align text center" className="size-8 p-0">
              <AlignCenter className="size-4" aria-hidden />
            </ToggleGroupItem>
            <ToggleGroupItem value="right" aria-label="Align text right" className="size-8 p-0">
              <AlignRight className="size-4" aria-hidden />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      {design && set && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <TitleSlider
              label="Letter spacing"
              value={design.typography.letterSpacing}
              min={-0.05}
              max={0.3}
              step={0.01}
              onChange={(letterSpacing) =>
                set({ typography: { ...design.typography, letterSpacing } })
              }
            />
            <TitleSlider
              label="Line height"
              value={design.typography.lineHeight}
              min={0.8}
              max={2}
              step={0.05}
              onChange={(lineHeight) => set({ typography: { ...design.typography, lineHeight } })}
            />
          </div>
          {/* Fill: solid or linear gradient over the primary glyphs */}
          <TitleSelect
            label="Title fill"
            value={design.fill.kind}
            options={[
              ["solid", "Solid"],
              ["gradient", "Gradient"],
            ]}
            onChange={(kind) => set({ fill: { ...design.fill, kind } })}
          />
          {design.fill.kind === "gradient" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                {design.fill.gradientStops.slice(0, 2).map((stop, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between gap-2 rounded-md bg-surface-dim p-2"
                  >
                    <span className="text-xs text-muted-foreground">
                      {index === 0 ? "Gradient from" : "Gradient to"}
                    </span>
                    <ColorPicker
                      aria-label={`Gradient color ${index + 1}`}
                      size="sm"
                      value={stop.color}
                      onChange={(color) => {
                        const gradientStops = design.fill.gradientStops.map((entry, i) =>
                          i === index ? { ...entry, color } : entry,
                        )
                        set({ fill: { ...design.fill, gradientStops } })
                      }}
                    />
                  </div>
                ))}
              </div>
              <TitleSlider
                label="Gradient angle"
                value={design.fill.gradientAngle}
                min={0}
                max={360}
                step={5}
                unit="°"
                onChange={(gradientAngle) => set({ fill: { ...design.fill, gradientAngle } })}
              />
            </>
          )}
          {/* Stroke / shadow / glow */}
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`title-${clip.id}-stroke`}>Stroke</Label>
            <Switch
              id={`title-${clip.id}-stroke`}
              aria-label="Stroke"
              checked={design.stroke !== undefined}
              onCheckedChange={(on) =>
                set({
                  stroke: on ? { color: clip.accentColor, width: 2 } : undefined,
                })
              }
            />
          </div>
          {design.stroke && (
            <div className="grid grid-cols-2 items-center gap-2">
              <ColorPicker
                aria-label="Stroke color"
                size="sm"
                value={design.stroke.color}
                onChange={(color) => set({ stroke: { ...design.stroke!, color } })}
              />
              <TitleSlider
                label="Stroke width"
                value={design.stroke.width}
                min={0.5}
                max={16}
                step={0.5}
                unit="px"
                onChange={(width) => set({ stroke: { ...design.stroke!, width } })}
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`title-${clip.id}-shadow-v2`}>Shadow</Label>
            <Switch
              id={`title-${clip.id}-shadow-v2`}
              aria-label="Title shadow"
              checked={design.shadow !== undefined}
              onCheckedChange={(on) =>
                set({
                  shadow: on
                    ? { color: "rgba(0, 0, 0, 0.45)", blur: 24, offsetX: 0, offsetY: 8 }
                    : undefined,
                })
              }
            />
          </div>
          {design.shadow && (
            <TitleSlider
              label="Shadow softness"
              value={design.shadow.blur}
              min={0}
              max={120}
              step={2}
              unit="px"
              onChange={(blur) => set({ shadow: { ...design.shadow!, blur } })}
            />
          )}
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`title-${clip.id}-glow`}>Glow</Label>
            <Switch
              id={`title-${clip.id}-glow`}
              aria-label="Title glow"
              checked={design.glow !== undefined}
              onCheckedChange={(on) =>
                set({ glow: on ? { color: clip.accentColor, blur: 36 } : undefined })
              }
            />
          </div>
          {design.glow && (
            <TitleSlider
              label="Glow radius"
              value={design.glow.blur}
              min={1}
              max={120}
              step={2}
              unit="px"
              onChange={(blur) => set({ glow: { ...design.glow!, blur } })}
            />
          )}
          {/* Emphasis + backdrop + accent */}
          {(design.template === "hook-emphasis" || design.template === "highlight") && (
            <TitleSelect
              label="Emphasis style"
              value={design.emphasis.style}
              options={[
                ["color", "Accent color"],
                ["marker", "Marker highlight"],
                ["underline", "Underline"],
                ["strike", "Strike-through"],
                ["box", "Accent box"],
              ]}
              onChange={(style) => set({ emphasis: { ...design.emphasis, style } })}
            />
          )}
          <TitleSelect
            label="Backdrop"
            value={design.backdrop.style}
            options={[
              ["none", "None"],
              ["box", "Box"],
              ["pill", "Pill"],
              ["glass", "Frosted glass"],
              ["bar", "Accent bar"],
              ["brackets", "Brackets"],
              ["split", "Split panel"],
            ]}
            onChange={(style) => set({ backdrop: { ...design.backdrop, style } })}
          />
          <TitleSelect
            label="Accent detail"
            value={design.accent.style}
            options={[
              ["none", "None"],
              ["bar", "Accent bar"],
              ["dot", "Dot"],
              ["number", "Number badge"],
            ]}
            onChange={(style) => set({ accent: { ...design.accent, style } })}
          />
          <TitleElementSizes clip={clip} design={design} onChange={onChange} />
        </>
      )}
      {!design && (
        <TitleSelect<TextBackdropStyle>
          label="Legacy surface"
          value={clip.backdropStyle}
          options={[
            ["none", "None (transparent)"],
            ["glass", "Translucent panel"],
            ["solid", "Solid card"],
            ["accent-bar", "Accent bar"],
            ["pill", "Pill badge"],
            ["gradient", "Shaded banner (legacy)"],
            ["outline", "Outline"],
          ]}
          onChange={(backdropStyle) => onChange({ backdropStyle })}
        />
      )}
    </InspectorSection>
  )
}

// Designed titles size each text element independently: unset fields follow the
// template's `fontSize * ratio` proportion, edited fields store absolute overrides
// on `titleDesign.elements.<role>.size` which the overlay engine resolves per role.
function TitleElementSizes({
  clip,
  design,
  onChange,
}: {
  clip: TextClip
  design: TitleDesign
  onChange: TitleSectionProps["onChange"]
}) {
  const labels = getTitleContentLabels(design.template)
  const sizes = resolveTitleFontSizes(design, clip.fontSize)
  const fields: readonly (readonly [TitleFontSizeKey, string])[] = [
    ["primary", labels.primary],
    ["secondary", labels.secondary],
    ["tag", labels.tag],
    ...(design.template === "stat" ||
    design.template === "stat-before-after" ||
    design.template === "countdown"
      ? ([["metric", "Metric value"]] as const)
      : []),
  ]
  function setSize(key: TitleFontSizeKey, value: number) {
    onChange({
      titleDesign: {
        ...design,
        elements: { ...design.elements, [key]: { ...design.elements[key], size: value } },
      },
    })
  }
  function resetSizes() {
    const elements = { ...design.elements }
    for (const key of Object.keys(elements) as TitleFontSizeKey[]) {
      if (!elements[key]) continue
      const { size: _size, ...rest } = elements[key]!
      elements[key] = rest
    }
    onChange({ titleDesign: { ...design, elements } })
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Text sizes</span>
        {hasTitleFontSizeOverrides(design) && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={resetSizes}>
            Reset to preset
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {fields.map(([key, label]) => (
          <NumberField
            key={key}
            label={`${label} size`}
            value={Math.round(sizes[key])}
            min={4}
            max={400}
            unit="px"
            onChange={(value) => setSize(key, value)}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Each element keeps its own size and still shrinks to fit its slot.
      </p>
    </div>
  )
}

export function LegacySurfaceControls({ clip, onChange }: TitleSectionProps) {
  return (
    <>
      {clip.backdropStyle !== "none" && (
        <>
          <TitleSlider
            label="Backdrop opacity"
            value={clip.backdropOpacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(backdropOpacity) => onChange({ backdropOpacity })}
          />
          <NumberField
            label="Corner radius"
            value={clip.backdropBorderRadius}
            min={0}
            max={100}
            unit="px"
            onChange={(backdropBorderRadius) => onChange({ backdropBorderRadius })}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Horizontal padding"
              value={clip.backdropPaddingX}
              min={0}
              max={100}
              onChange={(backdropPaddingX) => onChange({ backdropPaddingX })}
            />
            <NumberField
              label="Vertical padding"
              value={clip.backdropPaddingY}
              min={0}
              max={100}
              onChange={(backdropPaddingY) => onChange({ backdropPaddingY })}
            />
          </div>
        </>
      )}
      {/* Shadow & Glow */}
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`title-${clip.id}-shadow`}>Legacy shadow</Label>
        <Switch
          id={`title-${clip.id}-shadow`}
          aria-label="Legacy shadow"
          checked={clip.shadowEnabled}
          onCheckedChange={(shadowEnabled) => onChange({ shadowEnabled })}
        />
      </div>
      {clip.shadowEnabled && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Shadow color</span>
            <ColorPicker
              aria-label="Shadow color"
              size="sm"
              value={clip.shadowColor}
              onChange={(shadowColor) => onChange({ shadowColor })}
            />
          </div>
          <TitleSlider
            label="Shadow softness"
            value={clip.shadowBlur}
            min={0}
            max={100}
            step={1}
            unit="px"
            onChange={(shadowBlur) => onChange({ shadowBlur })}
          />
        </>
      )}
    </>
  )
}
