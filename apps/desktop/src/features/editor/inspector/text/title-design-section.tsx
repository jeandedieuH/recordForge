import type { ReactNode } from "react"
import type {
  TextAlignment,
  TextBackdropStyle,
  TextFontFamily,
  TextFontWeight,
} from "@recordforge/contracts"
import { applyTitleAppearance } from "@recordforge/editor-core"
import { ColorPicker, Label, Switch, ToggleGroup, ToggleGroupItem } from "@recordforge/ui"
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react"
import { InspectorSection, NumberField } from "../fields"
import { TitleSelect, TitleSlider, type TitleSectionProps } from "./title-inspector-fields"

export function TitleDesignSection({
  clip,
  onChange,
  children,
}: TitleSectionProps & { children?: ReactNode }) {
  const design = clip.titleDesign
  return (
    <InspectorSection title="Design">
      {children}
      {design && (
        <>
          <TitleSelect
            label="Appearance"
            value={design.appearance}
            options={[
              ["dark", "Dark · bright type"],
              ["light", "Light · dark type"],
              ["transparent", "Transparent · no backdrop"],
            ]}
            onChange={(appearance) => onChange(applyTitleAppearance(clip, appearance))}
          />
          <p className="text-xs text-muted-foreground">
            Appearance sets a coordinated palette. Fine-tune individual colors below.
          </p>
        </>
      )}
      {/* Colors & Backdrop Styling */}
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
        <NumberField
          label="Type size"
          value={clip.fontSize}
          min={8}
          max={200}
          unit="px"
          onChange={(fontSize) => onChange({ fontSize })}
        />
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
