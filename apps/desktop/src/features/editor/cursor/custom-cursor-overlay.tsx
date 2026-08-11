import { useEffect, useId, useMemo, useState } from "react"
import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import {
  defaultCursorSettings,
  type CursorSettings,
  type CursorTelemetryEvent,
  type CursorTelemetryFile,
} from "@recordforge/contracts"
import {
  findCursorEventAtTime,
  fitCursorPoint,
  isCursorButtonEnabled,
  isCursorClickEdge,
  isCursorIdle,
  normalizeCursorTelemetry,
  smoothCursorPosition,
} from "@recordforge/cursor-core"
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
  sourceTimeMs?: number | null
  cursorSettings?: CursorSettings
  recordingId?: string | null
  // Browser previews may provide a fixture URL. Tauri always resolves the
  // cursor_events asset through the Rust project command.
  telemetryPath?: string | null
  containerWidth: number
  containerHeight: number
  offsetX?: number
  offsetY?: number
  zoomTransform?: string
}

function toAssetUrl(path: string | null): string | null {
  if (!path) return null
  return isTauri() ? convertFileSrc(path) : path
}

export function CustomCursorOverlay({
  playheadMs,
  sourceTimeMs = playheadMs,
  cursorSettings = defaultCursorSettings,
  recordingId,
  telemetryPath,
  containerWidth,
  containerHeight,
  offsetX = 0,
  offsetY = 0,
  zoomTransform,
}: CustomCursorOverlayProps) {
  const [telemetry, setTelemetry] = useState<CursorTelemetryFile | null>(null)
  const [telemetryStatus, setTelemetryStatus] = useState<"loading" | "available" | "unavailable">(
    "loading",
  )
  const instanceId = useId()
  const spotlightMaskId = `spotlight-mask-${instanceId.replace(/:/g, "")}`

  useEffect(() => {
    let isMounted = true
    setTelemetry(null)
    setTelemetryStatus("loading")

    function setValidatedTelemetry(data: unknown): boolean {
      try {
        const normalized = normalizeCursorTelemetry(data)
        if (!isMounted) return false
        setTelemetry(normalized)
        setTelemetryStatus("available")
        return true
      } catch {
        return false
      }
    }

    async function loadTelemetry() {
      if (recordingId && isTauri()) {
        try {
          const res = await invoke<CursorTelemetryFile | null>("get_cursor_telemetry", {
            recordingId,
          })
          if (res && setValidatedTelemetry(res)) return
        } catch {
          // An unavailable asset is a valid project state, not a cursor position.
        }
      }

      if (telemetryPath) {
        const url = toAssetUrl(telemetryPath)
        if (url) {
          try {
            const res = await fetch(url)
            if (res.ok && setValidatedTelemetry(await res.json())) return
          } catch {
            // Browser fixture loading is best effort; no synthetic cursor follows.
          }
        }
      }

      if (isMounted) setTelemetryStatus("unavailable")
    }

    void loadTelemetry()

    return () => {
      isMounted = false
    }
  }, [recordingId, telemetryPath])

  const activeEvent = useMemo<ActiveCursorEvent | null>(() => {
    if (!telemetry || sourceTimeMs === null || sourceTimeMs === undefined) return null
    const lookup = findCursorEventAtTime(telemetry, sourceTimeMs)
    return lookup ? { event: lookup.event, index: lookup.index } : null
  }, [sourceTimeMs, telemetry])

  const fittedPosition = useMemo(() => {
    if (!activeEvent || !telemetry) return null
    const sourcePosition = smoothCursorPosition(telemetry, activeEvent.index, cursorSettings)
    return fitCursorPoint(sourcePosition, telemetry, containerWidth, containerHeight, {
      clampToSource: true,
    })
  }, [activeEvent, containerHeight, containerWidth, cursorSettings, telemetry])

  const isIdle = Boolean(
    activeEvent &&
    telemetry &&
    cursorSettings.autoHideIdle &&
    isCursorIdle(telemetry, activeEvent.index, sourceTimeMs ?? 0, cursorSettings.idleTimeoutMs),
  )
  const isCursorVisible = Boolean(
    cursorSettings.enabled &&
    telemetryStatus === "available" &&
    activeEvent?.event.visible &&
    fittedPosition?.visible &&
    !isIdle,
  )

  const isClicking = useMemo(() => {
    if (!telemetry || sourceTimeMs === null || sourceTimeMs === undefined) return false
    if (cursorSettings.clickFeedback === "none" || !activeEvent) return false
    const events = telemetry.events
    for (let index = Math.max(0, activeEvent.index - 8); index <= activeEvent.index; index++) {
      const event = events[index]
      if (
        isCursorClickEdge(event) &&
        isCursorButtonEnabled(event, cursorSettings) &&
        sourceTimeMs - event.tMs >= 0 &&
        sourceTimeMs - event.tMs < 350
      ) {
        return true
      }
    }
    return false
  }, [activeEvent, cursorSettings, sourceTimeMs, telemetry])

  if (!containerWidth || !containerHeight) return null

  const posX = fittedPosition?.x ?? 0
  const posY = fittedPosition?.y ?? 0
  const scale = cursorSettings.scale ?? 1.0
  const isUnavailable = telemetryStatus === "unavailable"

  return (
    <div
      aria-hidden={!isUnavailable}
      className="pointer-events-none absolute z-20 overflow-hidden rounded-lg"
      style={{
        left: offsetX,
        top: offsetY,
        width: containerWidth,
        height: containerHeight,
        transform: zoomTransform,
        transformOrigin: "center",
      }}
    >
      {isUnavailable ? (
        <div
          role="status"
          aria-live="polite"
          className="absolute left-2 top-2 rounded-md border border-border bg-background/85 px-2 py-1 text-[10px] text-subtle-foreground backdrop-blur"
        >
          Cursor unavailable
        </div>
      ) : null}

      {/* Spotlight mode background mask */}
      {isCursorVisible && cursorSettings.spotlightMode ? (
        <svg className="pointer-events-none absolute inset-0 size-full">
          <defs>
            <mask id={spotlightMaskId}>
              <rect width="100%" height="100%" fill="white" />
              <circle
                cx={posX}
                cy={posY}
                r={cursorSettings.spotlightRadius * (fittedPosition?.scale ?? 1) * scale}
                fill="black"
              />
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
            width: cursorSettings.clickSize * (fittedPosition?.scale ?? 1) * scale,
            height: cursorSettings.clickSize * (fittedPosition?.scale ?? 1) * scale,
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
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          className={cn("drop-shadow", className)}
        >
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
