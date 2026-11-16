import { useMemo } from "react"
import type { CameraLayoutKind, CameraLayoutSegment } from "@recordforge/contracts"
import {
  createAddCameraLayoutCommand,
  createDeleteCameraLayoutCommand,
  createDeleteCameraLayoutsCommand,
  createGenerateCameraSilenceLayoutsCommand,
  createUpdateCameraLayoutCommand,
  formatTime,
  getTotalDuration,
} from "@recordforge/editor-core"
import { Button, IconButton, NativeSelect, cn } from "@recordforge/ui"
import { Columns2, EyeOff, PictureInPicture2, RectangleHorizontal, Trash2 } from "lucide-react"
import { useTimelineStore } from "../../../../stores/timeline-store"
import { useSmartCutStore } from "../../../../stores/smart-cut-store"

/** Default length of a layout added from the card, in ms. */
const LAYOUT_ADD_DURATION_MS = 4_000

const LAYOUT_OPTIONS: Array<{
  kind: CameraLayoutKind
  label: string
  icon: typeof PictureInPicture2
}> = [
  { kind: "pip", label: "Picture in picture", icon: PictureInPicture2 },
  { kind: "fullscreen", label: "Fullscreen", icon: RectangleHorizontal },
  { kind: "side-by-side", label: "Side by side", icon: Columns2 },
  { kind: "hidden", label: "Hidden", icon: EyeOff },
]

function layoutLabel(kind: CameraLayoutKind): string {
  return LAYOUT_OPTIONS.find((option) => option.kind === kind)?.label ?? kind
}

/**
 * Camera layout lane (#5), presented as a card: outside every segment the
 * camera keeps its clip transform, and a segment animates it between layouts.
 * The rendered preview and the export plan both derive from the same resolver,
 * so what the canvas shows is what the file contains.
 */
export function CameraLayoutsCard() {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const playheadMs = useTimelineStore((state) => state.view.playheadMs)
  const silenceReview = useSmartCutStore((state) => state.review)

  const segments = useMemo(
    () =>
      [...(timeline?.cameraLayouts ?? [])].sort(
        (left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id),
      ),
    [timeline?.cameraLayouts],
  )
  const hasCameraClip = useMemo(
    () =>
      (timeline?.tracks ?? []).some(
        (track) => track.kind === "camera" && track.clips.some((clip) => clip.kind === "camera"),
      ),
    [timeline?.tracks],
  )

  if (!timeline) return null

  // Adding a segment must not overlap the next one, so the window stops at it.
  const nextStartMs =
    segments.find((segment) => segment.startMs >= playheadMs)?.startMs ?? Number.POSITIVE_INFINITY
  const addEndMs = Math.min(playheadMs + LAYOUT_ADD_DURATION_MS, nextStartMs)
  const canAdd = hasCameraClip && addEndMs - playheadMs >= 500

  function addLayout(kind: CameraLayoutKind) {
    if (!canAdd) return
    execute(
      createAddCameraLayoutCommand(playheadMs, addEndMs, kind, {
        pip: kind === "pip" ? { corner: "br", sizeFraction: 0.24, shape: "rounded" } : undefined,
      }),
    )
  }

  function updateSegment(segment: CameraLayoutSegment, kind: CameraLayoutKind) {
    if (segment.locked) return
    execute(
      createUpdateCameraLayoutCommand(segment.id, {
        layout: kind,
        pip:
          kind === "pip" && !segment.pip
            ? { corner: "br", sizeFraction: 0.24, shape: "rounded" }
            : undefined,
      }),
    )
  }

  const silenceSegments = segments.filter((segment) => segment.source === "silence")
  const canHideSilence =
    hasCameraClip &&
    silenceReview !== null &&
    silenceReview.ranges.filter((range) => !silenceReview.excludedIds.includes(range.id)).length > 0

  function hideDuringSilence() {
    if (!canHideSilence || !silenceReview || !timeline) return
    const included = silenceReview.ranges.filter(
      (range) => !silenceReview.excludedIds.includes(range.id),
    )
    execute(
      createGenerateCameraSilenceLayoutsCommand(
        included.map((range) => ({ startMs: range.startMs, endMs: range.endMs })),
        {
          durationMs: getTotalDuration(timeline),
          fps: timeline.canvas.fps,
        },
      ),
    )
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground">Camera layouts</h3>
        {segments.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              execute(createDeleteCameraLayoutsCommand(segments.map((segment) => segment.id)))
            }
          >
            Clear all
          </Button>
        ) : null}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Outside a layout the camera keeps its clip transform. Layouts animate between each other,
        and the screen frame follows side by side.
      </p>

      <div className="grid grid-cols-2 gap-1.5">
        {LAYOUT_OPTIONS.map((option) => {
          const Icon = option.icon
          return (
            <Button
              key={option.kind}
              variant="outline"
              size="sm"
              disabled={!canAdd}
              title={
                hasCameraClip
                  ? `Add “${option.label}” at the playhead`
                  : "This project has no camera clip"
              }
              onClick={() => addLayout(option.kind)}
            >
              <Icon className="size-3.5" aria-hidden />
              {option.label}
            </Button>
          )
        })}
      </div>

      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-dim px-2 py-1.5">
        <div className="flex flex-col">
          <span className="text-[11px] font-medium text-foreground">Hide during silence</span>
          <span className="text-[10px] text-subtle-foreground">
            {silenceReview
              ? `${silenceReview.ranges.length} silence range(s) from Smart Cut`
              : "Run Smart Cut analysis first"}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!canHideSilence}
          onClick={hideDuringSilence}
          title={
            canHideSilence
              ? "Insert hidden camera layouts for every silence range"
              : "Analyze silence in Smart Cut first"
          }
        >
          {silenceSegments.length > 0 ? "Regenerate" : "Generate"}
        </Button>
      </div>

      {segments.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-[11px] text-subtle-foreground">
          No layout segments yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {segments.map((segment) => (
            <li
              key={segment.id}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border bg-surface/60 px-2 py-1.5",
                !segment.enabled && "opacity-60",
                segment.locked && "border-border-strong",
              )}
            >
              <span className="w-[92px] shrink-0 font-mono text-[10px] text-subtle-foreground">
                {formatTime(segment.startMs)}
              </span>
              <NativeSelect
                size="sm"
                aria-label={`Layout for the segment at ${formatTime(segment.startMs)}`}
                value={segment.layout}
                disabled={segment.locked}
                onChange={(event) => updateSegment(segment, event.target.value as CameraLayoutKind)}
              >
                {LAYOUT_OPTIONS.map((option) => (
                  <option key={option.kind} value={option.kind}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
              <IconButton
                label={`Delete the ${layoutLabel(segment.layout)} segment at ${formatTime(segment.startMs)}`}
                disabled={segment.locked}
                onClick={() => execute(createDeleteCameraLayoutCommand(segment.id))}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
