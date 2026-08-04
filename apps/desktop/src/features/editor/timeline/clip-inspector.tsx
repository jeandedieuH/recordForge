import { useEffect, useState } from "react"
import type {
  ClipTransform,
  MediaMetadata,
  TimelineClip,
  TimelineTrack,
} from "@recordforge/contracts"
import {
  createTrimClipCommand,
  createUpdateClipAudioCommand,
  createUpdateClipTransformCommand,
  createUpdateTrackCommand,
} from "@recordforge/editor-core"
import type { LucideIcon } from "lucide-react"
import {
  AlignLeft,
  AlignRight,
  AudioLines,
  Maximize2,
  Monitor,
  Sliders,
  Sparkles,
  Video,
  Volume2,
} from "lucide-react"
import { Badge, Button, EmptyState, Input, Slider, Switch, cn } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

interface ClipInspectorProps {
  clip: TimelineClip | null
  track: TimelineTrack | null
  metadata: MediaMetadata | null
  onClear: () => void
}

function streamDetails(clip: TimelineClip, metadata: MediaMetadata | null) {
  if (clip.streamIndex == null) return null
  return metadata?.streams.find((stream) => stream.index === clip.streamIndex) ?? null
}

function clipLabel(clip: TimelineClip, track: TimelineTrack): string {
  if (clip.kind === "screen") return "Screen capture"
  if (clip.kind === "camera") return "Camera capture"
  if (clip.kind === "caption") return clip.text
  return track.name
}

export function ClipInspector({ clip, track, metadata, onClear }: ClipInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const [sourceInText, setSourceInText] = useState(clip ? String(clip.sourceInMs) : "")
  const [sourceOutText, setSourceOutText] = useState(clip ? String(clip.sourceOutMs) : "")
  const stream = clip ? streamDetails(clip, metadata) : null

  useEffect(() => {
    if (!clip) return
    setSourceInText(String(clip.sourceInMs))
    setSourceOutText(String(clip.sourceOutMs))
  }, [clip])

  if (!clip || !track) {
    return (
      <aside className="hidden w-80 shrink-0 border-l border-border bg-surface p-4 lg:flex lg:flex-col">
        <EmptyState
          icon={Sliders}
          title="Nothing selected"
          description="Select a clip in the timeline to edit its source, timing, or audio settings."
          className="border-0 px-3 py-10"
        />
      </aside>
    )
  }

  const activeClip = clip
  const isAudio = activeClip.kind === "audio"
  const isCamera = activeClip.kind === "camera"
  const audioVolume = clip.kind === "audio" ? clip.volume : track.volume
  const accentClass = track.name.toLowerCase().includes("system")
    ? "text-track-system"
    : track.kind === "screen"
      ? "text-track-screen"
      : track.kind === "camera"
        ? "text-track-webcam"
        : "text-track-mic"

  function updateAudioVolume(value: number[]) {
    if (!isAudio) return
    execute(createUpdateClipAudioCommand(activeClip.id, { volume: value[0] ?? 1 }))
  }

  function updateTransform(partial: Partial<ClipTransform>) {
    if (activeClip.kind !== "camera") return
    execute(
      createUpdateClipTransformCommand(activeClip.id, {
        ...activeClip.transform,
        ...partial,
      }),
    )
  }

  function applyTrim() {
    const sourceInMs = Number.parseInt(sourceInText, 10)
    const sourceOutMs = Number.parseInt(sourceOutText, 10)
    if (Number.isNaN(sourceInMs) || Number.isNaN(sourceOutMs)) return
    execute(createTrimClipCommand(activeClip.id, sourceInMs, sourceOutMs))
  }

  return (
    <aside className="hidden w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l border-border bg-surface p-4 lg:flex">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-2">
          {isAudio ? (
            <AudioLines className={cn("size-4", accentClass)} />
          ) : isCamera ? (
            <Video className={cn("size-4", accentClass)} />
          ) : (
            <Monitor className={cn("size-4", accentClass)} />
          )}
          <h2 className="truncate text-sm font-semibold text-foreground">Inspector</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <Badge
          variant="accent"
          className="w-fit border-border bg-overlay px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          {track.name}
        </Badge>
        <p className="truncate text-sm font-medium text-foreground">{clipLabel(clip, track)}</p>
        <p className="font-mono text-[11px] tabular-nums text-subtle-foreground">
          {formatInspectorTime(clip.startMs)} →{" "}
          {formatInspectorTime(clip.startMs + clip.durationMs)}
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
          <Sliders className="size-4 text-primary" aria-hidden />
          <span>Source</span>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <InfoField label="Start" value={formatInspectorTime(clip.startMs)} />
          <InfoField label="Duration" value={formatInspectorTime(clip.durationMs)} />
          <TrimField label="Source in (ms)" value={sourceInText} onChange={setSourceInText} />
          <TrimField label="Source out (ms)" value={sourceOutText} onChange={setSourceOutText} />
          <InfoField
            label="Stream"
            value={clip.streamIndex == null ? "Auto" : String(clip.streamIndex)}
          />
          <InfoField label="Codec" value={stream?.codec ?? "—"} />
        </div>
        <Button variant="secondary" size="sm" onClick={applyTrim}>
          Apply source trim
        </Button>
      </div>

      {isAudio ? (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            <Volume2 className="size-4 text-track-mic" aria-hidden />
            <span>Audio</span>
          </div>
          <div className="flex items-center justify-between text-xs text-subtle-foreground">
            <span>Clip volume</span>
            <span className="font-mono tabular-nums text-foreground">
              {Math.round(audioVolume * 100)}%
            </span>
          </div>
          <Slider
            value={[audioVolume]}
            min={0}
            max={2}
            step={0.01}
            aria-label="Clip volume"
            onValueChange={updateAudioVolume}
          />
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            Track mute and volume controls apply independently to {track.name}.
          </p>
        </div>
      ) : null}

      {clip.kind === "camera" ? (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            <Sparkles className="size-4 text-tertiary" aria-hidden />
            <span>Picture in picture</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="X"
              value={clip.transform.x}
              onChange={(value) => updateTransform({ x: value })}
            />
            <NumberField
              label="Y"
              value={clip.transform.y}
              onChange={(value) => updateTransform({ y: value })}
            />
            <NumberField
              label="Width"
              value={clip.transform.width}
              onChange={(value) => updateTransform({ width: value })}
            />
            <NumberField
              label="Height"
              value={clip.transform.height}
              onChange={(value) => updateTransform({ height: value })}
            />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-subtle-foreground">Opacity</span>
            <span className="font-mono tabular-nums">
              {Math.round(clip.transform.opacity * 100)}%
            </span>
          </div>
          <Slider
            value={[clip.transform.opacity]}
            min={0}
            max={1}
            step={0.05}
            aria-label="Camera opacity"
            onValueChange={(value) => updateTransform({ opacity: value[0] ?? 1 })}
          />
          <div className="grid grid-cols-3 gap-2">
            <PresetButton
              active={clip.transform.x < 100}
              label="Left"
              onClick={() => updateTransform({ x: 24, y: 24 })}
              icon={AlignLeft}
            />
            <PresetButton
              active={clip.transform.x > 100}
              label="Right"
              onClick={() =>
                updateTransform({
                  x: Math.max(24, (metadata?.width ?? 1920) - clip.transform.width - 24),
                  y: Math.max(24, (metadata?.height ?? 1080) - clip.transform.height - 24),
                })
              }
              icon={AlignRight}
            />
            <PresetButton
              active={clip.transform.width >= (metadata?.width ?? 1920) * 0.9}
              label="Full"
              onClick={() =>
                updateTransform({
                  x: 0,
                  y: 0,
                  width: metadata?.width ?? 1920,
                  height: metadata?.height ?? 1080,
                })
              }
              icon={Maximize2}
            />
          </div>
        </div>
      ) : null}

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
    </aside>
  )
}

function formatInspectorTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function TrimField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex flex-col gap-1 rounded-md bg-surface-dim px-2 py-1.5 text-[10px] uppercase tracking-wider text-subtle-foreground">
      <span>{label}</span>
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 border-0 bg-transparent p-0 font-mono text-xs normal-case tracking-normal text-foreground shadow-none"
      />
    </label>
  )
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-surface-dim px-2 py-1.5">
      <span className="text-[10px] uppercase tracking-wider text-subtle-foreground">{label}</span>
      <span className="truncate font-mono tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-subtle-foreground">
      <span>{label}</span>
      <Input
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function PresetButton({
  active,
  label,
  onClick,
  icon: Icon,
}: {
  active: boolean
  label: string
  onClick: () => void
  icon: LucideIcon
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className="flex-col gap-1"
      onClick={onClick}
    >
      <Icon />
      <span className="text-[10px]">{label}</span>
    </Button>
  )
}
