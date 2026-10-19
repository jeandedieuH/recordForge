import { useMemo } from "react"
import {
  activeKeystrokeWindow,
  buildKeystrokeWindows,
  getTotalDuration,
} from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"

// Live keystroke badges on the editor canvas, driven by the same
// buildKeystrokeWindows mapping the native exporter uses — badges preview
// exactly where export draws them (3% of output height × scale, 7% inset).
interface KeystrokeBadgeOverlayProps {
  // Full RENDERED canvas pixel height (project canvas × fit scale) — not
  // the fitted video bounds — so the normalized font/inset math lands at
  // the same proportion of the frame the export draws into.
  canvasHeight: number
  // The LOGICAL canvas height the export draws at — minimums are applied in
  // design units, then uniformly scaled to the rendered size, so small
  // previews keep the same proportions instead of collapsing to pixel
  // floors (at a 240px render every scale choice otherwise clamps to 10px).
  designHeight: number
}

export function KeystrokeBadgeOverlay({ canvasHeight, designHeight }: KeystrokeBadgeOverlayProps) {
  // The draft timeline reflects an in-progress edit before commit — same
  // source the canvas preview renders from.
  const timeline = useTimelineStore((state) => state.draftTimeline ?? state.engine?.history.present)
  const project = useTimelineStore((state) => state.project)
  const events = useTimelineStore((state) => state.keystrokeEvents)
  const playheadMs = useTimelineStore((state) => state.view.playheadMs)

  const overlay = project?.exportSettings.keystrokeOverlay

  const windows = useMemo(() => {
    if (!timeline || !project || !overlay?.enabled || events.length === 0) return []
    const screenTrack = timeline.tracks.find((track) => track.kind === "screen")
    if (!screenTrack) return []
    const recordingAssetIds = project.assets
      .filter((asset) => asset.role === "screen")
      .map((asset) => asset.id)
    return buildKeystrokeWindows({
      events,
      segments: screenTrack.clips,
      recordingAssetIds,
      durationMs: getTotalDuration(timeline),
      settings: overlay,
    })
  }, [timeline, project, overlay, events])

  const active = useMemo(() => activeKeystrokeWindow(windows, playheadMs), [windows, playheadMs])

  if (!active || !overlay?.enabled) return null

  // Mirrors the native drawtext geometry in exports/keystrokes.rs — but the
  // floors are DESIGN-unit minimums applied once, then scaled to the
  // rendered canvas. Applying them in displayed pixels (the old behavior)
  // collapses the 75/100/125% choices at small renders.
  const pxPerUnit = designHeight > 0 ? canvasHeight / designHeight : 1
  const scale = overlay.scalePercent / 100
  const fontDesign = Math.max(10, Math.round(designHeight * 0.03 * scale))
  const fontSize = fontDesign * pxPerUnit
  const inset = Math.max(16, Math.round(designHeight * 0.07)) * pxPerUnit
  const padding = Math.max(6, Math.floor(fontDesign / 3)) * pxPerUnit

  const horizontal =
    overlay.position === "bottom-left"
      ? { left: inset }
      : overlay.position === "bottom-right"
        ? { right: inset }
        : { left: "50%", transform: "translateX(-50%)" }
  const vertical = overlay.position === "top-center" ? { top: inset } : { bottom: inset }

  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{ ...horizontal, ...vertical }}
      aria-hidden
    >
      <span
        className="rounded-sm bg-black/55 font-normal text-white"
        // Block text with a controlled line height — a default inline span's
        // metric varies with the scaled font size and shifts the badge.
        style={{ fontSize, padding, display: "block", lineHeight: 1.2 }}
      >
        {active.label}
      </span>
    </div>
  )
}
