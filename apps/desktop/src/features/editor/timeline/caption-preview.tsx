import { useEffect, useRef, useState } from "react"
import type { CaptionClip } from "@recordforge/contracts"
import { captionTextClass } from "../captions/caption-styles"

interface CaptionPreviewProps {
  clips: CaptionClip[]
  playheadMs: number
  canvasHeight: number
}

function isActive(clip: CaptionClip, playheadMs: number): boolean {
  return playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs
}

export function CaptionPreview({ clips, playheadMs, canvasHeight }: CaptionPreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [frameHeight, setFrameHeight] = useState(0)

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const observer = new ResizeObserver(([entry]) => {
      setFrameHeight(entry.contentRect.height)
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  // Burned-in captions size to ~3.8% of the canvas height, so the preview
  // derives font size and safe-area margins from the rendered frame height
  // instead of window breakpoints — keeping it WYSIWYG with the export.
  const scale = canvasHeight > 0 ? frameHeight / canvasHeight : 0
  const fontSize = frameHeight * 0.038

  return (
    <div
      ref={frameRef}
      className="pointer-events-none absolute inset-0 z-40"
      aria-live="off"
      aria-hidden
    >
      {clips.map((clip) => {
        const active = isActive(clip, playheadMs)
        const margin = Math.max(0, clip.safeAreaMargin ?? 48) * scale
        const positionStyle =
          clip.placement === "top"
            ? { top: margin }
            : clip.placement === "center"
              ? { top: "50%", transform: "translate(-50%, -50%)" }
              : { bottom: margin }
        return (
          <div
            key={clip.id}
            className="absolute left-1/2 max-w-[88%] text-center leading-[1.3] transition-opacity duration-fast"
            style={{
              ...positionStyle,
              ...(clip.placement === "center" ? {} : { transform: "translateX(-50%)" }),
              fontSize,
              opacity: active ? 1 : 0,
            }}
          >
            <span className={`whitespace-pre-line wrap-anywhere ${captionTextClass(clip.style)}`}>
              {clip.text}
            </span>
          </div>
        )
      })}
    </div>
  )
}
