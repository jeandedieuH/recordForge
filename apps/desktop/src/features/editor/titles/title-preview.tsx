import { memo, useEffect, useMemo, useRef, useState } from "react"
import type { TextClip, TextPresetRecord } from "@recordforge/editor-core"
import { renderOverlayDisplayList, type OverlayEngine } from "@recordforge/overlay-core"
import { Button, Skeleton, cn } from "@recordforge/ui"
import { acquireTitlePreviewEngine, claimTitlePreviewPlayback } from "./title-preview-engine"
import {
  createTitlePreviewPlan,
  TITLE_PREVIEW_STILL_MS,
  type TitleReplaceOptions,
} from "./title-preview-plan"

export interface TitlePreviewProps {
  preset: TextPresetRecord
  previewClip?: TextClip
  canvasWidth?: number
  canvasHeight?: number
  options?: TitleReplaceOptions
  playing?: boolean
  /** Explicit replay bypasses reduced motion; passive hover never does. */
  explicitPlayback?: boolean
  replayKey?: number
  timeMs?: number
  onTimeChange?: (timeMs: number) => void
  onPlaybackEnd?: () => void
  background?: "neutral" | "light"
  className?: string
  interactiveRetry?: boolean
}

export const TitlePreview = memo(function TitlePreview({
  preset,
  previewClip,
  canvasWidth = 1920,
  canvasHeight = 1080,
  options,
  playing = false,
  explicitPlayback = false,
  replayKey = 0,
  timeMs = TITLE_PREVIEW_STILL_MS,
  onTimeChange,
  onPlaybackEnd,
  background = "neutral",
  className,
  interactiveRetry = true,
}: TitlePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<OverlayEngine | null>(null)
  const callbacks = useRef({ onTimeChange, onPlaybackEnd })
  callbacks.current = { onTimeChange, onPlaybackEnd }
  const [visible, setVisible] = useState(false)
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden)
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  )
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [retry, setRetry] = useState(0)
  const timeKey = playing ? 0 : timeMs

  const plan = useMemo(() => {
    try {
      return createTitlePreviewPlan({ preset, previewClip, canvasWidth, canvasHeight, options })
    } catch {
      return null
    }
  }, [preset, previewClip, canvasWidth, canvasHeight, options])
  const durationMs = plan?.items[0]?.endMs ?? 4000

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    if (containerRef.current) observer.observe(containerRef.current)
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const handleMotion = () => setReducedMotion(media.matches)
    const handleVisibility = () => setDocumentVisible(!document.hidden)
    media.addEventListener("change", handleMotion)
    document.addEventListener("visibilitychange", handleVisibility)
    return () => {
      observer.disconnect()
      media.removeEventListener("change", handleMotion)
      document.removeEventListener("visibilitychange", handleVisibility)
    }
  }, [])

  useEffect(() => {
    if (!visible || !documentVisible) return
    if (!plan) {
      setStatus("error")
      return
    }
    let cancelled = false
    setStatus("loading")
    const handle = acquireTitlePreviewEngine(plan)
    void handle.engine.then(
      (engine) => {
        if (cancelled) return
        engineRef.current = engine
        setStatus("ready")
      },
      () => {
        if (!cancelled) setStatus("error")
      },
    )
    return () => {
      cancelled = true
      engineRef.current = null
      handle.release()
    }
  }, [plan, visible, documentVisible, retry])

  useEffect(() => {
    const engine = engineRef.current
    const canvas = canvasRef.current
    if (!engine || !canvas || status !== "ready" || !visible || !documentVisible) return
    // Render all coordinates through the same fit transform, including canonical glyph paths.
    canvas.width = Math.min(640, canvasWidth)
    canvas.height = Math.max(1, Math.round((canvas.width * canvasHeight) / canvasWidth))
    function draw(at: number) {
      if (!canvas || !engine) return false
      try {
        const context = canvas.getContext("2d")
        if (!context) throw new Error("Canvas unavailable")
        context.resetTransform()
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.setTransform(canvas.width / canvasWidth, 0, 0, canvas.height / canvasHeight, 0, 0)
        renderOverlayDisplayList(engine.evaluate(at), canvas)
        return true
      } catch {
        setStatus("error")
        return false
      }
    }
    const still = Math.max(0, Math.min(timeKey, durationMs - 1))
    draw(still)
    if (!playing || (reducedMotion && !explicitPlayback)) return
    let frame = 0
    let stopped = false
    let started: number | undefined
    let previous = 0
    const release = claimTitlePreviewPlayback(() => {
      stopped = true
      cancelAnimationFrame(frame)
      callbacks.current.onPlaybackEnd?.()
    })
    function tick(now: number) {
      if (stopped) return
      started ??= now
      const at = Math.min(now - started, durationMs - 1)
      // 30 fps is plenty for library previews and avoids stressing low-end editors.
      if (now - previous >= 1000 / 30) {
        previous = now
        if (!draw(at)) {
          release()
          return
        }
        callbacks.current.onTimeChange?.(at)
      }
      if (now - started >= durationMs) {
        release()
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return release
    // Playback reports time outwards; only a paused scrub should restart this effect.
  }, [
    status,
    visible,
    documentVisible,
    plan,
    canvasWidth,
    canvasHeight,
    playing,
    explicitPlayback,
    replayKey,
    reducedMotion,
    timeKey,
    durationMs,
  ])

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative w-full overflow-hidden rounded-md border border-border",
        background === "light" ? "bg-foreground" : "bg-overlay",
        className,
      )}
      style={{ aspectRatio: `${canvasWidth} / ${canvasHeight}` }}
      role="img"
      aria-label={`${preset.name} preview`}
    >
      <canvas ref={canvasRef} className="size-full" aria-hidden />
      {status === "loading" ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      {status === "error" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface text-xs text-muted-foreground">
          <span>Preview unavailable</span>
          {interactiveRetry ? (
            <Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>
              Retry Preview
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
