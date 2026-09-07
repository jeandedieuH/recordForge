import { useEffect, useId, useReducer, useState } from "react"
import { getTitleContentLabels } from "@recordforge/editor-core"
import { Input, Label, Textarea } from "@recordforge/ui"
import { InspectorSection, NumberField } from "../fields"
import { createTitleContentDraft, type TitleContentField } from "./title-content-draft"
import { TitleSelect, type TitleSectionProps } from "./title-inspector-fields"

export function TitleContentSection({ clip, onChange }: TitleSectionProps) {
  const [draft] = useState(() => createTitleContentDraft(clip, onChange))
  const [, redraw] = useReducer((value: number) => value + 1, 0)
  draft.sync(clip, onChange)
  // The inspector is keyed by clip.id, so this cleanup retains the original target callback.
  useEffect(() => () => draft.flush(), [draft])
  const labels = getTitleContentLabels(clip.titleDesign?.template)
  const design = clip.titleDesign
  const invalid = !draft.value("primaryText").trim()

  function text(field: TitleContentField, label: string, multiline = false, maxLength?: number) {
    return (
      <ContentField
        key={field}
        label={label}
        value={draft.value(field)}
        multiline={multiline}
        maxLength={maxLength}
        error={
          field === "primaryText" && invalid
            ? "Enter a title before leaving this field. The last saved text is kept until then."
            : undefined
        }
        onChange={(value) => {
          draft.set(field, value)
          redraw()
        }}
        onBlur={() => {
          draft.flush()
          redraw()
        }}
      />
    )
  }

  return (
    // Text Content
    <InspectorSection title="Content">
      {text("primaryText", labels.primary, true)}
      {text("secondaryText", `${labels.secondary} (optional)`, true)}
      {text("tagText", `${labels.tag} (optional)`)}
      {design?.template === "emphasis" && (
        <>
          {text("emphasisText", "Emphasis phrase", false, 500)}
          <p className="text-xs text-muted-foreground">
            Use a phrase from your title to give it accent emphasis.
          </p>
        </>
      )}
      {design?.template === "note" && (
        <TitleSelect
          label="Note tone"
          value={design.noteTone}
          options={[
            ["note", "Note"],
            ["tip", "Tip"],
            ["warning", "Warning"],
          ]}
          onChange={(noteTone) => onChange({ titleDesign: { ...design, noteTone } })}
        />
      )}
      {design?.template === "metric" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Count from"
              value={design.metric.from}
              min={-1_000_000_000}
              max={1_000_000_000}
              onChange={(from) =>
                onChange({ titleDesign: { ...design, metric: { ...design.metric, from } } })
              }
            />
            <NumberField
              label="Count to"
              value={design.metric.to}
              min={-1_000_000_000}
              max={1_000_000_000}
              onChange={(to) =>
                onChange({ titleDesign: { ...design, metric: { ...design.metric, to } } })
              }
            />
            <NumberField
              label="Decimal places"
              value={design.metric.decimals}
              min={0}
              max={3}
              step={1}
              onChange={(decimals) =>
                onChange({
                  titleDesign: {
                    ...design,
                    metric: { ...design.metric, decimals: Math.round(decimals) },
                  },
                })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {text("prefix", "Prefix", false, 20)}
            {text("suffix", "Suffix", false, 20)}
          </div>
        </>
      )}
      {design?.template === "command-line" && (
        <p className="text-xs text-muted-foreground">
          Designed motion types the command automatically. Choose None in Motion to show it
          immediately.
        </p>
      )}
    </InspectorSection>
  )
}

function ContentField({
  label,
  value,
  multiline,
  maxLength,
  error,
  onChange,
  onBlur,
}: {
  label: string
  value: string
  multiline: boolean
  maxLength?: number
  error?: string
  onChange: (value: string) => void
  onBlur: () => void
}) {
  const id = useId()
  const props = {
    id,
    value,
    maxLength,
    "aria-invalid": !!error,
    "aria-describedby": error ? `${id}-error` : undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value),
    onBlur,
  }
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {multiline ? (
        <Textarea {...props} rows={2} className="min-h-14 resize-y text-xs" />
      ) : (
        <Input {...props} className="h-8 text-xs" />
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
