import { useState } from "react"
import type { ManualZoomSegment, ZoomEasing, ZoomMode } from "@recordforge/contracts"
import { clampZoomTarget, zoomSegmentBadges, zoomTargetForCursorPoint } from "@recordforge/cursor-core"
import {
  createDeleteZoomSegmentCommand,
  createSplitZoomSegmentCommand,
} from "@recordforge/editor-core"
import { Lock, Unlock, ZoomIn } from "lucide-react"
import { Badge, Button, Input, NativeSelect, cn } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useTimelineInteraction } from "../timeline/use-timeline-interaction"
import { NumberField } from "./fields"

interface ZoomSegmentInspectorProps {
  segment: ManualZoomSegment
  onClear: () => void
}

function badgeVariant(
  variant: "default" | "secondary" | "outline" | "warning",
): "default" | "accent" | "outline" | "warning" {
  if (variant === "secondary") return "outline"
  if (variant === "default") return "accent"
  return variant
}

export function ZoomSegmentInspector({ segment, onClear }: ZoomSegmentInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const interaction = useTimelineInteraction()
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const [extraPadding, setExtraPadding] = useState(0)

  function handleUpdate(update: Parameters<typeof interaction.updateZoomTarget>[1]) {
    interaction.updateZoomTarget(segment.id, update, { phase: "commit" })
  }

  function clampTarget() {
    if (!timeline) return
    const clamped = clampZoomTarget(segment.target, timeline.canvas, extraPadding)
    handleUpdate({ target: clamped })
  }

  const canvasWidth = timeline?.canvas.width ?? 1920
  const canvasHeight = timeline?.canvas.height ?? 1080

  function setAnchor(anchorX: 0 | 0.5 | 1, anchorY: 0 | 0.5 | 1) {
    if (segment.locked || !timeline) return
    const targetScale = Math.max(1.05, canvasWidth / Math.max(1, segment.target.width))
    const px = anchorX * canvasWidth
    const py = anchorY * canvasHeight
    const next = zoomTargetForCursorPoint(
      { x: px, y: py },
      { width: canvasWidth, height: canvasHeight, padding: 0 },
      targetScale,
    )
    handleUpdate({ target: next, scale: targetScale })
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
    const targetScale = Math.max(1.05, canvasWidth / Math.max(1, segment.target.width))
    const next = zoomTargetForCursorPoint(
      { x: canvasClickX, y: canvasClickY },
      { width: canvasWidth, height: canvasHeight, padding: 0 },
      targetScale,
    )
    handleUpdate({ target: next, scale: targetScale })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ZoomIn className="size-4 text-primary" aria-hidden />
          <span>Zoom Segment</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleUpdate({ locked: !segment.locked })}
            className="h-7 px-2 text-xs"
            title={segment.locked ? "Unlock segment" : "Lock segment"}
          >
            {segment.locked ? <Lock className="size-3.5" aria-hidden /> : <Unlock className="size-3.5 text-subtle-foreground" aria-hidden />}
          </Button>
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

      {/* Label */}
      <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
        <span>Segment Label</span>
        <Input
          value={segment.label ?? ""}
          placeholder="e.g. Focus on code, CTA click"
          onChange={(e) => handleUpdate({ label: e.target.value || undefined })}
          disabled={segment.locked}
          className="h-7 text-xs"
        />
      </label>

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
              "relative cursor-crosshair rounded border border-border bg-black/40 overflow-hidden select-none transition-opacity",
              segment.locked && "cursor-not-allowed opacity-60",
            )}
            style={{ width: `${miniMapWidth}px`, height: `${miniMapHeight}px` }}
            title="Click to center focus area"
          >
            {/* Rule of thirds grid */}
            <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-20">
              <div className="border-b border-r border-dashed border-white" />
              <div className="border-b border-r border-dashed border-white" />
              <div className="border-b border-dashed border-white" />
              <div className="border-b border-r border-dashed border-white" />
              <div className="border-b border-r border-dashed border-white" />
              <div className="border-b border-dashed border-white" />
              <div className="border-r border-dashed border-white" />
              <div className="border-r border-dashed border-white" />
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

      {/* Mode and Easing */}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
        <label className="flex items-center justify-between gap-2 text-[11px] text-subtle-foreground">
          <span>Camera Mode</span>
          <NativeSelect
            aria-label="Camera tracking mode"
            value={segment.mode ?? "static"}
            onChange={(event) =>
              handleUpdate({ mode: event.target.value as ZoomMode })
            }
            disabled={segment.locked}
            className="w-36"
          >
            <option value="static">Static Box</option>
            <option value="follow-cursor">Follow Cursor</option>
            <option value="smooth-pan">Smooth Pan</option>
            <option value="auto">Auto / Smart</option>
          </NativeSelect>
        </label>

        <label className="flex items-center justify-between gap-2 text-[11px] text-subtle-foreground">
          <span>Easing Curve</span>
          <NativeSelect
            aria-label="Zoom easing"
            value={segment.easing ?? "smooth"}
            onChange={(event) =>
              handleUpdate({ easing: event.target.value as ZoomEasing })
            }
            disabled={segment.locked}
            className="w-36"
          >
            <option value="smooth">Smooth (Quintic)</option>
            <option value="spring">Spring (Dynamic)</option>
            <option value="cinematic">Cinematic</option>
            <option value="snappy">Snappy</option>
            <option value="ease-in-out">Ease in / out</option>
            <option value="ease-in">Ease in</option>
            <option value="ease-out">Ease out</option>
            <option value="linear">Linear</option>
          </NativeSelect>
        </label>

        {/* Transition In / Out Durations */}
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

      {/* Numerical Target Dimensions */}
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
        <NumberField
          label="Scale"
          value={Number((canvasWidth / Math.max(1, segment.target.width)).toFixed(2))}
          step={0.1}
          min={1}
          onChange={(newScale) => {
            const safeScale = Math.max(1.05, Math.min(8, newScale))
            const centerX = segment.target.x + segment.target.width / 2
            const centerY = segment.target.y + segment.target.height / 2
            const next = zoomTargetForCursorPoint(
              { x: centerX, y: centerY },
              { width: canvasWidth, height: canvasHeight, padding: 0 },
              safeScale,
            )
            handleUpdate({ scale: safeScale, target: next })
          }}
        />
      </div>

      {/* Safe Edges & Clamping */}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold">Safe Edges</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px]"
            disabled={segment.locked || !timeline}
            onClick={clampTarget}
          >
            Clamp target
          </Button>
        </div>
        <NumberField
          label="Extra padding (px)"
          value={extraPadding}
          min={0}
          step={1}
          onChange={setExtraPadding}
        />
      </div>

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

