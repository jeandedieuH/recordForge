import type { AudioClip, MediaMetadata } from "@recordforge/contracts"
import { createUpdateClipAudioCommand } from "@recordforge/editor-core"
import { Volume2 } from "lucide-react"
import { DebouncedSlider, InspectorSection, NumberField } from "./fields"
import { useTimelineStore } from "../../../stores/timeline-store"
import { ClipPropertiesInspector } from "./clip-properties-inspector"

interface AudioClipInspectorProps {
  clip: AudioClip
  track: import("@recordforge/contracts").TimelineTrack
  metadata: MediaMetadata | null
  selectedClipCount?: number
}

export function AudioClipInspector({
  clip,
  track,
  metadata,
  selectedClipCount = 1,
}: AudioClipInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)

  function updateAudio(update: Parameters<typeof createUpdateClipAudioCommand>[1]) {
    execute(createUpdateClipAudioCommand(clip.id, update))
  }

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
            <Volume2 className="size-4 text-track-mic" aria-hidden />
            <span>Audio</span>
          </div>
          <div className="flex items-center justify-between text-xs text-subtle-foreground">
            <span>Clip volume</span>
            <span className="font-mono tabular-nums text-foreground">
              {Math.round(clip.volume * 100)}%
            </span>
          </div>
          <DebouncedSlider
            value={[clip.volume]}
            min={0}
            max={2}
            step={0.01}
            aria-label="Clip volume"
            onValueCommit={([value]) => updateAudio({ volume: value ?? 1 })}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Fade in (ms)"
              value={clip.fadeInMs}
              min={0}
              onChange={(value) => updateAudio({ fadeInMs: value })}
            />
            <NumberField
              label="Fade out (ms)"
              value={clip.fadeOutMs}
              min={0}
              onChange={(value) => updateAudio({ fadeOutMs: value })}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            Track mute and volume controls apply independently to {track.name}.
          </p>
        </div>
      </InspectorSection>
    </div>
  )
}
