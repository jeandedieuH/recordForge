import { useEffect, useId, useMemo, useState } from "react"
import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import {
  cursorTelemetryFileSchema,
  defaultCursorSettings,
  type CursorSettings,
  type CursorTelemetryEvent,
  type CursorTelemetryFile,
} from "@recordforge/contracts"
import { isTauri } from "../../../lib/settings"
import { cn } from "@recordforge/ui"

export function isCenterHotspotPreset(preset: string): boolean {
  return preset === "highlighter-circle" || preset === "cyberpunk" || preset === "minimal-dot"
}

interface ActiveCursorEvent {
  event: CursorTelemetryEvent
  index: number
}

interface CustomCursorOverlayProps {
  playheadMs: number
  cursorSettings?: CursorSettings
  recordingId?: string | null
  telemetryPath?: string | null
  containerWidth: number
  containerHeight: number
  offsetX?: number
  offsetY?: number
  sourceWidth?: number
  sourceHeight?: number
}

function toAssetUrl(path: string | null): string | null {
  if (!path) return null
  return isTauri() ? convertFileSrc(path) : path
}

export function CustomCursorOverlay({
  playheadMs,
  cursorSettings = defaultCursorSettings,
  recordingId,
  telemetryPath,
  containerWidth,
  containerHeight,
  offsetX = 0,
  offsetY = 0,
  sourceWidth = 1920,
  sourceHeight = 1080,
}: CustomCursorOverlayProps) {
  const [telemetry, setTelemetry] = useState<CursorTelemetryFile | null>(null)
  const instanceId = useId()
  const spotlightMaskId = `spotlight-mask-${instanceId.replace(/:/g, "")}`

  useEffect(() => {
    let isMounted = true
    setTelemetry(null)

    function setValidatedTelemetry(data: unknown): boolean {
      const parsed = cursorTelemetryFileSchema.safeParse(data)
      if (!parsed.success || !isMounted) return false
      setTelemetry(parsed.data)
      return true
    }

    async function loadTelemetry() {
      if (recordingId && isTauri()) {
        try {
          const res = await invoke<CursorTelemetryFile | null>("get_cursor_telemetry", {
            recordingId,
          })
          if (res && setValidatedTelemetry(res)) return
        } catch {
          // Fall back to the asset URL for browser previews and older sessions.
        }
      }

      if (telemetryPath) {
        const url = toAssetUrl(telemetryPath)
        if (url) {
          try {
            const res = await fetch(url)
            if (res.ok && setValidatedTelemetry(await res.json())) return
          } catch {
            // The overlay can still render its deterministic fallback position.
          }
        }
      }

      if (isMounted) setTelemetry(null)
    }

    void loadTelemetry()

    return () => {
      isMounted = false
    }
  }, [recordingId, telemetryPath])

  const activeEvent = useMemo<ActiveCursorEvent | null>(() => {
    if (!telemetry || telemetry.events.length === 0) return null
    const events = telemetry.events

    let low = 0
    let high = events.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (events[middle].tMs < playheadMs) low = middle + 1
      else high = middle
    }

    const right = Math.min(low, events.length - 1)
    const left = Math.max(0, right - 1)
    const index =
      Math.abs(events[left].tMs - playheadMs) <= Math.abs(events[right].tMs - playheadMs)
        ? left
        : right
    return { event: events[index], index }
  }, [telemetry, playheadMs])

  const smoothedPosition = useMemo(() => {
    if (!activeEvent) {
      return { x: containerWidth / 2, y: containerHeight / 2, clicked: false }
    }

    const event = activeEvent.event
    const srcW = telemetry?.sourceWidth || sourceWidth || 1920
    const srcH = telemetry?.sourceHeight || sourceHeight || 1080

    const scaleX = containerWidth / srcW
    const scaleY = containerHeight / srcH

    const targetX = event.x * scaleX
    const targetY = event.y * scaleY

    if (!cursorSettings.smoothMovement || !telemetry) {
      return { x: targetX, y: targetY, clicked: event.clicked }
    }

    const events = telemetry.events
    const idx = activeEvent.index
    if (idx <= 0) return { x: targetX, y: targetY, clicked: event.clicked }

    const windowSize = 5
    let sumX = 0
    let sumY = 0
    let totalWeight = 0
    const factor = cursorSettings.smoothFactor ?? 0.25

    for (let i = Math.max(0, idx - windowSize); i <= idx; i++) {
      const weight = Math.pow(1 - factor, idx - i)
      sumX += events[i].x * scaleX * weight
      sumY += events[i].y * scaleY * weight
      totalWeight += weight
    }

    return {
      x: sumX / totalWeight,
      y: sumY / totalWeight,
      clicked: event.clicked,
    }
  }, [
    activeEvent,
    telemetry,
    containerWidth,
    containerHeight,
    sourceWidth,
    sourceHeight,
    cursorSettings.smoothMovement,
    cursorSettings.smoothFactor,
  ])

  const isCursorVisible = activeEvent?.event.visible ?? true

  const isClicking = useMemo(() => {
    if (!telemetry || cursorSettings.clickFeedback === "none") return false
    if (smoothedPosition.clicked) return true
    if (!activeEvent) return false
    const events = telemetry.events
    const idx = activeEvent.index
    for (let i = Math.max(0, idx - 8); i <= idx; i++) {
      if (events[i].clicked && Math.abs(events[i].tMs - playheadMs) < 350) {
        return true
      }
    }
    return false
  }, [telemetry, activeEvent, playheadMs, cursorSettings.clickFeedback, smoothedPosition.clicked])

  if (!containerWidth || !containerHeight) return null

  const posX = smoothedPosition.x
  const posY = smoothedPosition.y
  const scale = cursorSettings.scale ?? 1.0

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-20 overflow-hidden rounded-lg"
      style={{
        left: offsetX,
        top: offsetY,
        width: containerWidth,
        height: containerHeight,
      }}
    >
      {/* Spotlight mode background mask */}
      {isCursorVisible && cursorSettings.spotlightMode ? (
        <svg className="pointer-events-none absolute inset-0 size-full">
          <defs>
            <mask id={spotlightMaskId}>
              <rect width="100%" height="100%" fill="white" />
              <circle cx={posX} cy={posY} r={cursorSettings.spotlightRadius * scale} fill="black" />
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="black"
            fillOpacity={cursorSettings.spotlightDimOpacity ?? 0.5}
            mask={`url(#${spotlightMaskId})`}
          />
        </svg>
      ) : null}

      {/* Click feedback animation (Ripple / Pulse / Spotlight Flash) */}
      {isCursorVisible && isClicking ? (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full"
          style={{
            left: posX,
            top: posY,
            width: cursorSettings.clickSize * scale,
            height: cursorSettings.clickSize * scale,
            backgroundColor:
              cursorSettings.clickFeedback === "spotlight"
                ? cursorSettings.clickColor
                : "transparent",
            borderColor: cursorSettings.clickColor,
            borderStyle: cursorSettings.clickFeedback === "ripple" ? "solid" : "none",
            borderWidth: cursorSettings.clickFeedback === "ripple" ? 3 : 0,
            opacity: 0.75,
          }}
        />
      ) : null}

      {/* Custom Vector Cursor Icon Rendering */}
      {isCursorVisible ? (
        <div
          className="pointer-events-none absolute transition-transform duration-75 ease-out"
          style={{
            left: posX,
            top: posY,
            transform: isCenterHotspotPreset(cursorSettings.preset)
              ? `translate(-50%, -50%) scale(${scale})`
              : `scale(${scale})`,
            transformOrigin: isCenterHotspotPreset(cursorSettings.preset) ? "center" : "top left",
            filter: cursorSettings.shadowEnabled
              ? `drop-shadow(${cursorSettings.shadowOffsetX}px ${cursorSettings.shadowOffsetY}px ${cursorSettings.shadowBlur}px ${cursorSettings.shadowColor})`
              : "none",
          }}
        >
          <RenderCursorPreset
            preset={cursorSettings.preset}
            fillColor={cursorSettings.fillColor}
            fillOpacity={cursorSettings.fillOpacity}
            strokeColor={cursorSettings.strokeColor}
            strokeWidth={cursorSettings.strokeWidth}
            strokeOpacity={cursorSettings.strokeOpacity}
          />
        </div>
      ) : null}
    </div>
  )
}

interface RenderCursorPresetProps {
  preset: string
  fillColor?: string
  fillOpacity?: number
  strokeColor?: string
  strokeWidth?: number
  strokeOpacity?: number
  className?: string
  isPreview?: boolean
}

export function RenderCursorPreset({
  preset,
  fillColor = "#3b82f6",
  fillOpacity = 1,
  strokeColor = "#ffffff",
  strokeWidth = 2,
  strokeOpacity = 1,
  className,
  isPreview = false,
}: RenderCursorPresetProps) {
  const commonProps = {
    fill: fillColor,
    fillOpacity,
    stroke: strokeColor,
    strokeWidth,
    strokeOpacity,
  }

  switch (preset) {
    case "modern-neon":
      return (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className={cn("drop-shadow", className)}>
          <g transform={isPreview ? "translate(0.25, 0.25)" : undefined}>
            <path
              d="M3 3L10.5 20.5L13.8 13.8L20.5 10.5L3 3Z"
              {...commonProps}
              strokeLinejoin="round"
            />
            <circle cx="4" cy="4" r="2" fill={strokeColor} opacity={strokeOpacity} />
          </g>
        </svg>
      )

    case "sleek-dark":
      return (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className={className}>
          <path
            d="M3 3L10 21L13.5 13.5L21 10L3 3Z"
            fill="#121212"
            fillOpacity={fillOpacity}
            stroke={strokeColor}
            strokeWidth={Math.max(2, strokeWidth)}
            strokeOpacity={strokeOpacity}
            strokeLinejoin="round"
          />
        </svg>
      )

    case "highlighter-circle":
      return (
        <svg width="28" height="28" viewBox="0 0 32 32" fill="none" className={className}>
          <circle
            cx="16"
            cy="16"
            r="13"
            fill={fillColor}
            fillOpacity={0.35}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeOpacity={strokeOpacity}
          />
          <circle cx="16" cy="16" r="3" fill={strokeColor} opacity={strokeOpacity} />
        </svg>
      )

    case "mac-pro":
      return (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className={className}>
          <g transform={isPreview ? "translate(0.25, 0.25)" : undefined}>
            <path
              d="M3 3L11 20L14 13.5L20.5 10.5L3 3Z"
              fill="#FFFFFF"
              fillOpacity={fillOpacity}
              stroke="#1E1E1E"
              strokeWidth={strokeWidth || 1.5}
              strokeOpacity={strokeOpacity}
              strokeLinejoin="round"
            />
          </g>
        </svg>
      )

    case "cyberpunk":
      return (
        <svg width="28" height="28" viewBox="0 0 32 32" fill="none" className={className}>
          <circle
            cx="16"
            cy="16"
            r="12"
            stroke={fillColor}
            strokeWidth={strokeWidth || 2}
            strokeDasharray="4 2"
          />
          <line x1="16" y1="2" x2="16" y2="8" stroke={strokeColor} strokeWidth="2" />
          <line x1="16" y1="24" x2="16" y2="30" stroke={strokeColor} strokeWidth="2" />
          <line x1="2" y1="16" x2="8" y2="16" stroke={strokeColor} strokeWidth="2" />
          <line x1="24" y1="16" x2="30" y2="16" stroke={strokeColor} strokeWidth="2" />
          <circle cx="16" cy="16" r="3" fill={fillColor} />
        </svg>
      )

    case "minimal-dot":
      return (
        <svg width="28" height="28" viewBox="0 0 20 20" fill="none" className={className}>
          <circle
            cx="10"
            cy="10"
            r="7"
            fill={fillColor}
            fillOpacity={fillOpacity}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeOpacity={strokeOpacity}
          />
        </svg>
      )

    case "hand-pointer":
      return (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className={className}>
          <g transform={isPreview ? "translate(-0.11, 0.15)" : undefined}>
            <path
              d="M10 11V4.5C10 3.67 9.33 3 8.5 3C7.67 3 7 3.67 7 4.5V12.79L5.44 11.23C4.85 10.64 3.9 10.64 3.31 11.23C2.72 11.82 2.72 12.77 3.31 13.36L8.5 18.55C9.88 19.93 11.75 20.7 13.7 20.7H16.5C19.26 20.7 21.5 18.46 21.5 15.7V11.5C21.5 10.67 20.83 10 20 10C19.17 10 18.5 10.67 18.5 11.5V10C18.5 9.17 17.83 8.5 17 8.5C16.17 8.5 15.5 9.17 15.5 10V9.5C15.5 8.67 14.83 8 14 8C13.17 8 12.5 8.67 12.5 9.5V11"
              {...commonProps}
              strokeLinejoin="round"
            />
          </g>
        </svg>
      )

    case "default":
    default:
      return (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className={className}>
          <g transform={isPreview ? "translate(0.5, 0.5)" : undefined}>
            <path
              d="M3 3L10.07 19.97L12.58 12.58L19.97 10.07L3 3Z"
              {...commonProps}
              strokeLinejoin="round"
            />
          </g>
        </svg>
      )
  }
}
