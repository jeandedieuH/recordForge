import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AudioClip, AudioVolumeKeyframe } from "@recordforge/contracts"
import { cn } from "@recordforge/ui"
import { formatTimelineTime } from "./timeline-ruler"

export interface TimelineAudioEnvelopeProps {
  clip: AudioClip
  pixelsPerMs: number
  height: number
  /**
   * Track fader applied on top of the clip gain. The envelope shows the gain
   * the user actually hears so it matches the Audio panel and the export mix.
   */
  trackVolume?: number
  isLocked?: boolean
  onUpdateAudio: (update: {
    volume?: number
    fadeInMs?: number
    fadeOutMs?: number
    volumeKeyframes?: AudioVolumeKeyframe[]
  }) => void
  // The parent keeps the envelope mounted while a drag is in flight — the
  // window-level listeners would otherwise be lost when the pointer leaves
  // the clip bounds.
  onInteractingChange?: (active: boolean) => void
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
  trackVolume = 1,
  isLocked = false,
  onUpdateAudio,
  onInteractingChange,
  className,
}: TimelineAudioEnvelopeProps) {
  const containerRef = useRef<SVGSVGElement | null>(null)
  const [activeDrag, setActiveDrag] = useState<DragMode | null>(null)
  const [hudMessage, setHudMessage] = useState<string | null>(null)
  const hudTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const trackGain = Math.max(0, Math.min(2, trackVolume))
  // Clip gain including the track fader — the value drawn, heard, and exported.
  const masterGain = Math.max(0, Math.min(2, trackGain * clip.volume))
  // Keyframes are relative shape multipliers, matching the export filter
  // (`kf.volume * clip.volume`); the drawn point is masterGain × kf.volume.
  const keyframeGain = useCallback(
    (volume: number) => Math.max(0, Math.min(2, masterGain * volume)),
    [masterGain],
  )

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
    const sustainedY = volumeToY(masterGain)

    if (clip.volumeKeyframes && clip.volumeKeyframes.length > 0) {
      const sortedKfs = [...clip.volumeKeyframes].sort((a, b) => a.timeMs - b.timeMs)

      // Start point with fade-in if needed
      const firstKf = sortedKfs[0]!
      const firstGain = keyframeGain(firstKf.volume)
      const startVol = clip.fadeInMs > 0 ? 0 : firstGain
      pts.push({ x: 0, y: volumeToY(startVol), timeMs: 0, volume: startVol })

      if (clip.fadeInMs > 0 && clip.fadeInMs < firstKf.timeMs) {
        pts.push({
          x: clip.fadeInMs * pixelsPerMs,
          y: volumeToY(firstGain),
          timeMs: clip.fadeInMs,
          volume: firstGain,
        })
      }

      // Add all keyframes
      for (const kf of sortedKfs) {
        const gain = keyframeGain(kf.volume)
        pts.push({
          x: kf.timeMs * pixelsPerMs,
          y: volumeToY(gain),
          timeMs: kf.timeMs,
          volume: gain,
          id: kf.id,
          isKf: true,
        })
      }

      // End point with fade-out if needed
      const lastKf = sortedKfs[sortedKfs.length - 1]!
      const lastGain = keyframeGain(lastKf.volume)
      const fadeOutStartMs = Math.max(0, clip.durationMs - clip.fadeOutMs)
      if (clip.fadeOutMs > 0 && fadeOutStartMs > lastKf.timeMs) {
        pts.push({
          x: fadeOutStartMs * pixelsPerMs,
          y: volumeToY(lastGain),
          timeMs: fadeOutStartMs,
          volume: lastGain,
        })
      }

      const endVol = clip.fadeOutMs > 0 ? 0 : lastGain
      pts.push({ x: clipWidth, y: volumeToY(endVol), timeMs: clip.durationMs, volume: endVol })
    } else {
      // Standard fade envelope
      const fadeInX = Math.min(clipWidth, clip.fadeInMs * pixelsPerMs)
      const fadeOutStartX = Math.max(fadeInX, (clip.durationMs - clip.fadeOutMs) * pixelsPerMs)

      pts.push({
        x: 0,
        y: clip.fadeInMs > 0 ? volumeToY(0) : sustainedY,
        timeMs: 0,
        volume: clip.fadeInMs > 0 ? 0 : masterGain,
      })
      if (clip.fadeInMs > 0) {
        pts.push({ x: fadeInX, y: sustainedY, timeMs: clip.fadeInMs, volume: masterGain })
      }
      if (clip.fadeOutMs > 0 && fadeOutStartX > fadeInX) {
        pts.push({
          x: fadeOutStartX,
          y: sustainedY,
          timeMs: clip.durationMs - clip.fadeOutMs,
          volume: masterGain,
        })
      }
      pts.push({
        x: clipWidth,
        y: clip.fadeOutMs > 0 ? volumeToY(0) : sustainedY,
        timeMs: clip.durationMs,
        volume: clip.fadeOutMs > 0 ? 0 : masterGain,
      })
    }

    return pts
  }, [
    clip.durationMs,
    clip.fadeInMs,
    clip.fadeOutMs,
    clip.volumeKeyframes,
    clipWidth,
    keyframeGain,
    masterGain,
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
      ? keyframeGain(clip.volumeKeyframes[0]?.volume ?? 1)
      : masterGain,
  )

  const fadeOutX = Math.max(0, (clip.durationMs - (clip.fadeOutMs ?? 0)) * pixelsPerMs)
  const fadeOutY = volumeToY(
    clip.volumeKeyframes && clip.volumeKeyframes.length > 0
      ? keyframeGain(clip.volumeKeyframes[clip.volumeKeyframes.length - 1]?.volume ?? 1)
      : masterGain,
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
      startVolume: masterGain,
      clickTimeMs,
      moved: false,
    })
    onInteractingChange?.(true)
    showHud(`Volume: ${Math.round(masterGain * 100)}% (${volumeToDb(masterGain)})`)
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
    onInteractingChange?.(true)
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
    onInteractingChange?.(true)
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
      startVolume: keyframeGain(kf.volume),
      moved: false,
    })
    onInteractingChange?.(true)
    showHud(
      `Keyframe: ${formatTimelineTime(kf.timeMs)} · ${Math.round(keyframeGain(kf.volume) * 100)}% (${volumeToDb(keyframeGain(kf.volume))})`,
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
          const nextMaster = Math.max(
            0,
            Math.min(2, Math.round((activeDrag.startVolume + deltaVolume) * 100) / 100),
          )
          showHud(`Volume: ${Math.round(nextMaster * 100)}% (${volumeToDb(nextMaster)})`)
          // The envelope shows the effective gain (track fader included), so
          // convert back to the clip's own gain before writing.
          if (trackGain > 0.0001) {
            const nextClipVolume = Math.max(0, Math.min(2, nextMaster / trackGain))
            onUpdateAudio({ volume: Math.round(nextClipVolume * 100) / 100 })
          }
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
        const newEffective = Math.max(
          0,
          Math.min(2, Math.round((activeDrag.startVolume + deltaVol) * 100) / 100),
        )
        // Keyframes store shape multipliers; divide out the clip+track gain.
        const newKfVolume =
          masterGain > 0.0001
            ? Math.max(0, Math.min(2, newEffective / masterGain))
            : (clip.volumeKeyframes?.find((k) => k.id === activeDrag.kfId)?.volume ?? 1)

        showHud(
          `Keyframe: ${formatTimelineTime(newTimeMs)} · ${Math.round(newEffective * 100)}% (${volumeToDb(newEffective)})`,
        )
        const nextKfs = (clip.volumeKeyframes ?? []).map((k) =>
          k.id === activeDrag.kfId ? { ...k, timeMs: newTimeMs, volume: newKfVolume } : k,
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
        const effectiveGain = yToVolume(clickY)
        // Keyframes are relative to the clip+track gain so raising the clip
        // volume later scales the automation instead of flattening it.
        const kfVolume =
          masterGain > 0.0001 ? Math.max(0, Math.min(2, effectiveGain / masterGain)) : 1

        const newKf: AudioVolumeKeyframe = {
          id: crypto.randomUUID(),
          timeMs,
          volume: kfVolume,
        }
        const nextKfs = [...(clip.volumeKeyframes ?? []), newKf].sort((a, b) => a.timeMs - b.timeMs)
        onUpdateAudio({ volumeKeyframes: nextKfs })
        showHud(
          `Added keyframe: ${formatTimelineTime(timeMs)} · ${Math.round(keyframeGain(kfVolume) * 100)}%`,
          1500,
        )
      } else {
        showHud(null)
      }

      setActiveDrag(null)
      onInteractingChange?.(false)
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
    keyframeGain,
    masterGain,
    onUpdateAudio,
    onInteractingChange,
    pixelsPerMs,
    showHud,
    trackGain,
    usableHeight,
    yToVolume,
  ])

  // Unmount mid-drag (clip deleted or un-pinned): release the parent's
  // "keep me mounted" flag so it doesn't pin the envelope forever.
  useEffect(() => () => onInteractingChange?.(false), [onInteractingChange])

  return (
    <div
      className={cn(
        "group/envelope absolute inset-0 size-full pointer-events-none select-none",
        className,
      )}
    >
      <svg
        ref={containerRef}
        className="size-full overflow-visible pointer-events-none text-foreground"
      >
        <defs>
          <linearGradient id={`env-grad-${clip.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.18} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
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
          strokeWidth={1.75}
          className="pointer-events-none stroke-foreground/85 transition-colors group-hover/envelope:stroke-foreground"
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
            <rect
              x={fadeInX - 3.5}
              y={fadeInY - 3.5}
              width={7}
              height={7}
              rx={1.5}
              data-envelope-interactive="true"
              className={cn(
                "fill-lane stroke-background stroke-[1.5px] cursor-ew-resize transition-opacity shadow-xs",
                clip.fadeInMs > 0
                  ? "opacity-100"
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
            <rect
              x={fadeOutX - 3.5}
              y={fadeOutY - 3.5}
              width={7}
              height={7}
              rx={1.5}
              data-envelope-interactive="true"
              className={cn(
                "fill-lane stroke-background stroke-[1.5px] cursor-ew-resize transition-opacity shadow-xs",
                clip.fadeOutMs > 0
                  ? "opacity-100"
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
            const cy = volumeToY(keyframeGain(kf.volume))
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
                {/* Visual Node — grows on hover via transform (SVG r can't be
                    transitioned by a class). */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={4}
                  data-envelope-interactive="true"
                  style={{ transformBox: "fill-box", transformOrigin: "center" }}
                  className="fill-foreground stroke-lane stroke-[1.5px] cursor-move transition-transform duration-fast hover:scale-150 shadow-e1"
                  onPointerDown={(e) => handleKeyframePointerDown(e, kf)}
                  onDoubleClick={(e) => handleKeyframeDoubleClick(e, kf.id)}
                />
              </g>
            )
          })}
      </svg>

      {/* Live Floating Tooltip HUD during envelope interaction */}
      {hudMessage ? (
        <div className="pointer-events-none absolute top-1 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 rounded-full border border-border-strong bg-elevated/95 px-2 py-0.5 font-mono text-[10px] text-foreground shadow-e2 backdrop-blur-md whitespace-nowrap animate-in fade-in zoom-in-95">
          <span className="size-1.5 rounded-full bg-lane" />
          <span>{hudMessage}</span>
        </div>
      ) : null}
    </div>
  )
})
