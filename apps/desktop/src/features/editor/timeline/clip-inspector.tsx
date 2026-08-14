import { useEffect, useState } from "react"
import {
  cursorSettingsForEffect,
  generateSmartZoomSuggestions,
  getCursorPointAtTimelineTime,
  zoomTargetForCursorPoint,
} from "@recordforge/cursor-core"
import type {
  ClipTransform,
  CursorSettings,
  CursorTelemetryFile,
  MediaMetadata,
  ManualZoomSegment,
  TimelineClip,
  TimelineMarker,
  TimelineState,
  TimelineTrack,
} from "@recordforge/contracts"
import {
  createAddCursorRangeCommand,
  createAddZoomSegmentCommand,
  createSplitZoomSegmentCommand,
  createDeleteCursorRangeCommand,
  createDeleteZoomSegmentCommand,
  createRegenerateZoomSuggestionsCommand,
  createDeleteMarkerCommand,
  createUpdateCursorRangeCommand,
  createUpdateZoomSegmentCommand,
  createUpdateMarkerCommand,
  createTrimClipCommand,
  createUpdateClipAudioCommand,
  createUpdateMaskClipCommand,
  createUpdateCanvasCommand,
  createUpdateCursorSettingsCommand,
  createUpdateSmartZoomSettingsCommand,
  createUpdateTrackCommand,
  getTotalDuration,
} from "@recordforge/editor-core"
import type { LucideIcon } from "lucide-react"
import {
  AlignLeft,
  AlignRight,
  Flag as FlagIcon,
  Maximize2,
  Monitor,
  MousePointer2,
  Sliders,
  Sparkles,
  Volume2,
} from "lucide-react"
import { Badge, Button, Input, NativeSelect, Slider, Switch, Textarea } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useTimelineInteraction } from "./use-timeline-interaction"
import { CursorInspector } from "../cursor"

interface ClipInspectorProps {
  clip: TimelineClip | null
  track: TimelineTrack | null
  marker: TimelineMarker | null
  metadata: MediaMetadata | null
  selectedClipCount?: number
  onClear: () => void
}

function streamDetails(clip: TimelineClip, metadata: MediaMetadata | null) {
  if (!("streamIndex" in clip) || clip.streamIndex == null) return null
  return metadata?.streams.find((stream) => stream.index === clip.streamIndex) ?? null
}

function clipLabel(clip: TimelineClip, track: TimelineTrack): string {
  if (clip.kind === "screen") return "Screen capture"
  if (clip.kind === "camera") return "Camera capture"
  if (clip.kind === "caption") return clip.text
  return track.name
}

function formatInspectorTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const remainder = Math.floor(ms % 1000)
  return `${seconds}.${remainder.toString().padStart(3, "0")}s`
}

export function ClipInspector({
  clip,
  track,
  marker,
  metadata,
  selectedClipCount = 1,
  onClear,
}: ClipInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const interaction = useTimelineInteraction()
  const project = useTimelineStore((state) => state.project)
  const view = useTimelineStore((state) => state.view)
  const timelineState = useTimelineStore((state) => state.engine?.history.present)
  const cursorTelemetry = useTimelineStore((state) => state.cursorTelemetry)
  const cursorTelemetryStatus = useTimelineStore((state) => state.cursorTelemetryStatus)
  const cursorSettings = timelineState?.canvas.cursorSettings
  const cursorAssetId = project?.assets.find((asset) => asset.role === "cursor_events")?.id
  const selectedRange = view.selection?.kind === "range" ? view.selection : null
  const cursorRange = clip?.kind === "cursor-effect" ? clip : null
  const cursorRangeSettings = cursorSettingsForEffect(cursorSettings, cursorRange)
  const selectedZoomId = view.selection?.kind === "zoom" ? view.selection.segmentId : null
  const selectedZoom =
    timelineState?.zoomSegments?.find((segment) => segment.id === selectedZoomId) ?? null

  const [activeTab, setActiveTab] = useState<"clip" | "cursor">("cursor")
  const [sourceInText, setSourceInText] = useState(clip ? String(clip.sourceInMs) : "")
  const [sourceOutText, setSourceOutText] = useState(clip ? String(clip.sourceOutMs) : "")
  const [markerLabel, setMarkerLabel] = useState(marker?.label ?? "")
  const [markerTimeText, setMarkerTimeText] = useState(marker ? String(marker.timeMs) : "")
  const stream = clip ? streamDetails(clip, metadata) : null

  useEffect(() => {
    if (!clip) {
      setActiveTab("cursor")
      return
    }
    setActiveTab(clip.kind === "cursor-effect" ? "cursor" : "clip")
    setSourceInText(String(clip.sourceInMs))
    setSourceOutText(String(clip.sourceOutMs))
  }, [clip])

  useEffect(() => {
    setMarkerLabel(marker?.label ?? "")
    setMarkerTimeText(marker ? String(marker.timeMs) : "")
  }, [marker])

  function handleCursorChange(updated: Partial<CursorSettings>) {
    if (cursorRange) {
      execute(
        createUpdateCursorRangeCommand(cursorRange.id, {
          enabled: updated.enabled,
          presetId: updated.preset,
          scale: updated.scale,
          smoothing:
            updated.smoothMovement === undefined
              ? undefined
              : updated.smoothMovement
                ? "smooth"
                : "off",
          settings: updated,
        }),
      )
      return
    }
    execute(createUpdateCursorSettingsCommand(updated))
  }

  function addCursorRange() {
    if (!cursorAssetId || !timelineState) return
    const startMs = selectedRange?.startMs ?? 0
    const endMs = selectedRange?.endMs ?? Math.max(1, getTotalDuration(timelineState))
    execute(
      createAddCursorRangeCommand(cursorAssetId, startMs, endMs, {
        presetId: cursorSettings?.preset,
        scale: cursorSettings?.scale,
        settings: cursorSettings,
      }),
    )
  }

  function regenerateSmartZoom() {
    if (!timelineState || !cursorTelemetry || cursorTelemetryStatus !== "available") return
    const suggestions = generateSmartZoomSuggestions(cursorTelemetry, timelineState.canvas, {
      ...(timelineState.smartZoomSettings ?? {}),
      durationMs: getTotalDuration(timelineState),
    })
    execute(createRegenerateZoomSuggestionsCommand(suggestions))
  }

  if (marker) {
    return (
      <aside className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface p-4 lg:flex">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FlagIcon className="size-4 text-primary" aria-hidden />
            <span>Marker</span>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClear}>
            Clear
          </Button>
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-dim p-3">
            <Input
              aria-label="Marker label"
              value={markerLabel}
              onChange={(event) => setMarkerLabel(event.target.value)}
              onBlur={() => execute(createUpdateMarkerCommand(marker.id, { label: markerLabel }))}
            />
            <Input
              aria-label="Marker time in milliseconds"
              type="number"
              min={0}
              value={markerTimeText}
              onChange={(event) => setMarkerTimeText(event.target.value)}
              onBlur={() => {
                const timeMs = Number.parseInt(markerTimeText, 10)
                if (Number.isFinite(timeMs) && timeMs >= 0) {
                  execute(createUpdateMarkerCommand(marker.id, { timeMs }))
                }
              }}
            />
            <p className="font-mono text-xs tabular-nums text-subtle-foreground">
              {formatInspectorTime(marker.timeMs)}
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              execute(createDeleteMarkerCommand(marker.id))
              onClear()
            }}
          >
            Delete marker
          </Button>
        </div>
      </aside>
    )
  }

  if (!clip || !track) {
    return (
      <aside className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface p-4 lg:flex">
        <div className="flex flex-col gap-3 border-b border-border pb-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Monitor className="size-4 text-primary" aria-hidden />
            <span>Canvas</span>
          </div>
          {timelineState ? (
            <div className="grid grid-cols-2 gap-2">
              <InfoField label="Width" value={`${timelineState.canvas.width}px`} />
              <InfoField label="Height" value={`${timelineState.canvas.height}px`} />
              <InfoField label="Frame rate" value={`${timelineState.canvas.fps} fps`} />
              <InfoField label="Background" value={timelineState.canvas.background} />
            </div>
          ) : (
            <p className="text-xs text-subtle-foreground">
              Select a project to inspect its canvas.
            </p>
          )}
          {timelineState ? (
            <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="Width"
                  value={timelineState.canvas.width}
                  onChange={(value) => execute(createUpdateCanvasCommand({ width: value }))}
                />
                <NumberField
                  label="Height"
                  value={timelineState.canvas.height}
                  onChange={(value) => execute(createUpdateCanvasCommand({ height: value }))}
                />
                <NumberField
                  label="Padding"
                  value={timelineState.canvas.padding}
                  onChange={(value) => execute(createUpdateCanvasCommand({ padding: value }))}
                />
                <NumberField
                  label="Corner radius"
                  value={timelineState.canvas.borderRadius}
                  onChange={(value) => execute(createUpdateCanvasCommand({ borderRadius: value }))}
                />
              </div>
              <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                <span>Aspect ratio</span>
                <select
                  aria-label="Canvas aspect ratio"
                  value={timelineState.canvas.aspectRatio ?? "custom"}
                  onChange={(event) =>
                    execute(
                      createUpdateCanvasCommand({
                        aspectRatio: event.target.value as "16:9" | "1:1" | "9:16" | "custom",
                      }),
                    )
                  }
                  className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground"
                >
                  <option value="16:9">16:9</option>
                  <option value="1:1">1:1</option>
                  <option value="9:16">9:16</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                <span>Background</span>
                <Input
                  aria-label="Canvas background"
                  type="color"
                  value={timelineState.canvas.background}
                  onChange={(event) =>
                    execute(createUpdateCanvasCommand({ background: event.target.value }))
                  }
                  className="h-8 w-12 p-1"
                />
              </label>
              <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                <span>Canvas shadow</span>
                <Switch
                  checked={timelineState.canvas.shadow}
                  onCheckedChange={(shadow) => execute(createUpdateCanvasCommand({ shadow }))}
                />
              </label>
            </div>
          ) : null}
        </div>
        <ZoomInspector
          timelineState={timelineState}
          cursorTelemetry={cursorTelemetry}
          segments={timelineState?.zoomSegments ?? []}
          selectedSegment={selectedZoom}
          timelineDuration={timelineState ? getTotalDuration(timelineState) : 0}
          playheadMs={view.playheadMs}
          telemetryStatus={cursorTelemetryStatus}
          smartZoomPreset={timelineState?.smartZoomSettings?.preset ?? "product-demo"}
          onRegenerate={regenerateSmartZoom}
          onPresetChange={(preset) => execute(createUpdateSmartZoomSettingsCommand({ preset }))}
          onSelect={(segmentId) =>
            useTimelineStore.getState().setSelection({ kind: "zoom", segmentId })
          }
          onAdd={(startMs, endMs, target) => {
            const segmentId = crypto.randomUUID()
            execute(
              createAddZoomSegmentCommand(startMs, endMs, target, {
                segmentId,
                scale: 1,
                easing: "smooth",
                mode: "follow-cursor",
                source: "manual",
                preset: timelineState?.smartZoomSettings?.preset ?? "product-demo",
              }),
            )
            useTimelineStore.getState().setSelection({ kind: "zoom", segmentId })
          }}
          onUpdate={(segmentId, update) =>
            interaction.updateZoomTarget(segmentId, update, { phase: "commit" })
          }
          onSplit={(segmentId, splitTimeMs) =>
            execute(createSplitZoomSegmentCommand(segmentId, splitTimeMs))
          }
          onDelete={(segmentId) => {
            execute(createDeleteZoomSegmentCommand(segmentId))
            onClear()
          }}
        />
        <CursorInspector
          settings={cursorSettings}
          onChange={handleCursorChange}
          presetsEnabled={false}
        />
        {cursorAssetId ? (
          <Button variant="secondary" size="sm" onClick={addCursorRange}>
            {selectedRange ? "Add selected cursor range" : "Add full-duration cursor range"}
          </Button>
        ) : null}
      </aside>
    )
  }

  const activeClip = clip
  const isAudio = activeClip.kind === "audio"
  const streamIndex = "streamIndex" in activeClip ? activeClip.streamIndex : undefined
  const audioVolume = clip.kind === "audio" ? clip.volume : track.volume

  function updateAudioVolume(value: number[]) {
    if (!isAudio) return
    execute(createUpdateClipAudioCommand(activeClip.id, { volume: value[0] ?? 1 }))
  }

  function updateTransform(partial: Partial<ClipTransform>) {
    if (activeClip.kind !== "camera") return
    interaction.updateClipTransform(
      activeClip.id,
      { ...activeClip.transform, ...partial },
      { phase: "commit" },
    )
  }

  function applyTrim() {
    const sourceInMs = Number.parseInt(sourceInText, 10)
    const sourceOutMs = Number.parseInt(sourceOutText, 10)
    if (Number.isNaN(sourceInMs) || Number.isNaN(sourceOutMs)) return
    execute(
      createTrimClipCommand(
        activeClip.id,
        sourceInMs,
        sourceOutMs,
        activeClip.kind === "caption" ? { startMs: sourceInMs } : undefined,
      ),
    )
  }

  function updateMask(partial: Parameters<typeof createUpdateMaskClipCommand>[1]) {
    if (activeClip.kind !== "mask") return
    interaction.updateMask(activeClip.id, partial, { phase: "commit" })
  }

  return (
    <aside className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface p-4 lg:flex">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-1 rounded-lg bg-surface-dim p-1">
          <Button
            variant={activeTab === "clip" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setActiveTab("clip")}
          >
            Clip Properties
          </Button>
          <Button
            variant={activeTab === "cursor" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => setActiveTab("cursor")}
          >
            <MousePointer2 className="size-3.5" />
            Cursor
          </Button>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} className="h-7 text-xs">
          Clear
        </Button>
      </div>

      {activeTab === "cursor" ? (
        <div className="flex flex-col gap-3">
          <CursorInspector
            settings={cursorRangeSettings}
            onChange={handleCursorChange}
            presetsEnabled={false}
          />
          {cursorRange ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  execute(
                    createUpdateCursorRangeCommand(cursorRange.id, {
                      locked: !cursorRange.locked,
                    }),
                  )
                }
              >
                {cursorRange.locked ? "Unlock range" : "Lock range"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={cursorRange.locked}
                onClick={() => {
                  execute(createDeleteCursorRangeCommand(cursorRange.id))
                  onClear()
                }}
              >
                Delete range
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
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

          {activeClip.kind !== "cursor-effect" ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
                <Sliders className="size-4 text-primary" aria-hidden />
                <span>Source</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <InfoField label="Start" value={formatInspectorTime(clip.startMs)} />
                <InfoField label="Duration" value={formatInspectorTime(clip.durationMs)} />
                <TrimField label="Source in (ms)" value={sourceInText} onChange={setSourceInText} />
                <TrimField
                  label="Source out (ms)"
                  value={sourceOutText}
                  onChange={setSourceOutText}
                />
                <InfoField
                  label="Stream"
                  value={streamIndex == null ? "Auto" : String(streamIndex)}
                />
                <InfoField label="Codec" value={stream?.codec ?? "—"} />
              </div>
              <Button variant="secondary" size="sm" onClick={applyTrim}>
                Apply source trim
              </Button>
            </div>
          ) : null}

          {activeClip.kind === "caption" ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
                <Sparkles className="size-4 text-primary" aria-hidden />
                <span>Caption</span>
              </div>
              <Textarea
                aria-label="Caption text"
                value={activeClip.text}
                rows={3}
                onChange={(event) =>
                  interaction.updateCaption(
                    activeClip.id,
                    { text: event.target.value },
                    { phase: "commit" },
                  )
                }
              />
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
                  Style
                  <NativeSelect
                    aria-label="Caption style"
                    value={activeClip.style}
                    onChange={(event) =>
                      interaction.updateCaption(
                        activeClip.id,
                        { style: event.target.value as typeof activeClip.style },
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
                    value={activeClip.placement ?? "bottom"}
                    onChange={(event) =>
                      interaction.updateCaption(
                        activeClip.id,
                        {
                          placement: event.target.value as NonNullable<typeof activeClip.placement>,
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
              <p className="text-[11px] leading-relaxed text-subtle-foreground">
                Edit start and end in the source fields above; caption timing remains
                non-destructive.
              </p>
            </div>
          ) : null}

          {activeClip.kind === "mask" ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
                <Sparkles className="size-4 text-primary" aria-hidden />
                <span>Privacy mask</span>
              </div>
              <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
                Mode
                <NativeSelect
                  aria-label="Mask mode"
                  value={activeClip.mode}
                  onChange={(event) =>
                    updateMask({ mode: event.target.value as typeof activeClip.mode })
                  }
                >
                  <option value="blur">Blur</option>
                  <option value="pixelate">Pixelate</option>
                  <option value="redact">Redact</option>
                </NativeSelect>
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(["x", "y", "width", "height"] as const).map((field) => (
                  <NumberField
                    key={field}
                    label={field}
                    value={activeClip.rect[field]}
                    onChange={(value) => updateMask({ rect: { [field]: value } })}
                  />
                ))}
              </div>
              {activeClip.mode === "blur" ? (
                <NumberField
                  label="Blur radius"
                  value={activeClip.blurRadius}
                  onChange={(value) => updateMask({ blurRadius: value })}
                />
              ) : null}
              {activeClip.mode === "pixelate" ? (
                <NumberField
                  label="Pixel size"
                  value={activeClip.pixelSize}
                  onChange={(value) => updateMask({ pixelSize: Math.round(value) })}
                />
              ) : null}
              <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                <span>Enabled in preview and export</span>
                <Switch
                  checked={activeClip.enabled}
                  onCheckedChange={(enabled) => updateMask({ enabled })}
                />
              </label>
            </div>
          ) : null}

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
              {activeClip.kind === "audio" ? (
                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    label="Fade in (ms)"
                    value={activeClip.fadeInMs}
                    onChange={(value) =>
                      execute(createUpdateClipAudioCommand(activeClip.id, { fadeInMs: value }))
                    }
                  />
                  <NumberField
                    label="Fade out (ms)"
                    value={activeClip.fadeOutMs}
                    onChange={(value) =>
                      execute(createUpdateClipAudioCommand(activeClip.id, { fadeOutMs: value }))
                    }
                  />
                </div>
              ) : null}
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
              <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                <span>Show camera</span>
                <Switch
                  checked={clip.transform.visible !== false}
                  onCheckedChange={(visible) => updateTransform({ visible })}
                />
              </label>
              <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                <span>Shape</span>
                <select
                  aria-label="Camera shape"
                  value={clip.transform.shape}
                  onChange={(event) =>
                    updateTransform({
                      shape: event.target.value as ClipTransform["shape"],
                    })
                  }
                  className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground"
                >
                  <option value="rectangle">Rectangle</option>
                  <option value="rounded">Rounded</option>
                  <option value="circle">Circle</option>
                </select>
              </label>
              <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-dim p-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-subtle-foreground">
                  Crop (source pixels)
                </span>
                <div className="grid grid-cols-2 gap-2">
                  {(["x", "y", "width", "height"] as const).map((field) => (
                    <NumberField
                      key={field}
                      label={field}
                      value={clip.transform.crop?.[field] ?? 0}
                      onChange={(value) =>
                        updateTransform({
                          crop: {
                            x: clip.transform.crop?.x ?? 0,
                            y: clip.transform.crop?.y ?? 0,
                            width: clip.transform.crop?.width ?? metadata?.width ?? 1,
                            height: clip.transform.crop?.height ?? metadata?.height ?? 1,
                            [field]: value,
                          },
                        })
                      }
                    />
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="Border width"
                  value={clip.transform.borderWidth ?? 0}
                  onChange={(value) => updateTransform({ borderWidth: value })}
                />
                <NumberField
                  label="Border opacity"
                  value={clip.transform.borderOpacity ?? 1}
                  onChange={(value) => updateTransform({ borderOpacity: value })}
                />
                <NumberField
                  label="Shadow blur"
                  value={clip.transform.shadowBlur ?? 0}
                  onChange={(value) =>
                    updateTransform({ shadowBlur: value, shadowEnabled: value > 0 })
                  }
                />
                <NumberField
                  label="Shadow X"
                  value={clip.transform.shadowOffsetX ?? 0}
                  onChange={(value) => updateTransform({ shadowOffsetX: value })}
                />
                <NumberField
                  label="Shadow Y"
                  value={clip.transform.shadowOffsetY ?? 0}
                  onChange={(value) => updateTransform({ shadowOffsetY: value })}
                />
              </div>
              <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                <span>Border color</span>
                <Input
                  aria-label="Camera border color"
                  type="color"
                  value={clip.transform.borderColor ?? "#ffffff"}
                  onChange={(event) => updateTransform({ borderColor: event.target.value })}
                  className="h-8 w-12 p-1"
                />
              </label>
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
        </div>
      )}
    </aside>
  )
}

// Manual zoom ranges share the same command engine as media edits, so every
// inspector change is undoable and the persisted project stays authoritative.
function ZoomInspector({
  timelineState,
  cursorTelemetry,
  segments,
  selectedSegment,
  timelineDuration,
  playheadMs,
  onSelect,
  onAdd,
  onUpdate,
  onSplit,
  onDelete,
  telemetryStatus,
  smartZoomPreset,
  onRegenerate,
  onPresetChange,
}: {
  timelineState: TimelineState | null | undefined
  cursorTelemetry: CursorTelemetryFile | null | undefined
  segments: ManualZoomSegment[]
  selectedSegment: ManualZoomSegment | null
  timelineDuration: number
  playheadMs: number
  telemetryStatus: "loading" | "available" | "unavailable"
  smartZoomPreset: NonNullable<ManualZoomSegment["preset"]>
  onSelect: (segmentId: string) => void
  onAdd: (startMs: number, endMs: number, target: ManualZoomSegment["target"]) => void
  onUpdate: (
    segmentId: string,
    update: Parameters<typeof createUpdateZoomSegmentCommand>[1],
  ) => void
  onSplit: (segmentId: string, splitTimeMs: number) => void
  onDelete: (segmentId: string) => void
  onRegenerate: () => void
  onPresetChange: (preset: NonNullable<ManualZoomSegment["preset"]>) => void
}) {
  const defaultEnd = Math.min(timelineDuration || playheadMs + 1_500, playheadMs + 1_500)
  return (
    <div className="flex flex-col gap-3 border-b border-border pb-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
          Zoom
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 text-[10px]"
          disabled={defaultEnd <= playheadMs}
          onClick={() => {
            const cursorPoint = getCursorPointAtTimelineTime(
              timelineState,
              playheadMs,
              cursorTelemetry,
            )
            const centerPoint = cursorPoint ?? {
              x: (timelineState?.canvas.width ?? 1920) / 2,
              y: (timelineState?.canvas.height ?? 1080) / 2,
            }
            const targetScale =
              smartZoomPreset === "subtle" ? 1.25 : smartZoomPreset === "cinematic" ? 1.8 : 1.5
            const target = zoomTargetForCursorPoint(
              centerPoint,
              timelineState?.canvas ?? { width: 1920, height: 1080, padding: 0 },
              targetScale,
              timelineState?.canvas.padding ?? 0,
            )
            onAdd(playheadMs, defaultEnd, target)
          }}
        >
          Add manual
        </Button>
      </div>
      <div className="rounded-md border border-border bg-surface-dim p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-foreground">Smart suggestions</span>
          <select
            aria-label="Smart zoom preset"
            value={smartZoomPreset}
            onChange={(event) =>
              onPresetChange(event.target.value as NonNullable<ManualZoomSegment["preset"]>)
            }
            className="h-7 rounded border border-border bg-surface px-1 text-[11px] text-foreground"
          >
            <option value="subtle">Subtle</option>
            <option value="product-demo">Product demo</option>
            <option value="cinematic">Cinematic</option>
            <option value="manual-only">Manual only</option>
          </select>
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-subtle-foreground">
          Suggestions focus on clicks and sustained cursor attention. Manual and locked ranges are
          preserved when regenerated.
        </p>
        {telemetryStatus === "unavailable" ? (
          <p
            className="mt-2 rounded border border-warning/30 bg-warning/10 px-2 py-1.5 text-[10px] text-warning"
            role="status"
          >
            Smart zoom unavailable: this project has no usable cursor telemetry.
          </p>
        ) : null}
        {telemetryStatus === "loading" ? (
          <p className="mt-2 text-[10px] text-subtle-foreground" role="status" aria-live="polite">
            Checking cursor telemetry…
          </p>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-7 w-full text-[10px]"
          disabled={telemetryStatus !== "available" || smartZoomPreset === "manual-only"}
          onClick={onRegenerate}
        >
          Regenerate suggestions
        </Button>
      </div>
      {segments.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          Add a manual range or generate suggestions from cursor activity. Targets are clamped to
          the canvas before preview and export.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {segments.map((segment) => (
            <button
              key={segment.id}
              type="button"
              className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-left text-[11px] ${
                selectedSegment?.id === segment.id
                  ? "border-primary/60 bg-primary/10"
                  : "border-border bg-surface-dim"
              }`}
              onClick={() => onSelect(segment.id)}
            >
              <span className="min-w-0 truncate">
                {formatInspectorTime(segment.startMs)} →{" "}
                {formatInspectorTime(segment.startMs + segment.durationMs)}
                <span className="ml-1 text-[10px] text-subtle-foreground">
                  {segment.mode ?? "manual"} · {segment.source ?? "manual"}
                </span>
              </span>
              <span className="shrink-0 font-mono text-subtle-foreground">
                {segment.scale.toFixed(1)}×
              </span>
            </button>
          ))}
        </div>
      )}
      {selectedSegment ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-dim p-2">
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Target X"
              value={selectedSegment.target.x}
              onChange={(value) => onUpdate(selectedSegment.id, { target: { x: value } })}
            />
            <NumberField
              label="Target Y"
              value={selectedSegment.target.y}
              onChange={(value) => onUpdate(selectedSegment.id, { target: { y: value } })}
            />
            <NumberField
              label="Target width"
              value={selectedSegment.target.width}
              onChange={(value) => onUpdate(selectedSegment.id, { target: { width: value } })}
            />
            <NumberField
              label="Target height"
              value={selectedSegment.target.height}
              onChange={(value) => onUpdate(selectedSegment.id, { target: { height: value } })}
            />
            <NumberField
              label="Start (ms)"
              value={selectedSegment.startMs}
              onChange={(value) => onUpdate(selectedSegment.id, { startMs: value })}
            />
            <NumberField
              label="End (ms)"
              value={selectedSegment.startMs + selectedSegment.durationMs}
              onChange={(value) => onUpdate(selectedSegment.id, { endMs: value })}
            />
            <NumberField
              label="Scale"
              value={selectedSegment.scale}
              onChange={(value) => onUpdate(selectedSegment.id, { scale: value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
              <span>Mode</span>
              <select
                aria-label="Zoom mode"
                value={selectedSegment.mode ?? "follow-cursor"}
                onChange={(event) =>
                  onUpdate(selectedSegment.id, {
                    mode: event.target.value as ManualZoomSegment["mode"],
                  })
                }
                className="h-7 rounded border border-border bg-surface px-1 text-[11px] text-foreground"
              >
                <option value="follow-cursor">Follow cursor</option>
                <option value="auto">Auto tracking</option>
                <option value="manual">Fixed frame</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
              <span>Easing</span>
              <select
                aria-label="Zoom easing"
                value={selectedSegment.easing}
                onChange={(event) =>
                  onUpdate(selectedSegment.id, {
                    easing: event.target.value as ManualZoomSegment["easing"],
                  })
                }
                className="h-7 rounded border border-border bg-surface px-1 text-[11px] text-foreground"
              >
                <option value="smooth">Smooth</option>
                <option value="cinematic">Cinematic</option>
                <option value="ease-in-out">Ease in/out</option>
                <option value="snappy">Snappy</option>
                <option value="ease-in">Ease in</option>
                <option value="ease-out">Ease out</option>
                <option value="linear">Linear</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px]"
              disabled={selectedSegment.locked}
              onClick={() =>
                onSplit(
                  selectedSegment.id,
                  selectedSegment.startMs + Math.floor(selectedSegment.durationMs / 2),
                )
              }
            >
              Split
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px]"
              onClick={() => onUpdate(selectedSegment.id, { locked: !selectedSegment.locked })}
            >
              {selectedSegment.locked ? "Unlock" : "Lock"}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-[10px]"
              disabled={selectedSegment.locked}
              onClick={() => onDelete(selectedSegment.id)}
            >
              Delete
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
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
