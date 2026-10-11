import { useMemo } from "react"
import type { CaptionClip, MediaMetadata, TimelineTrack } from "@recordforge/contracts"
import { Sparkles } from "lucide-react"
import { analyzeCaptionCue, resolveClipDesign } from "@recordforge/editor-core"
import { Badge, SimpleSelect, Textarea } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useTimelineInteraction } from "../timeline/use-timeline-interaction"
import { ClipPropertiesInspector } from "./clip-properties-inspector"
import { InspectorSection } from "./fields"

interface CaptionClipInspectorProps {
  clip: CaptionClip
  track: TimelineTrack
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
  const canvas = useTimelineStore((state) => state.engine?.history.present.canvas)

  // Warning badges come from the same layout engine the renderer uses —
  // memoized on text/times/design/canvas so typing recomputes cheaply.
  const analysis = useMemo(() => {
    if (!canvas) return null
    return analyzeCaptionCue(
      { text: clip.text, startMs: clip.startMs, endMs: clip.startMs + clip.durationMs },
      resolveClipDesign(track, clip),
      { width: canvas.width, height: canvas.height, aspectRatio: canvas.aspectRatio },
    )
  }, [canvas, track, clip])

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
            {clip.words && clip.words.length > 0 ? (
              <Badge
                variant="outline"
                title="Precise per-word timing from the AI transcript — use Resync on the Captions panel to re-align it after audio edits; editing the text resets it"
              >
                AI word timing
              </Badge>
            ) : null}
          </div>
          <Textarea
            aria-label="Caption text"
            value={clip.text}
            rows={3}
            onChange={(event) =>
              interaction.updateCaption(clip.id, { text: event.target.value }, { phase: "commit" })
            }
          />
          {analysis ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {analysis.warnings.includes("too-long") ? (
                <Badge variant="warning">Splits into {analysis.pages} pages</Badge>
              ) : null}
              {analysis.warnings.includes("fast") ? (
                <Badge variant="warning">
                  Very fast ({Math.round(analysis.charsPerSecond)} chars/s)
                </Badge>
              ) : null}
              {analysis.warnings.includes("short") ? (
                <Badge variant="warning">Very short (&lt;0.5s)</Badge>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
            <span>Position override</span>
            <SimpleSelect
              aria-label="Caption position override"
              size="sm"
              value={clip.placement ?? "track"}
              onValueChange={(val) =>
                interaction.updateCaption(
                  clip.id,
                  {
                    // "Track default" sends null — clears the per-clip
                    // override back to inherit (same convention as the
                    // design accent/uppercase resets).
                    placement: val === "track" ? null : (val as NonNullable<typeof clip.placement>),
                  },
                  { phase: "commit" },
                )
              }
              options={[
                { value: "track", label: "Track default" },
                { value: "top", label: "Top" },
                { value: "center", label: "Center" },
                { value: "bottom", label: "Bottom" },
              ]}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            Edit start and end in the source fields above; caption timing remains non-destructive.
          </p>
        </div>
      </InspectorSection>
    </div>
  )
}
