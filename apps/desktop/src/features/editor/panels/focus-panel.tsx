import { useMemo, useState } from "react"
import type { ManualZoomSegment, ZoomPreset } from "@recordforge/contracts"
import { zoomSegmentBadges } from "@recordforge/cursor-core"
import {
  createAddZoomSegmentCommand,
  createDeleteZoomSegmentCommand,
  createRegenerateZoomSuggestionsCommand,
  createSplitZoomSegmentCommand,
  createUpdateSmartZoomSettingsCommand,
  createUpdateZoomSegmentCommand,
  generateSmartZoomSuggestions,
  getManualZoomSegments,
  getTotalDuration,
} from "@recordforge/editor-core"
import { Check, Maximize2, Sparkles, X, ZoomIn } from "lucide-react"
import { Badge, Button, NativeSelect } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

function badgeVariant(
  variant: "default" | "secondary" | "outline" | "warning",
): "default" | "accent" | "outline" | "warning" {
  if (variant === "secondary") return "outline"
  if (variant === "default") return "accent"
  return variant
}

export function FocusPanel() {
  const execute = useTimelineStore((state) => state.execute)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const view = useTimelineStore((state) => state.view)
  const cursorTelemetry = useTimelineStore((state) => state.cursorTelemetry)
  const cursorTelemetryStatus = useTimelineStore((state) => state.cursorTelemetryStatus)

  const playheadMs = view.playheadMs
  const segments = useMemo(() => (timeline ? getManualZoomSegments(timeline) : []), [timeline])
  const selectedId = view.selection?.kind === "zoom" ? view.selection.segmentId : null
  const selectedSegment = segments.find((segment) => segment.id === selectedId) ?? null

  const smartZoomPreset = timeline?.smartZoomSettings?.preset ?? "product-demo"

  const [preset, setPreset] = useState<ZoomPreset>(smartZoomPreset)
  const [reviewing, setReviewing] = useState<ManualZoomSegment[] | null>(null)

  const timelineDuration = timeline ? getTotalDuration(timeline) : 0

  function onPresetChange(next: ZoomPreset) {
    setPreset(next)
    if (!timeline) return
    execute(createUpdateSmartZoomSettingsCommand({ preset: next }))
  }

  function addManual() {
    if (!timeline) return
    const startMs = playheadMs
    const defaultEnd = Math.min(timelineDuration || startMs + 1_000, startMs + 1_000)
    if (defaultEnd <= startMs) return
    const segmentId = crypto.randomUUID()
    const rect = {
      x: 0,
      y: 0,
      width: 640,
      height: 360,
    }
    execute(
      createAddZoomSegmentCommand(startMs, defaultEnd, rect, {
        segmentId,
        scale: 1.5,
        easing: "ease-in-out",
        mode: "manual",
        source: "manual",
        preset,
      }),
    )
    setSelection({ kind: "zoom", segmentId })
  }

  function generateSuggestions() {
    if (!timeline || !cursorTelemetry || cursorTelemetryStatus !== "available") return []
    return generateSmartZoomSuggestions(cursorTelemetry, timeline.canvas, {
      ...(timeline.smartZoomSettings ?? {}),
      durationMs: getTotalDuration(timeline),
    })
  }

  function startReview() {
    const suggestions = generateSuggestions()
    if (suggestions.length === 0) return
    setReviewing(suggestions)
  }

  function acceptSuggestions() {
    if (!reviewing) return
    execute(createRegenerateZoomSuggestionsCommand(reviewing))
    setReviewing(null)
  }

  function rejectSuggestions() {
    setReviewing(null)
  }

  function selectSegment(segment: ManualZoomSegment) {
    setSelection({ kind: "zoom", segmentId: segment.id })
  }

  function splitSegment(segment: ManualZoomSegment) {
    const splitTimeMs = segment.startMs + Math.floor(segment.durationMs / 2)
    execute(createSplitZoomSegmentCommand(segment.id, splitTimeMs))
  }

  function deleteSegment(segment: ManualZoomSegment) {
    execute(createDeleteZoomSegmentCommand(segment.id))
    if (selectedId === segment.id) setSelection(null)
  }

  function toggleLock(segment: ManualZoomSegment) {
    execute(createUpdateZoomSegmentCommand(segment.id, { locked: !segment.locked }))
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
        <ZoomIn className="size-4 text-primary" aria-hidden />
        <h2>Focus</h2>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-foreground">Smart zoom</span>
          <NativeSelect
            aria-label="Smart zoom preset"
            value={preset}
            onChange={(event) => onPresetChange(event.target.value as ZoomPreset)}
            className="w-32"
          >
            <option value="subtle">Subtle</option>
            <option value="product-demo">Product demo</option>
            <option value="cinematic">Cinematic</option>
            <option value="manual-only">Manual only</option>
          </NativeSelect>
        </div>
        <p className="text-[10px] leading-relaxed text-subtle-foreground">
          Suggestions focus on clicks and sustained cursor attention. Manual and locked ranges are
          preserved.
        </p>
        {cursorTelemetryStatus === "unavailable" ? (
          <p
            className="mt-1 rounded border border-warning/30 bg-warning/10 px-2 py-1.5 text-[10px] text-warning"
            role="status"
          >
            Smart zoom unavailable: no usable cursor telemetry.
          </p>
        ) : null}
        {cursorTelemetryStatus === "loading" ? (
          <p className="mt-1 text-[10px] text-subtle-foreground" role="status" aria-live="polite">
            Checking cursor telemetry…
          </p>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-full text-[10px]"
          disabled={cursorTelemetryStatus !== "available" || preset === "manual-only"}
          onClick={startReview}
        >
          <Sparkles data-icon="inline-start" />
          Review suggestions
        </Button>
      </div>

      {reviewing ? (
        <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">
              Review {reviewing.length} suggestion{reviewing.length === 1 ? "" : "s"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={rejectSuggestions}
            >
              <X data-icon="inline-start" />
              Cancel
            </Button>
          </div>
          <p className="text-[10px] text-subtle-foreground">
            Locked or manual segments are preserved. Overlapping suggestions are merged on accept.
          </p>
          <div className="flex max-h-48 flex-col gap-1.5 overflow-auto">
            {reviewing.map((segment) => {
              const badges = zoomSegmentBadges(segment)
              return (
                <div
                  key={segment.id}
                  className="flex flex-col gap-1 rounded-md border border-border bg-surface-dim p-2 text-[10px]"
                >
                  <div className="flex items-center justify-between">
                    <span>
                      {formatZoomTime(segment.startMs)} →{" "}
                      {formatZoomTime(segment.startMs + segment.durationMs)}
                    </span>
                    <span className="font-mono tabular-nums">{segment.scale.toFixed(1)}×</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {badges.map((badge) => (
                      <Badge
                        key={badge.key}
                        variant={badgeVariant(badge.variant)}
                        className="text-[9px]"
                      >
                        {badge.label}
                      </Badge>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="h-7 text-[10px]"
            onClick={acceptSuggestions}
          >
            <Check data-icon="inline-start" />
            Accept all suggestions
          </Button>
        </div>
      ) : null}

      <Button
        variant="secondary"
        size="sm"
        className="h-8 text-xs"
        disabled={!timeline}
        onClick={addManual}
      >
        <Maximize2 data-icon="inline-start" />
        Add manual zoom
      </Button>

      {segments.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          Add a manual range or generate suggestions from cursor activity. Targets are clamped to
          the canvas before preview and export.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {segments.map((segment) => {
            const badges = zoomSegmentBadges(segment)
            return (
              <div
                key={segment.id}
                className={`flex flex-col gap-1.5 rounded-md border p-2 text-[11px] ${
                  selectedSegment?.id === segment.id
                    ? "border-primary/60 bg-primary/10"
                    : "border-border bg-surface-dim"
                }`}
              >
                <button
                  type="button"
                  className="flex items-center justify-between text-left"
                  onClick={() => selectSegment(segment)}
                >
                  <span className="min-w-0 truncate">
                    {formatZoomTime(segment.startMs)} →{" "}
                    {formatZoomTime(segment.startMs + segment.durationMs)}
                  </span>
                  <span className="shrink-0 font-mono text-subtle-foreground">
                    {segment.scale.toFixed(1)}×
                  </span>
                </button>
                {badges.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {badges.map((badge) => (
                      <Badge
                        key={badge.key}
                        variant={badgeVariant(badge.variant)}
                        className="text-[9px]"
                      >
                        {badge.label}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <div className="flex gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[10px]"
                    onClick={() => splitSegment(segment)}
                    disabled={segment.locked}
                  >
                    Split
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[10px]"
                    onClick={() => toggleLock(segment)}
                  >
                    {segment.locked ? "Unlock" : "Lock"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[10px] text-recording hover:text-recording"
                    onClick={() => deleteSegment(segment)}
                    disabled={segment.locked}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function formatZoomTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const remainder = Math.floor(ms % 1000)
  return `${seconds}.${remainder.toString().padStart(3, "0")}s`
}
