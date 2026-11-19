import { useId, useMemo, useState } from "react"
import { ChevronDown, Move, MousePointer2, Play, Wind, ZoomIn } from "lucide-react"
import type { MotionBlurSettings, TimelineCanvas } from "@recordforge/contracts"
import {
  DEFAULT_MOTION_BLUR_SETTINGS,
  MOTION_BLUR_PRESETS,
  detectMotionBlurPreset,
  effectiveShutterDegrees,
  findMotionBlurPreviewTarget,
  getManualZoomSegments,
  motionBlurMasterStrength,
  normalizeMotionBlurSettings,
  resolveCursorMotionBlurSamples,
  resolveScreenMotionBlurStrip,
  scaleMotionBlurStrength,
} from "@recordforge/editor-core"
import { Button, SliderField, Switch, cn } from "@recordforge/ui"
import { useLicenseStore } from "../../../../stores/license-store"
import { ProBadge } from "../../../licensing/pro-badge"
import { useTimelineStore } from "../../../../stores/timeline-store"
import { usePlayheadMs } from "../../timeline/use-playback-state"

export interface MotionBlurControlsProps {
  canvas: TimelineCanvas
  onChange: (updates: Partial<TimelineCanvas>) => void
  /** Compact variant used inside Focus & Zoom for quick toggle + presets. */
  variant?: "full" | "compact"
}

const CHANNEL_ROWS = [
  { key: "cursor", label: "Cursor", icon: MousePointer2 },
  { key: "zoom", label: "Zoom", icon: ZoomIn },
  { key: "pan", label: "Pan", icon: Move },
] as const

/**
 * Cinema-shutter Motion Blur controls with 1-click presets, proportional master
 * strength, collapsible per-channel mix, and a "Jump to motion" preview helper.
 */
export function MotionBlurControls({
  canvas,
  onChange,
  variant = "full",
}: MotionBlurControlsProps) {
  const toggleId = useId()
  const descId = useId()
  const channelsId = useId()

  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const cursorEngine = useTimelineStore((state) => state.cursorEngine)
  const seek = useTimelineStore((state) => state.seek)
  const playheadMs = usePlayheadMs()

  const normalized = normalizeMotionBlurSettings(canvas.motionBlur)
  const isEnabled = normalized.enabled
  const activePreset = detectMotionBlurPreset(normalized)
  const shutterDegrees = effectiveShutterDegrees(normalized)
  const masterPercent = Math.round(motionBlurMasterStrength(normalized) * 100)

  // Auto-open the channel mix only when the user explicitly expands it or has
  // already customized unequal channels on a loaded project.
  const hasCustomMix = activePreset === null && isEnabled
  const [channelsOpen, setChannelsOpen] = useState(hasCustomMix)

  const zoomCount = useMemo(
    () =>
      timeline
        ? getManualZoomSegments(timeline).filter((segment) => segment.enabled !== false).length
        : 0,
    [timeline],
  )
  const hasCursor = (cursorEngine?.telemetry.events.length ?? 0) > 1

  const isMovingNow = useMemo(() => {
    if (!timeline || !isEnabled) return false
    const screenStrip = resolveScreenMotionBlurStrip(
      timeline,
      playheadMs,
      { width: timeline.canvas.width, height: timeline.canvas.height },
      cursorEngine,
    )
    if (screenStrip !== null) return true
    if (cursorEngine) {
      const samples = resolveCursorMotionBlurSamples(timeline, playheadMs, cursorEngine, {
        width: timeline.canvas.width,
        height: timeline.canvas.height,
      })
      if (samples.length > 1) return true
    }
    return false
  }, [timeline, isEnabled, playheadMs, cursorEngine])

  const previewTarget = useMemo(() => {
    if (!timeline || !isEnabled || isMovingNow || variant === "compact") return null
    return findMotionBlurPreviewTarget(timeline, playheadMs, cursorEngine)
  }, [timeline, isEnabled, isMovingNow, variant, playheadMs, cursorEngine])

  function updateBlur(updates: Partial<MotionBlurSettings>) {
    onChange({
      motionBlur: {
        ...DEFAULT_MOTION_BLUR_SETTINGS,
        ...canvas.motionBlur,
        enabled: true,
        ...updates,
      },
    })
  }

  function handleToggle(enabled: boolean) {
    // Apply `enabled` last so toggling on always overrides a previously saved `false`.
    onChange({
      motionBlur: {
        ...DEFAULT_MOTION_BLUR_SETTINGS,
        ...canvas.motionBlur,
        enabled,
      },
    })
  }

  function handleChannelToggle(key: "cursor" | "zoom" | "pan") {
    const current = normalized[key]
    const fallback = Math.max(0.25, motionBlurMasterStrength(normalized) || 0.5)
    updateBlur({ [key]: current > 0 ? 0 : fallback })
  }

  const contextSummary = useMemo(() => {
    const parts: string[] = []
    if (hasCursor) parts.push("cursor")
    if (zoomCount > 0) parts.push(`${zoomCount} zoom${zoomCount === 1 ? "" : "s"}`)
    if (parts.length === 0) return "Add a zoom or record cursor movement to see motion blur."
    if (zoomCount === 0) return "Active on cursor moves. Add a zoom for camera blur."
    return `Active on ${parts.join(" & ")}.`
  }, [hasCursor, zoomCount])

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-dim/50 p-3">
      {/* Header row with explicit label association and live shutter readout */}
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={toggleId}
          className="flex min-h-6 cursor-pointer items-center gap-2 text-xs font-medium text-foreground"
        >
          <Wind className="size-4 text-primary" aria-hidden />
          <span>Motion blur</span>
          {!isPro ? <ProBadge /> : null}
        </label>
        <div className="flex items-center gap-2">
          {isEnabled ? (
            <span
              className="rounded-sm bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary"
              title="Effective cinema shutter angle"
            >
              {shutterDegrees}°
            </span>
          ) : null}
          <Switch
            id={toggleId}
            checked={isEnabled}
            aria-describedby={descId}
            onCheckedChange={handleToggle}
          />
        </div>
      </div>

      {isEnabled ? (
        <div className="flex flex-col gap-3 pt-0.5">
          {/* Cinema shutter presets */}
          <div className="grid grid-cols-4 gap-1" role="group" aria-label="Motion blur presets">
            {MOTION_BLUR_PRESETS.map((preset) => {
              const selected = activePreset === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={selected}
                  title={preset.description}
                  onClick={() => updateBlur(preset.settings)}
                  className={cn(
                    "flex min-h-7 flex-col items-center justify-center rounded-md border px-1 py-1 text-[10px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    selected
                      ? "border-primary/60 bg-primary/15 font-semibold text-primary shadow-xs"
                      : "border-border/60 bg-surface text-subtle-foreground hover:border-border hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  <span className="leading-tight">{preset.label}</span>
                  {variant === "full" ? (
                    <span className="font-mono text-[9px] opacity-75">
                      {preset.shutterDegrees}°
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>

          {variant === "full" ? (
            <>
              {/* Unified master strength (scales active channels proportionally) */}
              <SliderField
                label="Strength"
                size="sm"
                value={masterPercent}
                min={0}
                max={100}
                step={5}
                unit="%"
                onChange={(value) =>
                  onChange({ motionBlur: scaleMotionBlurStrength(normalized, value / 100) })
                }
              />

              {/* Smart context + 1-click jump to motion when playhead is on a still frame */}
              <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-surface/60 px-2.5 py-1.5">
                <span className="text-[10px] leading-snug text-subtle-foreground">
                  {isMovingNow ? "Live on current frame" : contextSummary}
                </span>
                {previewTarget ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 gap-1 px-2 text-[10px] font-medium text-primary hover:bg-primary/10 hover:text-primary"
                    onClick={() => seek(previewTarget.timeMs)}
                  >
                    <Play className="size-2.5 fill-current" aria-hidden />
                    <span>Preview</span>
                  </Button>
                ) : null}
              </div>

              {/* Collapsible per-channel mix */}
              <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
                <button
                  type="button"
                  aria-expanded={channelsOpen}
                  aria-controls={channelsId}
                  onClick={() => setChannelsOpen((open) => !open)}
                  className="flex min-h-6 w-full items-center justify-between rounded px-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span>Channel mix</span>
                  <span className="flex items-center gap-1.5">
                    {!channelsOpen ? (
                      <span className="font-mono text-[10px] text-subtle-foreground">
                        {Math.round(normalized.cursor * 100)} / {Math.round(normalized.zoom * 100)}{" "}
                        / {Math.round(normalized.pan * 100)}
                      </span>
                    ) : null}
                    <ChevronDown
                      className={cn(
                        "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                        channelsOpen && "rotate-180",
                      )}
                      aria-hidden
                    />
                  </span>
                </button>

                {channelsOpen ? (
                  <div id={channelsId} className="flex flex-col gap-2.5 pt-1">
                    {CHANNEL_ROWS.map(({ key, label, icon: Icon }) => {
                      const percent = Math.round(normalized[key] * 100)
                      const channelActive = percent > 0
                      return (
                        <div key={key} className="flex items-center gap-2">
                          <button
                            type="button"
                            aria-pressed={channelActive}
                            aria-label={`Toggle ${label.toLowerCase()} motion blur`}
                            title={
                              channelActive
                                ? `Disable ${label.toLowerCase()} blur`
                                : `Enable ${label.toLowerCase()} blur`
                            }
                            onClick={() => handleChannelToggle(key)}
                            className={cn(
                              "flex size-6 shrink-0 items-center justify-center rounded-md border transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                              channelActive
                                ? "border-primary/40 bg-primary/10 text-primary"
                                : "border-border/60 bg-surface text-subtle-foreground hover:text-foreground",
                            )}
                          >
                            <Icon className="size-3.5" aria-hidden />
                          </button>
                          <div className="min-w-0 flex-1">
                            <SliderField
                              label={label}
                              size="sm"
                              value={percent}
                              min={0}
                              max={100}
                              step={5}
                              unit="%"
                              onChange={(value) => updateBlur({ [key]: value / 100 })}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          <p id={descId} className="-mt-1 text-[10px] leading-relaxed text-subtle-foreground">
            {variant === "compact"
              ? "Applies to zoom transitions, pans, and cursor moves in preview and export."
              : "50% matches a natural 180° cinema shutter (100% = full-frame 360°). Renders live in preview and matches both GPU and compatibility exports."}
          </p>
        </div>
      ) : (
        <p id={descId} className="-mt-1 text-[10px] leading-relaxed text-subtle-foreground">
          Smooths fast cursor sweeps, zooms, and camera pans with a physical shutter curve.
        </p>
      )}
    </div>
  )
}
