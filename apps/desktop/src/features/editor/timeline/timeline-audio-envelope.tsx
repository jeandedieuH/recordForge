import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AudioClip, AudioVolumeKeyframe } from "@recordforge/contracts"
import { cn } from "@recordforge/ui"
import { formatTimelineTime } from "./timeline-ruler"

export interface TimelineAudioEnvelopeProps {
  clip: AudioClip
  pixelsPerMs: number
  height: number
  isLocked?: boolean
  onUpdateAudio: (update: {
    volume?: number
    fadeInMs?: number
    fadeOutMs?: number
    volumeKeyframes?: AudioVolumeKeyframe[]
  }) => void
  className?: string
}

type DragMode =
  | {
      type: "volume"
      startX: number
      startY: number
      startVolume: number
      clickTimeMs: number
      moved: boolean
    }
  | {
      type: "fade-in"
      startX: number
      startFadeInMs: number
    }
  | {
      type: "fade-out"
      startX: number
      startFadeOutMs: number
    }
  | {
      type: "keyframe"
      kfId: string
      startX: number
      startY: number
      startTimeMs: number
      startVolume: number
      moved: boolean
    }

function volumeToDb(volume: number): string {
  if (volume <= 0.001) return "-∞ dB"
  const db = 20 * Math.log10(volume)
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`
}

export const TimelineAudioEnvelope = memo(function TimelineAudioEnvelope({
  clip,
  pixelsPerMs,
  height,
  isLocked = false,
  onUpdateAudio,
  className,
}: TimelineAudioEnvelopeProps) {
  const containerRef = useRef<SVGSVGElement | null>(null)
  const [activeDrag, setActiveDrag] = useState<DragMode | null>(null)
  const [hudMessage, setHudMessage] = useState<string | null>(null)
  const hudTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const showHud = useCallback((message: string | null, autoHideMs?: number) => {
    if (hudTimeoutRef.current) {
      clearTimeout(hudTimeoutRef.current)
      hudTimeoutRef.current = null
    }
    setHudMessage(message)
    if (message && autoHideMs) {
      hudTimeoutRef.current = setTimeout(() => {
        setHudMessage(null)
      }, autoHideMs)
    }
  }, [])

  const clipWidth = Math.max(1, clip.durationMs * pixelsPerMs)
  const padY = 6
  const usableHeight = Math.max(10, height - padY * 2)

  const volumeToY = useCallback(
    (vol: number): number => {
      const clampedVol = Math.max(0, Math.min(2, vol))
      // vol 0 = bottom, vol 1 = mid, vol 2 = top
      return padY + usableHeight * (1 - clampedVol / 2)
    },
    [padY, usableHeight],
  )

  const yToVolume = useCallback(
    (y: number): number => {
      const ratio = 1 - (y - padY) / usableHeight
      return Math.max(0, Math.min(2, Math.round(ratio * 2 * 100) / 100))
    },
    [padY, usableHeight],
  )

  // Compute curve points
  const points = useMemo(() => {
    const pts: Array<{
      x: number
      y: number
      timeMs: number
      volume: number
      id?: string
      isKf?: boolean
    }> = []
    const sustainedY = volumeToY(clip.volume)

    if (clip.volumeKeyframes && clip.volumeKeyframes.length > 0) {
      const sortedKfs = [...clip.volumeKeyframes].sort((a, b) => a.timeMs - b.timeMs)

      // Start point with fade-in if needed
      const firstKf = sortedKfs[0]
      const startVol = clip.fadeInMs > 0 ? 0 : firstKf.volume
      pts.push({ x: 0, y: volumeToY(startVol), timeMs: 0, volume: startVol })

      if (clip.fadeInMs > 0 && clip.fadeInMs < firstKf.timeMs) {
        pts.push({
          x: clip.fadeInMs * pixelsPerMs,
          y: volumeToY(firstKf.volume),
          timeMs: clip.fadeInMs,
          volume: firstKf.volume,
        })
      }

      // Add all keyframes
      for (const kf of sortedKfs) {
        pts.push({
          x: kf.timeMs * pixelsPerMs,
          y: volumeToY(kf.volume),
          timeMs: kf.timeMs,
          volume: kf.volume,
          id: kf.id,
          isKf: true,
        })
      }

      // End point with fade-out if needed
      const lastKf = sortedKfs[sortedKfs.length - 1]
      const fadeOutStartMs = Math.max(0, clip.durationMs - clip.fadeOutMs)
      if (clip.fadeOutMs > 0 && fadeOutStartMs > lastKf.timeMs) {
        pts.push({
          x: fadeOutStartMs * pixelsPerMs,
          y: volumeToY(lastKf.volume),
          timeMs: fadeOutStartMs,
          volume: lastKf.volume,
        })
      }

      const endVol = clip.fadeOutMs > 0 ? 0 : lastKf.volume
      pts.push({ x: clipWidth, y: volumeToY(endVol), timeMs: clip.durationMs, volume: endVol })
    } else {
      // Standard fade envelope
      const fadeInX = Math.min(clipWidth, clip.fadeInMs * pixelsPerMs)
      const fadeOutStartX = Math.max(fadeInX, (clip.durationMs - clip.fadeOutMs) * pixelsPerMs)

      pts.push({
        x: 0,
        y: clip.fadeInMs > 0 ? volumeToY(0) : sustainedY,
        timeMs: 0,
        volume: clip.fadeInMs > 0 ? 0 : clip.volume,
      })
      if (clip.fadeInMs > 0) {
        pts.push({ x: fadeInX, y: sustainedY, timeMs: clip.fadeInMs, volume: clip.volume })
      }
      if (clip.fadeOutMs > 0 && fadeOutStartX > fadeInX) {
        pts.push({
          x: fadeOutStartX,
          y: sustainedY,
          timeMs: clip.durationMs - clip.fadeOutMs,
          volume: clip.volume,
        })
      }
      pts.push({
        x: clipWidth,
        y: clip.fadeOutMs > 0 ? volumeToY(0) : sustainedY,
        timeMs: clip.durationMs,
        volume: clip.fadeOutMs > 0 ? 0 : clip.volume,
      })
    }

    return pts
  }, [
    clip.durationMs,
    clip.fadeInMs,
    clip.fadeOutMs,
    clip.volume,
    clip.volumeKeyframes,
    clipWidth,
    pixelsPerMs,
    volumeToY,
  ])

  // Build SVG path strings
  const svgPathData = useMemo(() => {
    if (points.length === 0) return ""
    return points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ")
  }, [points])

  const svgAreaPathData = useMemo(() => {
    if (points.length === 0) return ""
    const linePath = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ")
    return `${linePath} L ${clipWidth.toFixed(1)} ${height} L 0 ${height} Z`
  }, [clipWidth, height, points])

  // Fade handle positions (always present)
  const fadeInX = (clip.fadeInMs ?? 0) * pixelsPerMs
  const fadeInY = volumeToY(
    clip.volumeKeyframes && clip.volumeKeyframes.length > 0
      ? (clip.volumeKeyframes[0]?.volume ?? clip.volume)
      : clip.volume,
  )

  const fadeOutX = Math.max(0, (clip.durationMs - (clip.fadeOutMs ?? 0)) * pixelsPerMs)
  const fadeOutY = volumeToY(
    clip.volumeKeyframes && clip.volumeKeyframes.length > 0
      ? (clip.volumeKeyframes[clip.volumeKeyframes.length - 1]?.volume ?? clip.volume)
      : clip.volume,
  )

  // Handlers for starting drags
  function handleVolumeLinePointerDown(e: React.PointerEvent) {
    if (isLocked || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    const clickX = rect ? e.clientX - rect.left : 0
    const clickTimeMs = Math.max(0, Math.min(clip.durationMs, Math.round(clickX / pixelsPerMs)))

    setActiveDrag({
      type: "volume",
      startX: e.clientX,
      startY: e.clientY,
      startVolume: clip.volume,
      clickTimeMs,
      moved: false,
    })
    showHud(`Volume: ${Math.round(clip.volume * 100)}% (${volumeToDb(clip.volume)})`)
  }

  function handleFadeInPointerDown(e: React.PointerEvent) {
    if (isLocked || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    setActiveDrag({
      type: "fade-in",
      startX: e.clientX,
      startFadeInMs: clip.fadeInMs ?? 0,
    })
    showHud(`Fade In: ${((clip.fadeInMs ?? 0) / 1000).toFixed(2)}s`)
  }

  function handleFadeOutPointerDown(e: React.PointerEvent) {
    if (isLocked || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    setActiveDrag({
      type: "fade-out",
      startX: e.clientX,
      startFadeOutMs: clip.fadeOutMs ?? 0,
    })
    showHud(`Fade Out: ${((clip.fadeOutMs ?? 0) / 1000).toFixed(2)}s`)
  }

  function handleKeyframePointerDown(e: React.PointerEvent, kf: AudioVolumeKeyframe) {
    if (isLocked || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    setActiveDrag({
      type: "keyframe",
      kfId: kf.id,
      startX: e.clientX,
      startY: e.clientY,
      startTimeMs: kf.timeMs,
      startVolume: kf.volume,
      moved: false,
    })
    showHud(
      `Keyframe: ${formatTimelineTime(kf.timeMs)} · ${Math.round(kf.volume * 100)}% (${volumeToDb(kf.volume)})`,
    )
  }

  function handleKeyframeDoubleClick(e: React.MouseEvent, kfId: string) {
    if (isLocked) return
    e.stopPropagation()
    e.preventDefault()
    const nextKfs = (clip.volumeKeyframes ?? []).filter((k) => k.id !== kfId)
    onUpdateAudio({ volumeKeyframes: nextKfs })
    showHud("Deleted keyframe", 1200)
  }

  // Window pointer move and up listeners while dragging
  useEffect(() => {
    if (!activeDrag) return

    function onPointerMove(e: PointerEvent) {
      if (!activeDrag) return
      e.preventDefault()
      e.stopPropagation()

      if (activeDrag.type === "volume") {
        const deltaX = e.clientX - activeDrag.startX
        const deltaY = e.clientY - activeDrag.startY
        if (Math.hypot(deltaX, deltaY) > 3) {
          activeDrag.moved = true
        }

        if (activeDrag.moved) {
          const deltaVolume = -(deltaY / usableHeight) * 2
          const newVolume = Math.max(
            0,
            Math.min(2, Math.round((activeDrag.startVolume + deltaVolume) * 100) / 100),
          )
          showHud(`Volume: ${Math.round(newVolume * 100)}% (${volumeToDb(newVolume)})`)
          onUpdateAudio({ volume: newVolume })
        }
        return
      }

      if (activeDrag.type === "fade-in") {
        const deltaX = e.clientX - activeDrag.startX
        const deltaMs = deltaX / pixelsPerMs
        const maxFade = clip.durationMs - clip.fadeOutMs
        const rawFade = activeDrag.startFadeInMs + deltaMs
        // Snapping: if near 0 (< 25ms), snap to 0
        const newFadeIn = rawFade < 25 ? 0 : Math.max(0, Math.min(maxFade, Math.round(rawFade)))
        showHud(`Fade In: ${(newFadeIn / 1000).toFixed(2)}s`)
        onUpdateAudio({ fadeInMs: newFadeIn })
        return
      }

      if (activeDrag.type === "fade-out") {
        const deltaX = -(e.clientX - activeDrag.startX)
        const deltaMs = deltaX / pixelsPerMs
        const maxFade = clip.durationMs - clip.fadeInMs
        const rawFade = activeDrag.startFadeOutMs + deltaMs
        // Snapping: if near 0 (< 25ms), snap to 0
        const newFadeOut = rawFade < 25 ? 0 : Math.max(0, Math.min(maxFade, Math.round(rawFade)))
        showHud(`Fade Out: ${(newFadeOut / 1000).toFixed(2)}s`)
        onUpdateAudio({ fadeOutMs: newFadeOut })
        return
      }

      if (activeDrag.type === "keyframe") {
        const deltaX = e.clientX - activeDrag.startX
        const deltaY = e.clientY - activeDrag.startY
        if (Math.hypot(deltaX, deltaY) > 3) {
          activeDrag.moved = true
        }

        const deltaMs = deltaX / pixelsPerMs
        const deltaVol = -(deltaY / usableHeight) * 2

        const newTimeMs = Math.max(
          0,
          Math.min(clip.durationMs, Math.round(activeDrag.startTimeMs + deltaMs)),
        )
        const newVol = Math.max(
          0,
          Math.min(2, Math.round((activeDrag.startVolume + deltaVol) * 100) / 100),
        )

        showHud(
          `Keyframe: ${formatTimelineTime(newTimeMs)} · ${Math.round(newVol * 100)}% (${volumeToDb(newVol)})`,
        )
        const nextKfs = (clip.volumeKeyframes ?? []).map((k) =>
          k.id === activeDrag.kfId ? { ...k, timeMs: newTimeMs, volume: newVol } : k,
        )
        onUpdateAudio({ volumeKeyframes: nextKfs })
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (!activeDrag) return
      e.preventDefault()
      e.stopPropagation()

      // If volume line was clicked without moving: Add keyframe!
      if (activeDrag.type === "volume" && !activeDrag.moved) {
        const rect = containerRef.current?.getBoundingClientRect()
        const clickX = rect ? activeDrag.startX - rect.left : 0
        const clickY = rect ? activeDrag.startY - rect.top : usableHeight / 2
        const timeMs = Math.max(0, Math.min(clip.durationMs, Math.round(clickX / pixelsPerMs)))
        const volume = yToVolume(clickY)

        const newKf: AudioVolumeKeyframe = {
          id: crypto.randomUUID(),
          timeMs,
          volume,
        }
        const nextKfs = [...(clip.volumeKeyframes ?? []), newKf].sort((a, b) => a.timeMs - b.timeMs)
        onUpdateAudio({ volumeKeyframes: nextKfs })
        showHud(
          `Added keyframe: ${formatTimelineTime(timeMs)} · ${Math.round(volume * 100)}%`,
          1500,
        )
      } else {
        showHud(null)
      }

      setActiveDrag(null)
    }

    window.addEventListener("pointermove", onPointerMove, { capture: true })
    window.addEventListener("pointerup", onPointerUp, { capture: true })
    window.addEventListener("pointercancel", onPointerUp, { capture: true })

    return () => {
      window.removeEventListener("pointermove", onPointerMove, { capture: true })
      window.removeEventListener("pointerup", onPointerUp, { capture: true })
      window.removeEventListener("pointercancel", onPointerUp, { capture: true })
    }
  }, [
    activeDrag,
    clip.durationMs,
    clip.fadeInMs,
    clip.fadeOutMs,
    clip.volumeKeyframes,
    onUpdateAudio,
    pixelsPerMs,
    showHud,
    usableHeight,
    yToVolume,
  ])

  return (
    <div
      className={cn(
        "group/envelope absolute inset-0 size-full pointer-events-none select-none",
        className,
      )}
    >
      <svg ref={containerRef} className="size-full overflow-visible pointer-events-none">
        <defs>
          <linearGradient id={`env-grad-${clip.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(245, 158, 11, 0.28)" />
            <stop offset="100%" stopColor="rgba(245, 158, 11, 0.02)" />
          </linearGradient>
        </defs>

        {/* Shaded Area Beneath Envelope Curve */}
        <path
          d={svgAreaPathData}
          fill={`url(#env-grad-${clip.id})`}
          className="pointer-events-none"
        />

        {/* Illuminated Volume Envelope Line (Visual) */}
        <path
          d={svgPathData}
          fill="none"
          stroke="rgba(245, 158, 11, 0.85)"
          strokeWidth={1.75}
          className="pointer-events-none transition-colors group-hover/envelope:stroke-amber-400 group-hover/envelope:filter-[drop-shadow(0_0_4px_rgba(245,158,11,0.6))]"
        />

        {/* Generous Hit Testing Path for Volume Line & Click-to-add-keyframe */}
        {!isLocked ? (
          <path
            d={svgPathData}
            fill="none"
            stroke="transparent"
            strokeWidth={16}
            strokeLinecap="round"
            strokeLinejoin="round"
            data-envelope-interactive="true"
            className="cursor-ns-resize pointer-events-auto"
            onPointerDown={handleVolumeLinePointerDown}
          />
        ) : null}

        {/* Fade-In Control Handle (Always Accessible at Left Edge) */}
        {!isLocked ? (
          <g data-envelope-interactive="true" className="group/fade-in pointer-events-auto">
            {/* Expanded Hit Circle */}
            <circle
              cx={fadeInX}
              cy={fadeInY}
              r={12}
              fill="transparent"
              data-envelope-interactive="true"
              className="cursor-ew-resize"
              onPointerDown={handleFadeInPointerDown}
            />
            {/* Visual Handle */}
            <circle
              cx={fadeInX}
              cy={fadeInY}
              r={clip.fadeInMs > 0 ? 4 : 3}
              data-envelope-interactive="true"
              className={cn(
                "fill-amber-400 stroke-surface stroke-[1.5px] cursor-ew-resize transition-all shadow-xs",
                clip.fadeInMs > 0
                  ? "opacity-100 ring-1 ring-amber-500/50"
                  : "opacity-40 group-hover/envelope:opacity-90 hover:opacity-100",
              )}
              onPointerDown={handleFadeInPointerDown}
            />
          </g>
        ) : null}

        {/* Fade-Out Control Handle (Always Accessible at Right Edge) */}
        {!isLocked ? (
          <g data-envelope-interactive="true" className="group/fade-out pointer-events-auto">
            {/* Expanded Hit Circle */}
            <circle
              cx={fadeOutX}
              cy={fadeOutY}
              r={12}
              fill="transparent"
              data-envelope-interactive="true"
              className="cursor-ew-resize"
              onPointerDown={handleFadeOutPointerDown}
            />
            {/* Visual Handle */}
            <circle
              cx={fadeOutX}
              cy={fadeOutY}
              r={clip.fadeOutMs > 0 ? 4 : 3}
              data-envelope-interactive="true"
              className={cn(
                "fill-amber-400 stroke-surface stroke-[1.5px] cursor-ew-resize transition-all shadow-xs",
                clip.fadeOutMs > 0
                  ? "opacity-100 ring-1 ring-amber-500/50"
                  : "opacity-40 group-hover/envelope:opacity-90 hover:opacity-100",
              )}
              onPointerDown={handleFadeOutPointerDown}
            />
          </g>
        ) : null}

        {/* Custom Volume Keyframe Nodes */}
        {!isLocked &&
          (clip.volumeKeyframes ?? []).map((kf) => {
            const cx = kf.timeMs * pixelsPerMs
            const cy = volumeToY(kf.volume)
            return (
              <g
                key={kf.id}
                data-envelope-interactive="true"
                className="group/keyframe pointer-events-auto"
              >
                {/* Expanded Hit Circle */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={12}
                  fill="transparent"
                  data-envelope-interactive="true"
                  className="cursor-move"
                  onPointerDown={(e) => handleKeyframePointerDown(e, kf)}
                  onDoubleClick={(e) => handleKeyframeDoubleClick(e, kf.id)}
                />
                {/* Visual Node */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={4.5}
                  data-envelope-interactive="true"
                  className="fill-white stroke-amber-500 stroke-[2px] cursor-move hover:r-6 hover:fill-amber-300 transition-all shadow-e1"
                  onPointerDown={(e) => handleKeyframePointerDown(e, kf)}
                  onDoubleClick={(e) => handleKeyframeDoubleClick(e, kf.id)}
                />
              </g>
            )
          })}
      </svg>

      {/* Live Floating Tooltip HUD during envelope interaction */}
      {hudMessage ? (
        <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 rounded-full border border-amber-500/90 bg-surface/95 px-2.5 py-0.5 font-mono text-[10px] font-bold text-foreground shadow-e3 backdrop-blur-md whitespace-nowrap animate-in fade-in zoom-in-95">
          <span className="text-amber-400">●</span>
          <span>{hudMessage}</span>
        </div>
      ) : null}
    </div>
  )
})
