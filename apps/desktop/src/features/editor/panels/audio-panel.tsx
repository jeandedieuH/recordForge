import type { AudioClip, TimelineTrack } from "@recordforge/contracts"
import { createUpdateClipAudioCommand, createUpdateTrackCommand } from "@recordforge/editor-core"
import { Volume2 } from "lucide-react"
import { Skeleton, Slider, Switch } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

export function AudioPanel() {
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
    </div>
  )
}

function TrackRow({ track }: { track: TimelineTrack }) {
  const execute = useTimelineStore((state) => state.execute)

  function updateVolume(value: number) {
    execute(createUpdateTrackCommand(track.id, { volume: value }))
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{track.name}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-subtle-foreground">
            {Math.round(track.volume * 100)}%
          </span>
          <Switch
            aria-label={`Mute ${track.name}`}
            checked={track.muted}
            onCheckedChange={(muted) => execute(createUpdateTrackCommand(track.id, { muted }))}
          />
        </div>
      </div>
      <Slider
        value={[track.volume]}
        min={0}
        max={2}
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
      track.clips.filter((clip): clip is AudioClip => clip.kind === "audio"),
    ) ?? []

  if (clips.length === 0) {
    return (
      <p className="text-[11px] text-subtle-foreground">
        No audio clips. Trim or split the timeline to create discrete audio segments.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {clips.map((clip) => (
        <div
          key={clip.id}
          className="flex flex-col gap-2 rounded-md border border-border bg-surface-dim p-2 text-[11px]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium text-foreground">
              {formatAudioTime(clip.startMs)} → {formatAudioTime(clip.startMs + clip.durationMs)}
            </span>
            <span className="shrink-0 text-subtle-foreground">
              {Math.round((clip.volume ?? 1) * 100)}%
            </span>
          </div>
          <Slider
            value={[clip.volume ?? 1]}
            min={0}
            max={2}
            step={0.01}
            aria-label="Clip volume"
            onValueChange={([value]) =>
              execute(createUpdateClipAudioCommand(clip.id, { volume: value ?? 1 }))
            }
          />
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[10px] text-subtle-foreground">
              Fade in (ms)
              <input
                type="number"
                min={0}
                value={clip.fadeInMs}
                onChange={(event) =>
                  execute(
                    createUpdateClipAudioCommand(clip.id, {
                      fadeInMs: Number(event.target.value),
                    }),
                  )
                }
                className="h-7 rounded border border-border bg-surface px-2 text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-subtle-foreground">
              Fade out (ms)
              <input
                type="number"
                min={0}
                value={clip.fadeOutMs}
                onChange={(event) =>
                  execute(
                    createUpdateClipAudioCommand(clip.id, {
                      fadeOutMs: Number(event.target.value),
                    }),
                  )
                }
                className="h-7 rounded border border-border bg-surface px-2 text-foreground"
              />
            </label>
          </div>
        </div>
      ))}
    </div>
  )
}

function formatAudioTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const remainder = Math.floor(ms % 1000)
  return `${seconds}.${remainder.toString().padStart(3, "0")}s`
}
