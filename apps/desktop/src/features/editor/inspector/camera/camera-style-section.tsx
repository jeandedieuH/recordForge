import type { BorderStyle } from "@recordforge/contracts"
import { ColorPicker, SimpleSelect, Switch } from "@recordforge/ui"
import { DebouncedSlider, InspectorSection, NumberField } from "../fields"
import type { CameraSectionProps } from "./camera-section-props"

// Border/shadow styling. Style lengths are design units — px on a 1080p
// short edge, scaled up for higher-resolution exports.
export function CameraStyleSection({ frame, onUpdate }: CameraSectionProps) {
  const style = frame.style
  const borderStyle = style.borderStyle ?? "solid"

  return (
    <InspectorSection title="Style" defaultOpen>
      <div className="flex flex-col gap-3">
        <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
          <span>Show camera</span>
          <Switch
            checked={frame.visible !== false}
            onCheckedChange={(visible) => onUpdate({ visible })}
          />
        </label>
        <div className="flex items-center justify-between text-xs">
          <span className="text-subtle-foreground">Opacity</span>
          <span className="font-mono tabular-nums">{Math.round(style.opacity * 100)}%</span>
        </div>
        <DebouncedSlider
          value={[style.opacity]}
          min={0}
          max={1}
          step={0.05}
          aria-label="Camera opacity"
          onValueCommit={(value) => onUpdate({ style: { opacity: value[0] ?? 1 } })}
        />

        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Border width"
            value={style.borderWidth}
            onChange={(value) => onUpdate({ style: { borderWidth: value } })}
          />
          <NumberField
            label="Border opacity"
            value={style.borderOpacity}
            max={1}
            step={0.05}
            onChange={(value) => onUpdate({ style: { borderOpacity: value } })}
          />
        </div>
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          Border and shadow lengths are in px @1080p and scale with the export resolution.
        </p>

        <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
          <span>Border style</span>
          <SimpleSelect
            aria-label="Camera border style"
            size="sm"
            value={borderStyle}
            onValueChange={(value) => onUpdate({ style: { borderStyle: value as BorderStyle } })}
            className="w-32"
            options={[
              { value: "solid", label: "Solid" },
              { value: "gradient", label: "Gradient" },
              { value: "double", label: "Double" },
              { value: "glass", label: "Glass" },
            ]}
          />
        </div>

        {borderStyle === "gradient" ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
              <span>Gradient start</span>
              <ColorPicker
                aria-label="Camera border gradient start colour"
                value={style.borderGradient?.from ?? style.borderColor}
                onChange={(from) =>
                  onUpdate({
                    style: {
                      borderGradient: {
                        from,
                        to: style.borderGradient?.to ?? "#6366f1",
                        angle: style.borderGradient?.angle ?? 135,
                      },
                    },
                  })
                }
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
              <span>Gradient end</span>
              <ColorPicker
                aria-label="Camera border gradient end colour"
                value={style.borderGradient?.to ?? "#6366f1"}
                onChange={(to) =>
                  onUpdate({
                    style: {
                      borderGradient: {
                        from: style.borderGradient?.from ?? style.borderColor,
                        to,
                        angle: style.borderGradient?.angle ?? 135,
                      },
                    },
                  })
                }
              />
            </div>
            <NumberField
              label="Gradient angle"
              value={style.borderGradient?.angle ?? 135}
              min={0}
              max={360}
              step={15}
              onChange={(angle) =>
                onUpdate({
                  style: {
                    borderGradient: {
                      from: style.borderGradient?.from ?? style.borderColor,
                      to: style.borderGradient?.to ?? "#6366f1",
                      angle,
                    },
                  },
                })
              }
            />
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
            <span>Border color</span>
            <ColorPicker
              aria-label="Camera border color"
              value={style.borderColor}
              onChange={(borderColor) => onUpdate({ style: { borderColor } })}
            />
          </div>
        )}

        <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
          <span>Shadow</span>
          <Switch
            checked={style.shadowEnabled}
            onCheckedChange={(shadowEnabled) => onUpdate({ style: { shadowEnabled } })}
          />
        </label>
        {style.shadowEnabled ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="Shadow blur"
                value={style.shadowBlur}
                onChange={(value) => onUpdate({ style: { shadowBlur: value } })}
              />
              <NumberField
                label="Shadow X"
                value={style.shadowOffsetX}
                onChange={(value) => onUpdate({ style: { shadowOffsetX: value } })}
              />
              <NumberField
                label="Shadow Y"
                value={style.shadowOffsetY}
                onChange={(value) => onUpdate({ style: { shadowOffsetY: value } })}
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
              <span>Shadow color</span>
              <ColorPicker
                aria-label="Camera shadow color"
                value={style.shadowColor}
                onChange={(shadowColor) => onUpdate({ style: { shadowColor } })}
              />
            </div>
          </>
        ) : null}
      </div>
    </InspectorSection>
  )
}
