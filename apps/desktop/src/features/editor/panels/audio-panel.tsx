import type { AudioClip, TimelineTrack } from "@recordforge/contracts"
import {
  clampAudioGain,
  createUpdateClipAudioCommand,
  createUpdateTrackCommand,
} from "@recordforge/editor-core"
import { Volume2 } from "lucide-react"
import { NumberInputField, ScrollArea, Skeleton, Slider, Switch } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import type { WaveformResources } from "../media/derivative-resources"
import { SmartCutCard } from "./smart-cut/smart-cut-card"

interface AudioPanelProps {
  waveformResources: WaveformResources
}

export function AudioPanel({ waveformResources }: AudioPanelProps) {
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const isLoading = useTimelineStore((state) => state.isLoading)

  const tracks = timeline?.tracks.filter((track) => track.kind === "audio") ?? []

  if (isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3">
        <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
          <Volume2 className="size-4 text-primary" aria-hidden />
          <h2>Audio</h2>
        </div>

        {/* Track rows skeleton */}
        <div className="flex flex-col gap-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-3.5 w-24 rounded" />
                <div className="flex items-center gap-2">
                  <Skeleton className="h-2.5 w-8 rounded" />
                  <Skeleton className="h-4 w-7 rounded-full" />
                </div>
              </div>
              <Skeleton className="h-3 w-full rounded-full" />
            </div>
          ))}
        </div>

        {/* Audio clips skeleton */}
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <Skeleton className="h-3 w-20 rounded" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
        <Volume2 className="size-4 text-primary" aria-hidden />
        <h2>Audio</h2>
      </div>

      {tracks.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          No dedicated audio tracks. Audio is mixed from the screen and camera sources.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {tracks.map((track) => (
            <TrackRow key={track.id} track={track} />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <span className="text-xs font-semibold text-foreground">Audio clips</span>
        {timeline ? (
          <AudioClipsList />
        ) : (
          <p className="text-[11px] text-subtle-foreground">No timeline loaded.</p>
        )}
      </div>

      <div className="border-t border-border pt-3">
        <SmartCutCard waveformResources={waveformResources} />
      </div>
    </div>
  )
}

function TrackRow({ track }: { track: TimelineTrack }) {
  const execute = useTimelineStore((state) => state.execute)
  const audioClips = track.clips.filter((clip): clip is AudioClip => clip.kind === "audio")
  // One control per source: a single-clip track is the recorded source, so the
  // row edits that clip's gain. After a split, the row is the track master and
  // the clip list keeps per-clip gains.
  const singleClip = audioClips.length === 1 ? audioClips[0] : null
  const trackVolume = clampAudioGain(track.volume)
  const effectiveVolume = singleClip
    ? clampAudioGain(trackVolume * clampAudioGain(singleClip.volume))
    : trackVolume
  const canAdjustClip = trackVolume > 0.0001
  const sliderMax = singleClip
    ? Math.max(0.01, Math.min(2, canAdjustClip ? trackVolume * 2 : 2))
    : 2

  function updateVolume(value: number) {
    if (singleClip) {
      if (!canAdjustClip) {
        // A zeroed track master would otherwise strand a single-clip source
        // with no reachable control: restore the master and set the clip.
        if (value > 0) {
          execute(createUpdateTrackCommand(track.id, { volume: 1 }))
          execute(createUpdateClipAudioCommand(singleClip.id, { volume: clampAudioGain(value) }))
        }
        return
      }
      execute(
        createUpdateClipAudioCommand(singleClip.id, {
          volume: clampAudioGain(value / trackVolume),
        }),
      )
      return
    }
    execute(createUpdateTrackCommand(track.id, { volume: value }))
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">{track.name}</span>
          {!singleClip && audioClips.length > 1 ? (
            <span className="shrink-0 text-[9px] uppercase tracking-wide text-subtle-foreground">
              Master
            </span>
          ) : null}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-subtle-foreground">
            {Math.round(effectiveVolume * 100)}%
          </span>
          <Switch
            aria-label={`Mute ${track.name}`}
            checked={track.muted}
            onCheckedChange={(muted) => execute(createUpdateTrackCommand(track.id, { muted }))}
          />
        </div>
      </div>
      <Slider
        value={[effectiveVolume]}
        min={0}
        max={sliderMax}
        step={0.01}
        aria-label={`${track.name} volume`}
        onValueChange={([value]) => updateVolume(value ?? 1)}
        disabled={track.muted}
      />
    </div>
  )
}

function AudioClipsList() {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const clips =
    timeline?.tracks.flatMap((track) =>
      track.clips
        .filter((clip): clip is AudioClip => clip.kind === "audio")
        .map((clip) => ({ clip, track })),
    ) ?? []

  if (clips.length === 0) {
    return (
      <p className="text-[11px] text-subtle-foreground">
        No audio clips. Trim or split the timeline to create discrete audio segments.
      </p>
    )
  }

  return (
    // Cap the height so many clips scroll inside the list instead of pushing
    // the Smart Cut section below out of the panel.
    <ScrollArea className="max-h-64 w-full border border-border p-2 rounded-2xl">
      <div className="flex flex-col gap-2 pr-1">
        {clips.map(({ clip, track }) => {
          const trackVolume = clampAudioGain(track.volume)
          const effectiveVolume = clampAudioGain(trackVolume * clampAudioGain(clip.volume ?? 1))
          return (
            <div
              key={clip.id}
              className="flex flex-col gap-2 rounded-md border border-border bg-surface-dim p-2 text-[11px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-foreground">
                  {formatAudioTime(clip.startMs)} →{" "}
                  {formatAudioTime(clip.startMs + clip.durationMs)}
                </span>
                <span className="shrink-0 text-subtle-foreground">
                  {Math.round(effectiveVolume * 100)}%
                </span>
              </div>
              <Slider
                variant="emerald"
                value={[effectiveVolume]}
                min={0}
                max={Math.max(0.01, Math.min(2, trackVolume * 2))}
                step={0.01}
                aria-label="Clip volume"
                disabled={track.muted || trackVolume <= 0.0001}
                onValueChange={([value]) => {
                  if (trackVolume <= 0.0001) return
                  execute(
                    createUpdateClipAudioCommand(clip.id, {
                      volume: clampAudioGain((value ?? 1) / trackVolume),
                    }),
                  )
                }}
              />
              <div className="grid grid-cols-2 gap-2">
                <NumberInputField
                  size="sm"
                  label="Fade in"
                  unit="ms"
                  min={0}
                  step={50}
                  value={clip.fadeInMs}
                  onChange={(val) =>
                    execute(createUpdateClipAudioCommand(clip.id, { fadeInMs: val }))
                  }
                />
                <NumberInputField
                  size="sm"
                  label="Fade out"
                  unit="ms"
                  min={0}
                  step={50}
                  value={clip.fadeOutMs}
                  onChange={(val) =>
                    execute(createUpdateClipAudioCommand(clip.id, { fadeOutMs: val }))
                  }
                />
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function formatAudioTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const remainder = Math.floor(ms % 1000)
  return `${seconds}.${remainder.toString().padStart(3, "0")}s`
}
