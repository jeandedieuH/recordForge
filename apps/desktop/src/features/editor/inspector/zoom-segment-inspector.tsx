import { useState } from "react"
import type { ManualZoomSegment, ZoomEasing } from "@recordforge/contracts"
import type { FollowSpeed } from "@recordforge/cursor-core"
import { zoomSegmentBadges, zoomTargetForCursorPoint } from "@recordforge/cursor-core"
import {
  createDeleteZoomSegmentCommand,
  createSplitZoomSegmentCommand,
} from "@recordforge/editor-core"
import { Lock, Unlock, ZoomIn } from "lucide-react"
import {
  Badge,
  Button,
  IconButton,
  Input,
  SimpleSelect,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  cn,
} from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useTimelineInteraction } from "../timeline/use-timeline-interaction"
import { DebouncedSlider, InspectorSection, NumberField } from "./fields"

interface ZoomSegmentInspectorProps {
  segment: ManualZoomSegment
  onClear: () => void
}

const ZOOM_LEVEL_MIN = 1.1
const ZOOM_LEVEL_MAX = 4
const ZOOM_LEVEL_CHIPS = [1.25, 1.5, 2, 2.5]

// The inspector only exposes the stable motion feels; other schema easings
// (linear, spring, …) are still honored and shown as a read-only option.
const ZOOM_FEEL_OPTIONS: { value: ZoomEasing; label: string }[] = [
  { value: "smooth", label: "Smooth" },
  { value: "cinematic", label: "Cinematic" },
  { value: "snappy", label: "Snappy" },
]

const FOLLOW_SPEED_OPTIONS: { value: FollowSpeed; label: string }[] = [
  { value: "relaxed", label: "Relaxed" },
  { value: "balanced", label: "Balanced" },
  { value: "tight", label: "Tight" },
]

function badgeVariant(
  variant: "default" | "secondary" | "outline" | "warning",
): "default" | "accent" | "outline" | "warning" {
  if (variant === "secondary") return "outline"
  if (variant === "default") return "accent"
  return variant
}

/**
 * Label edits commit on blur/Enter so each keystroke does not enqueue a
 * separate undo entry (update commands otherwise coalesce but still churn).
 * Rendered with key={segment.id} so the draft resets when the selection moves.
 */
function LabelField({
  segment,
  disabled,
  onCommit,
}: {
  segment: ManualZoomSegment
  disabled: boolean
  onCommit: (label: string | undefined) => void
}) {
  const [draft, setDraft] = useState(segment.label ?? "")

  function commit() {
    const next = draft.trim()
    if (next === (segment.label ?? "")) return
    onCommit(next === "" ? undefined : next)
  }

  return (
    <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
      <span>Segment Label</span>
      <Input
        value={draft}
        placeholder="e.g. Focus on code, CTA click"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
            event.currentTarget.blur()
          }
        }}
        disabled={disabled}
        className="h-7 text-xs"
      />
    </label>
  )
}

export function ZoomSegmentInspector({ segment, onClear }: ZoomSegmentInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const interaction = useTimelineInteraction()
  const timeline = useTimelineStore((state) => state.engine?.history.present)

  function handleUpdate(update: Parameters<typeof interaction.updateZoomTarget>[1]) {
    interaction.updateZoomTarget(segment.id, update, { phase: "commit" })
  }

  const canvasWidth = timeline?.canvas.width ?? 1920
  const canvasHeight = timeline?.canvas.height ?? 1080
  const currentScale = Math.max(1, Math.min(8, canvasWidth / Math.max(1, segment.target.width)))
  const isFollowMode = segment.mode === "follow-cursor"

  function applyScalePreset(targetScale: number) {
    const safeScale = Math.max(1.05, Math.min(8, targetScale))
    const centerX = segment.target.x + segment.target.width / 2
    const centerY = segment.target.y + segment.target.height / 2
    const next = zoomTargetForCursorPoint(
      { x: centerX, y: centerY },
      { width: canvasWidth, height: canvasHeight, padding: 0 },
      safeScale,
    )
    handleUpdate({ scale: safeScale, target: next })
  }

  function setAnchor(anchorX: 0 | 0.5 | 1, anchorY: 0 | 0.5 | 1) {
    if (segment.locked || !timeline) return
    const px = anchorX * canvasWidth
    const py = anchorY * canvasHeight
    const next = zoomTargetForCursorPoint(
      { x: px, y: py },
      { width: canvasWidth, height: canvasHeight, padding: 0 },
      currentScale,
    )
    handleUpdate({ target: next, scale: currentScale })
  }

  const badges = zoomSegmentBadges(segment)

  // Mini-map coordinates
  const miniMapWidth = 220
  const miniMapHeight = Math.round((miniMapWidth * canvasHeight) / canvasWidth)
  const mapScale = miniMapWidth / canvasWidth

  const targetBox = {
    left: Math.round(segment.target.x * mapScale),
    top: Math.round(segment.target.y * mapScale),
    width: Math.max(4, Math.round(segment.target.width * mapScale)),
    height: Math.max(4, Math.round(segment.target.height * mapScale)),
  }

  function handleMiniMapClick(event: React.MouseEvent<HTMLDivElement>) {
    if (segment.locked || !timeline) return
    const rect = event.currentTarget.getBoundingClientRect()
    const clickX = event.clientX - rect.left
    const clickY = event.clientY - rect.top
    const canvasClickX = (clickX / rect.width) * canvasWidth
    const canvasClickY = (clickY / rect.height) * canvasHeight
    const next = zoomTargetForCursorPoint(
      { x: canvasClickX, y: canvasClickY },
      { width: canvasWidth, height: canvasHeight, padding: 0 },
      currentScale,
    )
    handleUpdate({ target: next, scale: currentScale })
  }

  const easingOptions = ZOOM_FEEL_OPTIONS.some((option) => option.value === segment.easing)
    ? ZOOM_FEEL_OPTIONS
    : [...ZOOM_FEEL_OPTIONS, { value: segment.easing, label: segment.easing }]

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ZoomIn className="size-4 text-primary" aria-hidden />
          <span>Zoom Segment</span>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            label={segment.locked ? "Unlock segment" : "Lock segment"}
            tooltipSide="bottom"
            variant="ghost"
            size="sm"
            className="size-7"
            onClick={() => handleUpdate({ locked: !segment.locked })}
          >
            {segment.locked ? (
              <Lock className="size-3.5" aria-hidden />
            ) : (
              <Unlock className="size-3.5 text-subtle-foreground" aria-hidden />
            )}
          </IconButton>
          <Button variant="ghost" size="sm" onClick={onClear} className="h-7 text-xs">
            Done
          </Button>
        </div>
      </div>

      {badges.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {badges.map((badge) => (
            <Badge key={badge.key} variant={badgeVariant(badge.variant)} className="text-[10px]">
              {badge.label}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="flex items-center justify-between rounded-xl border border-border bg-surface p-3">
        <div className="min-w-0 pr-3">
          <span className="text-[11px] font-semibold text-foreground">Apply zoom</span>
          <p className="mt-0.5 text-[10px] leading-relaxed text-subtle-foreground">
            Keep this range editable without rendering it in preview or export.
          </p>
        </div>
        <Switch
          checked={segment.enabled}
          disabled={segment.locked}
          onCheckedChange={(enabled) => handleUpdate({ enabled })}
          aria-label="Apply zoom segment"
        />
      </div>

      <LabelField
        key={segment.id}
        segment={segment}
        disabled={segment.locked}
        onCommit={(label) => handleUpdate({ label })}
      />

      {/* Camera */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-foreground">Camera mode</span>
          <ToggleGroup
            type="single"
            aria-label="Camera mode"
            value={isFollowMode ? "follow-cursor" : "static"}
            disabled={segment.locked}
            onValueChange={(value) => {
              if (!value) return
              handleUpdate({ mode: value as "follow-cursor" | "static" })
            }}
            className="flex w-full rounded-md border border-border"
          >
            <ToggleGroupItem value="follow-cursor" className="h-7 flex-1 px-2 text-[11px]">
              Follow cursor
            </ToggleGroupItem>
            <ToggleGroupItem value="static" className="h-7 flex-1 px-2 text-[11px]">
              Fixed focus
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {isFollowMode ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-subtle-foreground">Follow speed</span>
            <ToggleGroup
              type="single"
              aria-label="Follow speed"
              value={segment.followSpeed ?? "balanced"}
              disabled={segment.locked}
              onValueChange={(value) => {
                if (!value) return
                handleUpdate({ followSpeed: value as FollowSpeed })
              }}
              className="flex w-full rounded-md border border-border"
            >
              {FOLLOW_SPEED_OPTIONS.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  className="h-7 flex-1 px-2 text-[11px]"
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2 text-[11px] text-subtle-foreground">
          <span>Zoom feel</span>
          <SimpleSelect
            aria-label="Zoom feel"
            size="sm"
            value={segment.easing}
            onValueChange={(val) => handleUpdate({ easing: val as ZoomEasing })}
            disabled={segment.locked}
            className="w-36"
            options={easingOptions}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border">
          <NumberField
            label="Ease-In (ms)"
            value={segment.transitionInMs ?? 400}
            min={0}
            step={50}
            onChange={(val) => handleUpdate({ transitionInMs: val })}
          />
          <NumberField
            label="Ease-Out (ms)"
            value={segment.transitionOutMs ?? 400}
            min={0}
            step={50}
            onChange={(val) => handleUpdate({ transitionOutMs: val })}
          />
        </div>
      </div>

      {/* Zoom level */}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-foreground">Zoom level</span>
          <div className="flex items-center gap-1">
            {ZOOM_LEVEL_CHIPS.map((chipScale) => (
              <button
                key={chipScale}
                type="button"
                disabled={segment.locked}
                onClick={() => applyScalePreset(chipScale)}
                className={cn(
                  "px-1.5 py-0.5 text-[10px] font-mono rounded border transition-colors",
                  Math.abs(currentScale - chipScale) < 0.05
                    ? "border-primary bg-primary/10 text-primary font-semibold"
                    : "border-border bg-surface-dim text-muted-foreground hover:bg-overlay hover:text-foreground",
                )}
              >
                {chipScale}×
              </button>
            ))}
          </div>
        </div>
        <DebouncedSlider
          value={[Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, currentScale))]}
          min={ZOOM_LEVEL_MIN}
          max={ZOOM_LEVEL_MAX}
          step={0.05}
          disabled={segment.locked}
          onValueCommit={([val]) => applyScalePreset(val)}
          aria-label="Zoom level"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>Magnification</span>
          <span className="font-mono tabular-nums">{currentScale.toFixed(2)}×</span>
        </div>
      </div>

      {/* 2D Canvas Mini-map Focal Repositioner */}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-foreground">Focal Position Mini-map</span>
          <span className="text-[10px] text-muted-foreground">Click to reposition</span>
        </div>

        <div className="flex justify-center">
          <div
            role="button"
            tabIndex={0}
            onClick={handleMiniMapClick}
            className={cn(
              "relative cursor-crosshair rounded border border-border bg-surface-dim overflow-hidden select-none transition-opacity",
              segment.locked && "cursor-not-allowed opacity-60",
            )}
            style={{ width: `${miniMapWidth}px`, height: `${miniMapHeight}px` }}
            title="Click to center focus area"
          >
            {/* Rule of thirds grid */}
            <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-20">
              <div className="border-b border-r border-dashed border-foreground" />
              <div className="border-b border-r border-dashed border-foreground" />
              <div className="border-b border-dashed border-foreground" />
              <div className="border-b border-r border-dashed border-foreground" />
              <div className="border-b border-r border-dashed border-foreground" />
              <div className="border-b border-dashed border-foreground" />
              <div className="border-r border-dashed border-foreground" />
              <div className="border-r border-dashed border-foreground" />
              <div />
            </div>

            {/* Target Box Indicator */}
            <div
              className="pointer-events-none absolute rounded border border-primary bg-primary/25 shadow-sm ring-1 ring-primary/40"
              style={{
                left: `${targetBox.left}px`,
                top: `${targetBox.top}px`,
                width: `${targetBox.width}px`,
                height: `${targetBox.height}px`,
              }}
            />
          </div>
        </div>

        {/* 9-Point Quick Alignment Grid */}
        <div className="grid grid-cols-3 gap-1 pt-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={segment.locked}
            onClick={() => setAnchor(0, 0)}
            className="h-6 text-[10px] px-1"
          >
            Top Left
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={segment.locked}
            onClick={() => setAnchor(0.5, 0)}
            className="h-6 text-[10px] px-1"
          >
            Top
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={segment.locked}
            onClick={() => setAnchor(1, 0)}
            className="h-6 text-[10px] px-1"
          >
            Top Right
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={segment.locked}
            onClick={() => setAnchor(0, 0.5)}
            className="h-6 text-[10px] px-1"
          >
            Left
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={segment.locked}
            onClick={() => setAnchor(0.5, 0.5)}
            className="h-6 text-[10px] px-1"
          >
            Center
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={segment.locked}
            onClick={() => setAnchor(1, 0.5)}
            className="h-6 text-[10px] px-1"
          >
            Right
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={segment.locked}
            onClick={() => setAnchor(0, 1)}
            className="h-6 text-[10px] px-1"
          >
            Bottom Left
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={segment.locked}
            onClick={() => setAnchor(0.5, 1)}
            className="h-6 text-[10px] px-1"
          >
            Bottom
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={segment.locked}
            onClick={() => setAnchor(1, 1)}
            className="h-6 text-[10px] px-1"
          >
            Bottom Right
          </Button>
        </div>
      </div>

      {/* Advanced numeric fields — kept behind a disclosure because the
          mini-map and zoom slider cover the common adjustments. */}
      <InspectorSection title="Advanced" defaultOpen={false}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Target X"
            value={segment.target.x}
            onChange={(value) => handleUpdate({ target: { x: value } })}
          />
          <NumberField
            label="Target Y"
            value={segment.target.y}
            onChange={(value) => handleUpdate({ target: { y: value } })}
          />
          <NumberField
            label="Target width"
            value={segment.target.width}
            onChange={(value) => handleUpdate({ target: { width: value } })}
          />
          <NumberField
            label="Target height"
            value={segment.target.height}
            onChange={(value) => handleUpdate({ target: { height: value } })}
          />
          <NumberField
            label="Start (ms)"
            value={segment.startMs}
            onChange={(value) => handleUpdate({ startMs: value })}
          />
          <NumberField
            label="End (ms)"
            value={segment.startMs + segment.durationMs}
            onChange={(value) => handleUpdate({ endMs: value })}
          />
        </div>
      </InspectorSection>

      {/* Action Buttons */}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[10px] flex-1"
          disabled={segment.locked}
          onClick={() =>
            execute(
              createSplitZoomSegmentCommand(
                segment.id,
                segment.startMs + Math.floor(segment.durationMs / 2),
              ),
            )
          }
        >
          Split
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[10px] flex-1"
          onClick={() => handleUpdate({ locked: !segment.locked })}
        >
          {segment.locked ? "Unlock" : "Lock"}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-7 text-[10px] flex-1"
          disabled={segment.locked}
          onClick={() => {
            execute(createDeleteZoomSegmentCommand(segment.id))
            onClear()
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  )
}
