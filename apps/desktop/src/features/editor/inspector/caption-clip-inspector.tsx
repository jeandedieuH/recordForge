import type { CaptionClip, MediaMetadata } from "@recordforge/contracts"
import { Sparkles } from "lucide-react"
import { NativeSelect, Textarea } from "@recordforge/ui"
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
            <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
              Style
              <NativeSelect
                aria-label="Caption style"
                value={clip.style}
                onChange={(event) =>
                  interaction.updateCaption(
                    clip.id,
                    { style: event.target.value as typeof clip.style },
                    { phase: "commit" },
                  )
                }
              >
                <option value="default">Default</option>
                <option value="minimal">Minimal</option>
                <option value="boxed">Boxed</option>
                <option value="highlight">Highlight</option>
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
              Placement
              <NativeSelect
                aria-label="Caption placement"
                value={clip.placement ?? "bottom"}
                onChange={(event) =>
                  interaction.updateCaption(
                    clip.id,
                    {
                      placement: event.target.value as NonNullable<typeof clip.placement>,
                    },
                    { phase: "commit" },
                  )
                }
              >
                <option value="top">Top</option>
                <option value="center">Center</option>
                <option value="bottom">Bottom</option>
              </NativeSelect>
            </label>
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
