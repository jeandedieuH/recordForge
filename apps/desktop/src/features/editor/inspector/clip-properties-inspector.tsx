import { useEffect, useState } from "react"
import type { MediaMetadata, TimelineClip, TimelineTrack } from "@recordforge/contracts"
import { createTrimClipCommand, createUpdateTrackCommand } from "@recordforge/editor-core"
import { Sliders, Volume2 } from "lucide-react"
import { Badge, Button, Switch } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { InfoField, TrimField } from "./fields"

interface ClipPropertiesInspectorProps {
  clip: TimelineClip
  track: TimelineTrack
  metadata: MediaMetadata | null
  selectedClipCount?: number
}

export function ClipPropertiesInspector({
  clip,
  track,
  metadata,
  selectedClipCount = 1,
}: ClipPropertiesInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const [sourceInText, setSourceInText] = useState(String(clip.sourceInMs))
  const [sourceOutText, setSourceOutText] = useState(String(clip.sourceOutMs))

  const stream = streamDetails(clip, metadata)
  const streamIndex = "streamIndex" in clip ? clip.streamIndex : undefined

  useEffect(() => {
    setSourceInText(String(clip.sourceInMs))
    setSourceOutText(String(clip.sourceOutMs))
  }, [clip])

  function applyTrim() {
    const sourceInMs = Number.parseInt(sourceInText, 10)
    const sourceOutMs = Number.parseInt(sourceOutText, 10)
    if (Number.isNaN(sourceInMs) || Number.isNaN(sourceOutMs)) return
    execute(
      createTrimClipCommand(
        clip.id,
        sourceInMs,
        sourceOutMs,
        clip.kind === "caption" ? { startMs: sourceInMs } : undefined,
      ),
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Badge
            variant="accent"
            className="w-fit border-border bg-overlay px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            {track.name}
          </Badge>
          {selectedClipCount > 1 ? (
            <Badge variant="outline">{selectedClipCount} selected</Badge>
          ) : null}
        </div>
        <p className="truncate text-sm font-medium text-foreground">{clipLabel(clip, track)}</p>
        <p className="font-mono text-[11px] tabular-nums text-subtle-foreground">
          {formatInspectorTime(clip.startMs)} →{" "}
          {formatInspectorTime(clip.startMs + clip.durationMs)}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
          <Sliders className="size-4 text-primary" aria-hidden />
          <span>Source</span>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <InfoField label="Start" value={formatInspectorTime(clip.startMs)} />
          <InfoField label="Duration" value={formatInspectorTime(clip.durationMs)} />
          <TrimField label="Source in (ms)" value={sourceInText} onChange={setSourceInText} />
          <TrimField label="Source out (ms)" value={sourceOutText} onChange={setSourceOutText} />
          <InfoField label="Stream" value={streamIndex == null ? "Auto" : String(streamIndex)} />
          <InfoField label="Codec" value={stream?.codec ?? "—"} />
        </div>
        <Button variant="secondary" size="sm" onClick={applyTrim}>
          Apply source trim
        </Button>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4 text-xs">
        <div className="flex items-center gap-2 text-subtle-foreground">
          <Volume2 className="size-4" aria-hidden />
          <span>Track muted</span>
        </div>
        <Switch
          checked={track.muted}
          onCheckedChange={(muted) => execute(createUpdateTrackCommand(track.id, { muted }))}
        />
      </div>
    </div>
  )
}

function streamDetails(clip: TimelineClip, metadata: MediaMetadata | null) {
  if (!("streamIndex" in clip) || clip.streamIndex == null) return null
  return metadata?.streams.find((s) => s.index === clip.streamIndex) ?? null
}

function clipLabel(clip: TimelineClip, track: TimelineTrack): string {
  if (clip.kind === "screen") return "Screen capture"
  if (clip.kind === "camera") return "Camera capture"
  if (clip.kind === "caption") return clip.text
  if (clip.kind === "mask") return `${clip.mode} mask`
  return track.name
}

function formatInspectorTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const remainder = Math.floor(ms % 1000)
  return `${seconds}.${remainder.toString().padStart(3, "0")}s`
}
