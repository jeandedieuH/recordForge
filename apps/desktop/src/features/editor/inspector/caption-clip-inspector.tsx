import type { CaptionClip, MediaMetadata } from "@recordforge/contracts"
import { Sparkles } from "lucide-react"
import { SimpleSelect, Textarea } from "@recordforge/ui"
import { useTimelineInteraction } from "../timeline/use-timeline-interaction"
import { ClipPropertiesInspector } from "./clip-properties-inspector"
import { InspectorSection, NumberField } from "./fields"

interface CaptionClipInspectorProps {
  clip: CaptionClip
  track: import("@recordforge/contracts").TimelineTrack
  metadata: MediaMetadata | null
  selectedClipCount?: number
}

export function CaptionClipInspector({
  clip,
  track,
  metadata,
  selectedClipCount = 1,
}: CaptionClipInspectorProps) {
  const interaction = useTimelineInteraction()

  return (
    <div className="flex flex-col gap-4">
      <InspectorSection title="Basic" defaultOpen>
        <ClipPropertiesInspector
          clip={clip}
          track={track}
          metadata={metadata}
          selectedClipCount={selectedClipCount}
        />
      </InspectorSection>

      <InspectorSection title="Advanced" defaultOpen>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            <Sparkles className="size-4 text-primary" aria-hidden />
            <span>Caption</span>
          </div>
          <Textarea
            aria-label="Caption text"
            value={clip.text}
            rows={3}
            onChange={(event) =>
              interaction.updateCaption(clip.id, { text: event.target.value }, { phase: "commit" })
            }
          />
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
              <span>Style</span>
              <SimpleSelect
                aria-label="Caption style"
                size="sm"
                value={clip.style}
                onValueChange={(val) =>
                  interaction.updateCaption(
                    clip.id,
                    { style: val as typeof clip.style },
                    { phase: "commit" },
                  )
                }
                options={[
                  { value: "default", label: "Default" },
                  { value: "minimal", label: "Minimal" },
                  { value: "boxed", label: "Boxed" },
                  { value: "highlight", label: "Highlight" },
                ]}
              />
            </div>
            <div className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
              <span>Placement</span>
              <SimpleSelect
                aria-label="Caption placement"
                size="sm"
                value={clip.placement ?? "bottom"}
                onValueChange={(val) =>
                  interaction.updateCaption(
                    clip.id,
                    {
                      placement: val as NonNullable<typeof clip.placement>,
                    },
                    { phase: "commit" },
                  )
                }
                options={[
                  { value: "top", label: "Top" },
                  { value: "center", label: "Center" },
                  { value: "bottom", label: "Bottom" },
                ]}
              />
            </div>
          </div>
          <NumberField
            label="Safe area margin (ms)"
            value={clip.safeAreaMargin ?? 0}
            min={0}
            onChange={(value) =>
              interaction.updateCaption(clip.id, { safeAreaMargin: value }, { phase: "commit" })
            }
          />
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            Edit start and end in the source fields above; caption timing remains non-destructive.
          </p>
        </div>
      </InspectorSection>
    </div>
  )
}
