import { useMemo, type ReactNode } from "react"
import type { CursorEffectClip, MediaMetadata } from "@recordforge/contracts"
import { findClip, findMarker, getManualZoomSegments } from "@recordforge/editor-core"
import { Monitor } from "lucide-react"
import { Button } from "@recordforge/ui"
import { InspectorSection } from "./fields"
import { useTimelineStore } from "../../../stores/timeline-store"
import { CanvasInspector } from "./canvas-inspector"
import { MarkerInspector } from "./marker-inspector"
import { ZoomSegmentInspector } from "./zoom-segment-inspector"
import { CursorRangeInspector } from "./cursor-range-inspector"
import { MultiSelectionInspector } from "./multi-selection-inspector"
import { CameraClipInspector } from "./camera-clip-inspector"
import { CaptionClipInspector } from "./caption-clip-inspector"
import { AudioClipInspector } from "./audio-clip-inspector"
import { MaskClipInspector } from "./mask-clip-inspector"
import { ClipPropertiesInspector } from "./clip-properties-inspector"

interface InspectorShellProps {
  metadata: MediaMetadata | null
}

export function InspectorShell({ metadata }: InspectorShellProps) {
  const engine = useTimelineStore((state) => state.engine)
  const view = useTimelineStore((state) => state.view)
  const timeline = engine?.history.present
  const selection = view.selection
  const setSelection = useTimelineStore((state) => state.setSelection)

  const selectedClip = useMemo(() => {
    if (!timeline || selection?.kind !== "clip") return null
    return findClip(timeline, selection.primaryClipId)
  }, [timeline, selection])

  const selectedClipCount = selection?.kind === "clip" ? selection.clipIds.length : 0

  const selectedMarker = useMemo(() => {
    if (!timeline || selection?.kind !== "marker") return null
    return findMarker(timeline, selection.markerId)
  }, [timeline, selection])

  const selectedZoom = useMemo(() => {
    if (!timeline || selection?.kind !== "zoom") return null
    return (
      getManualZoomSegments(timeline).find((segment) => segment.id === selection.segmentId) ?? null
    )
  }, [timeline, selection])

  function onClear() {
    setSelection(null)
  }

  const selectedClipIds =
    selection?.kind === "clip" ? (selection.clipIds as string[]) : ([] as string[])

  const { title, canClear, content } = buildContent(
    selectedClip,
    selectedClipCount,
    selectedClipIds,
    selectedMarker,
    selectedZoom,
    metadata,
    onClear,
  )

  return (
    <aside
      className="flex h-full min-w-0 flex-col overflow-y-auto border-l border-border bg-surface p-4"
      role="region"
      aria-label="Contextual inspector"
    >
      <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
          <Monitor className="size-4 text-primary" aria-hidden />
          <span className="truncate">{title}</span>
        </div>
        {canClear ? (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClear}>
            Clear
          </Button>
        ) : null}
      </div>
      {content}
    </aside>
  )
}

function buildContent(
  selectedClip: ReturnType<typeof findClip> | null,
  selectedClipCount: number,
  selectedClipIds: string[],
  selectedMarker: ReturnType<typeof findMarker> | null,
  selectedZoom: ReturnType<typeof getManualZoomSegments>[number] | null,
  metadata: MediaMetadata | null,
  onClear: () => void,
): { title: string; canClear: boolean; content: ReactNode } {
  if (selectedMarker) {
    return {
      title: "Marker",
      canClear: true,
      content: <MarkerInspector marker={selectedMarker} onClear={onClear} />,
    }
  }

  if (selectedZoom) {
    return {
      title: "Zoom segment",
      canClear: true,
      content: <ZoomSegmentInspector segment={selectedZoom} onClear={onClear} />,
    }
  }

  if (selectedClipCount > 1) {
    return {
      title: `${selectedClipCount} selected`,
      canClear: true,
      content: <MultiSelectionInspector clipIds={selectedClipIds} onClear={onClear} />,
    }
  }

  if (selectedClip) {
    const clip = selectedClip.clip
    const track = selectedClip.track

    if (clip.kind === "cursor-effect") {
      return {
        title: "Cursor range",
        canClear: true,
        content: <CursorRangeInspector range={clip as CursorEffectClip} onClear={onClear} />,
      }
    }

    if (clip.kind === "camera") {
      return {
        title: "Camera capture",
        canClear: true,
        content: (
          <CameraClipInspector
            clip={clip}
            track={track}
            metadata={metadata}
            selectedClipCount={selectedClipCount}
          />
        ),
      }
    }

    if (clip.kind === "caption") {
      return {
        title: clip.text || "Caption",
        canClear: true,
        content: (
          <CaptionClipInspector
            clip={clip}
            track={track}
            metadata={metadata}
            selectedClipCount={selectedClipCount}
          />
        ),
      }
    }

    if (clip.kind === "audio") {
      return {
        title: track.name,
        canClear: true,
        content: (
          <AudioClipInspector
            clip={clip}
            track={track}
            metadata={metadata}
            selectedClipCount={selectedClipCount}
          />
        ),
      }
    }

    if (clip.kind === "mask") {
      return {
        title: `${clip.mode} mask`,
        canClear: true,
        content: (
          <MaskClipInspector
            clip={clip}
            track={track}
            metadata={metadata}
            selectedClipCount={selectedClipCount}
          />
        ),
      }
    }

    // Default: screen or any other clip kind.
    return {
      title: "Screen capture",
      canClear: true,
      content: (
        <div className="flex flex-col gap-4">
          <InspectorSection title="Basic" defaultOpen>
            <ClipPropertiesInspector
              clip={clip}
              track={track}
              metadata={metadata}
              selectedClipCount={selectedClipCount}
            />
          </InspectorSection>
          <InspectorSection title="Advanced" defaultOpen={false}>
            <p className="text-[11px] leading-relaxed text-subtle-foreground">
              Screen clips use the source timing and track mute controls. Split or trim the clip to
              adjust its visible range.
            </p>
          </InspectorSection>
        </div>
      ),
    }
  }

  return {
    title: "Project",
    canClear: false,
    content: <CanvasInspector />,
  }
}
