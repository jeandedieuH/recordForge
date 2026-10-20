import { useEffect, useRef, useState } from "react"
import type { KeystrokeOverlaySettings, TimelineState } from "@recordforge/contracts"
import { resolveKeystrokeDisplay, timelineToSourceForTrack } from "@recordforge/editor-core"
import type { KeystrokeData } from "../../../lib/keystrokes"
import { KeystrokeBadge } from "./keystroke-badge"

interface KeystrokePreviewProps {
  timeline: TimelineState | null
  playheadMs: number
  settings: KeystrokeOverlaySettings
  data: KeystrokeData | null
}

/**
 * WYSIWYG keystroke-badge preview: the shared display model evaluates badge
 * state from the source timestamp the playhead maps to, so trims, splits, and
 * speed changes shift badges exactly like the export rasterizer computes
 * them. Every px is a pure function of playheadMs — scrubbing is exact
 * (same rule as CaptionPreview: no CSS transition animations).
 */
export function KeystrokePreview({ timeline, playheadMs, settings, data }: KeystrokePreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [frameWidth, setFrameWidth] = useState(0)

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const observer = new ResizeObserver(([entry]) => {
      setFrameWidth(entry.contentRect.width)
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  const scale = timeline && timeline.canvas.width > 0 ? frameWidth / timeline.canvas.width : 0

  const sourceMs =
    timeline === null
      ? null
      : (timelineToSourceForTrack(timeline, "screen", playheadMs)?.sourceMs ?? null)

  const display =
    timeline && sourceMs !== null
      ? resolveKeystrokeDisplay({
          events: data?.events ?? [],
          settings,
          platform: data?.platform ?? "unknown",
          sourceMs,
          canvas: { width: timeline.canvas.width, height: timeline.canvas.height },
        })
      : null

  return (
    <div ref={frameRef} className="pointer-events-none absolute inset-0 z-45" aria-hidden>
      {scale > 0 &&
        display &&
        display.rows.map((row) => <KeystrokeBadge key={row.key} row={row} scale={scale} />)}
    </div>
  )
}
