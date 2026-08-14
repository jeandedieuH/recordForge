import * as PopoverPrimitive from "@radix-ui/react-popover"
import { Check, Copy, Pipette } from "lucide-react"
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { cn } from "../../lib/cn"

// --- Pure Color Conversion Utilities ---

interface HsvColor {
  h: number // 0 - 360
  s: number // 0 - 1
  v: number // 0 - 1
  a: number // 0 - 1
}

interface RgbColor {
  r: number // 0 - 255
  g: number // 0 - 255
  b: number // 0 - 255
  a: number // 0 - 1
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  transparent: "#00000000",
  red: "#ef4444",
  blue: "#3b82f6",
  green: "#10b981",
  yellow: "#f59e0b",
}

export function parseColorToRgb(input: string): RgbColor {
  const trimmed = input.trim().toLowerCase()
  if (NAMED_COLORS[trimmed]) {
    return parseColorToRgb(NAMED_COLORS[trimmed])
  }

  // Hex: #rgb, #rgba, #rrggbb, #rrggbbaa
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16) || 0
      const g = parseInt(hex[1] + hex[1], 16) || 0
      const b = parseInt(hex[2] + hex[2], 16) || 0
      const a = hex.length === 4 ? (parseInt(hex[3] + hex[3], 16) || 0) / 255 : 1
      return { r, g, b, a }
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16) || 0
      const g = parseInt(hex.slice(2, 4), 16) || 0
      const b = parseInt(hex.slice(4, 6), 16) || 0
      const a = hex.length === 8 ? (parseInt(hex.slice(6, 8), 16) || 0) / 255 : 1
      return { r, g, b, a }
    }
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = trimmed.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/)
  if (rgbMatch) {
    const r = Math.min(255, Math.max(0, parseFloat(rgbMatch[1])))
    const g = Math.min(255, Math.max(0, parseFloat(rgbMatch[2])))
    const b = Math.min(255, Math.max(0, parseFloat(rgbMatch[3])))
    const a = rgbMatch[4] !== undefined ? Math.min(1, Math.max(0, parseFloat(rgbMatch[4]))) : 1
    return { r, g, b, a }
  }

  // Default fallback to black
  return { r: 0, g: 0, b: 0, a: 1 }
}

export function rgbToHsv({ r, g, b, a }: RgbColor): HsvColor {
  const normR = r / 255
  const normG = g / 255
  const normB = b / 255

  const max = Math.max(normR, normG, normB)
  const min = Math.min(normR, normG, normB)
  const delta = max - min

  let h = 0
  if (delta !== 0) {
    if (max === normR) {
      h = ((normG - normB) / delta + (normG < normB ? 6 : 0)) * 60
    } else if (max === normG) {
      h = ((normB - normR) / delta + 2) * 60
    } else {
      h = ((normR - normG) / delta + 4) * 60
    }
  }

  const s = max === 0 ? 0 : delta / max
  const v = max

  return { h, s, v, a }
}

export function hsvToRgb({ h, s, v, a }: HsvColor): RgbColor {
  const c = v * s
  const normH = ((h % 360) + 360) % 360
  const x = c * (1 - Math.abs(((normH / 60) % 2) - 1))
  const m = v - c

  let rPrime = 0
  let gPrime = 0
  let bPrime = 0

  if (normH < 60) {
    rPrime = c
    gPrime = x
    bPrime = 0
  } else if (normH < 120) {
    rPrime = x
    gPrime = c
    bPrime = 0
  } else if (normH < 180) {
    rPrime = 0
    gPrime = c
    bPrime = x
  } else if (normH < 240) {
    rPrime = 0
    gPrime = x
    bPrime = c
  } else if (normH < 300) {
    rPrime = x
    gPrime = 0
    bPrime = c
  } else {
    rPrime = c
    gPrime = 0
    bPrime = x
  }

  return {
    r: Math.round((rPrime + m) * 255),
    g: Math.round((gPrime + m) * 255),
    b: Math.round((bPrime + m) * 255),
    a,
  }
}

export function rgbToHex({ r, g, b, a }: RgbColor, includeAlpha = false): string {
  const hexR = Math.round(r).toString(16).padStart(2, "0")
  const hexG = Math.round(g).toString(16).padStart(2, "0")
  const hexB = Math.round(b).toString(16).padStart(2, "0")

  if (includeAlpha && a < 0.999) {
    const hexA = Math.round(a * 255).toString(16).padStart(2, "0")
    return `#${hexR}${hexG}${hexB}${hexA}`
  }

  return `#${hexR}${hexG}${hexB}`
}

export function formatHexDisplay(hex: string): string {
  return hex.toUpperCase()
}

// Default video-production and studio background presets
export const DEFAULT_COLOR_PRESETS = [
  "#000000", // Pitch Black (Clean Canvas)
  "#090e1a", // Charcoal Navy (recordForge Dim)
  "#0c1220", // Deep Navy (recordForge Surface)
  "#182438", // Midnight Container
  "#334155", // Slate Blue
  "#ffffff", // Clean White
  "#094db2", // Primary Accent Blue
  "#38bdf8", // Sky Blue
  "#10b981", // Emerald Green
  "#8b5cf6", // Purple Accent
  "#ef4444", // Recording Red
  "#f59e0b", // Warm Amber
]

const RECENT_COLORS_STORAGE_KEY = "recordforge:recent-colors"
const MAX_RECENT_COLORS = 6

function getStoredRecentColors(): string[] {
  try {
    const item = localStorage.getItem(RECENT_COLORS_STORAGE_KEY)
    if (!item) return []
    const parsed = JSON.parse(item)
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT_COLORS) : []
  } catch {
    return []
  }
}

function saveRecentColor(color: string) {
  try {
    const existing = getStoredRecentColors().filter(
      (c) => c.toLowerCase() !== color.toLowerCase(),
    )
    const updated = [color, ...existing].slice(0, MAX_RECENT_COLORS)
    localStorage.setItem(RECENT_COLORS_STORAGE_KEY, JSON.stringify(updated))
  } catch {
    // Ignore localStorage errors
  }
}

// --- Component Interfaces ---

export interface ColorPickerProps {
  value?: string
  onChange?: (value: string) => void
  allowAlpha?: boolean
  presets?: string[]
  showRecent?: boolean
  disabled?: boolean
  className?: string
  triggerClassName?: string
  size?: "sm" | "default" | "lg"
  "aria-label"?: string
  placeholder?: string
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
  sideOffset?: number
}

export interface ColorSwatchProps extends ComponentProps<"button"> {
  color: string
  size?: "sm" | "default" | "lg"
  active?: boolean
  showLabel?: boolean
}

// --- Color Swatch Primitive ---

export function ColorSwatch({
  color,
  size = "default",
  active,
  showLabel = false,
  className,
  ...props
}: ColorSwatchProps) {
  const sizeClasses = {
    sm: "size-5 rounded",
    default: "size-6 rounded-md",
    lg: "size-8 rounded-lg",
  }[size]

  return (
    <button
      type="button"
      className={cn(
        "group relative flex items-center gap-2 overflow-hidden border border-border/80 bg-surface p-0.5 text-xs text-foreground transition-all duration-fast ease-forge hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:opacity-50",
        active && "border-accent ring-2 ring-accent/30",
        showLabel ? "w-full justify-start rounded-md px-2 py-1" : sizeClasses,
        className,
      )}
      {...props}
    >
      {/* Checkerboard backdrop for alpha transparency */}
      <span
        className={cn(
          "relative block shrink-0 overflow-hidden rounded-[3px] border border-border-strong/50 shadow-inner",
          showLabel ? "size-4" : "h-full w-full",
        )}
        style={{
          backgroundImage:
            "linear-gradient(45deg, #25354f 25%, transparent 25%), linear-gradient(-45deg, #25354f 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #25354f 75%), linear-gradient(-45deg, transparent 75%, #25354f 75%)",
          backgroundSize: "8px 8px",
          backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0",
        }}
      >
        <span
          className="absolute inset-0 block transition-colors duration-fast"
          style={{ backgroundColor: color }}
        />
      </span>
      {showLabel && (
        <span className="truncate font-mono text-[11px] text-foreground">
          {formatHexDisplay(color)}
        </span>
      )}
    </button>
  )
}

// --- Main ColorPicker Component ---

export function ColorPicker({
  value = "#000000",
  onChange,
  allowAlpha = false,
  presets = DEFAULT_COLOR_PRESETS,
  showRecent = true,
  disabled = false,
  className,
  triggerClassName,
  size = "default",
  "aria-label": ariaLabel = "Color picker",
  align = "end",
  side = "bottom",
  sideOffset = 6,
}: ColorPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [recentColors, setRecentColors] = useState<string[]>([])

  // Parse incoming value to HSV
  const currentRgb = useMemo(() => parseColorToRgb(value), [value])
  const currentHsv = useMemo(() => rgbToHsv(currentRgb), [currentRgb])

  // Internal state for smooth drag interactions
  const [internalHsv, setInternalHsv] = useState<HsvColor>(currentHsv)
  const [hexInput, setHexInput] = useState(() =>
    formatHexDisplay(rgbToHex(currentRgb, allowAlpha)),
  )

  // Sync internal state when controlled value prop updates
  useEffect(() => {
    setInternalHsv(currentHsv)
    setHexInput(formatHexDisplay(rgbToHex(currentRgb, allowAlpha)))
  }, [currentHsv, currentRgb, allowAlpha])

  // Refresh recent colors when popover opens
  useEffect(() => {
    if (isOpen && showRecent) {
      setRecentColors(getStoredRecentColors())
    }
  }, [isOpen, showRecent])

  // Commit color change helper
  const commitColor = useCallback(
    (hsv: HsvColor) => {
      setInternalHsv(hsv)
      const rgb = hsvToRgb(hsv)
      const hex = rgbToHex(rgb, allowAlpha)
      setHexInput(formatHexDisplay(hex))
      onChange?.(hex)
    },
    [allowAlpha, onChange],
  )

  // Commit and save to recent history when user completes selection
  const handleFinalizeColor = useCallback(
    (finalHex: string) => {
      saveRecentColor(finalHex)
      if (showRecent) {
        setRecentColors(getStoredRecentColors())
      }
    },
    [showRecent],
  )

  // 2D Saturation / Brightness Canvas Drag Handling
  const satValCanvasRef = useRef<HTMLDivElement>(null)
  const isDraggingSatVal = useRef(false)

  const updateSatValFromPointer = useCallback(
    (e: React.PointerEvent<HTMLDivElement> | PointerEvent) => {
      if (!satValCanvasRef.current) return
      const rect = satValCanvasRef.current.getBoundingClientRect()
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
      const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top))

      const s = x / rect.width
      const v = 1 - y / rect.height

      const newHsv = { ...internalHsv, s, v }
      commitColor(newHsv)
    },
    [internalHsv, commitColor],
  )

  const handleSatValPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    isDraggingSatVal.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    updateSatValFromPointer(e)
  }

  const handleSatValPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingSatVal.current) {
      updateSatValFromPointer(e)
    }
  }

  const handleSatValPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingSatVal.current) {
      isDraggingSatVal.current = false
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore if pointer capture already lost
      }
      const hex = rgbToHex(hsvToRgb(internalHsv), allowAlpha)
      handleFinalizeColor(hex)
    }
  }

  // Hue Slider Drag Handling
  const hueTrackRef = useRef<HTMLDivElement>(null)
  const isDraggingHue = useRef(false)

  const updateHueFromPointer = useCallback(
    (e: React.PointerEvent<HTMLDivElement> | PointerEvent) => {
      if (!hueTrackRef.current) return
      const rect = hueTrackRef.current.getBoundingClientRect()
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
      const h = (x / rect.width) * 360
      const newHsv = { ...internalHsv, h: Math.min(360, Math.max(0, h)) }
      commitColor(newHsv)
    },
    [internalHsv, commitColor],
  )

  const handleHuePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    isDraggingHue.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    updateHuePointerFromPointer: updateHueFromPointer(e)
  }

  const handleHuePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingHue.current) {
      updateHueFromPointer(e)
    }
  }

  const handleHuePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingHue.current) {
      isDraggingHue.current = false
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore
      }
      const hex = rgbToHex(hsvToRgb(internalHsv), allowAlpha)
      handleFinalizeColor(hex)
    }
  }

  // Alpha Slider Drag Handling
  const alphaTrackRef = useRef<HTMLDivElement>(null)
  const isDraggingAlpha = useRef(false)

  const updateAlphaFromPointer = useCallback(
    (e: React.PointerEvent<HTMLDivElement> | PointerEvent) => {
      if (!alphaTrackRef.current) return
      const rect = alphaTrackRef.current.getBoundingClientRect()
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
      const a = x / rect.width
      const newHsv = { ...internalHsv, a: Math.min(1, Math.max(0, a)) }
      commitColor(newHsv)
    },
    [internalHsv, commitColor],
  )

  const handleAlphaPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    isDraggingAlpha.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    updateAlphaFromPointer(e)
  }

  const handleAlphaPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingAlpha.current) {
      updateAlphaFromPointer(e)
    }
  }

  const handleAlphaPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingAlpha.current) {
      isDraggingAlpha.current = false
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore
      }
      const hex = rgbToHex(hsvToRgb(internalHsv), allowAlpha)
      handleFinalizeColor(hex)
    }
  }

  // Eyedropper API
  const hasEyeDropper = typeof window !== "undefined" && "EyeDropper" in window

  const handlePickEyeDropper = async () => {
    if (!hasEyeDropper) return
    try {
      // @ts-expect-error - EyeDropper API is available in modern Chromium/Webview2
      const eyeDropper = new window.EyeDropper()
      const result = await eyeDropper.open()
      if (result?.sRGBHex) {
        const rgb = parseColorToRgb(result.sRGBHex)
        const hsv = rgbToHsv(rgb)
        commitColor(hsv)
        handleFinalizeColor(result.sRGBHex)
      }
    } catch {
      // User cancelled eyedropper
    }
  }

  // Copy Hex to Clipboard
  const handleCopyHex = async () => {
    try {
      const hex = rgbToHex(hsvToRgb(internalHsv), allowAlpha)
      await navigator.clipboard.writeText(hex)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Ignore clipboard write failure
    }
  }

  // Manual Hex Input Validation & Commit
  const handleHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    setHexInput(raw)
    const cleaned = raw.startsWith("#") ? raw : `#${raw}`
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(cleaned)) {
      const rgb = parseColorToRgb(cleaned)
      const hsv = rgbToHsv(rgb)
      setInternalHsv(hsv)
      onChange?.(cleaned)
    }
  }

  const handleHexInputBlur = () => {
    const cleaned = hexInput.startsWith("#") ? hexInput : `#${hexInput}`
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(cleaned)) {
      const rgb = parseColorToRgb(cleaned)
      const hsv = rgbToHsv(rgb)
      commitColor(hsv)
      handleFinalizeColor(cleaned)
    } else {
      // Revert to valid current color
      setHexInput(formatHexDisplay(rgbToHex(hsvToRgb(internalHsv), allowAlpha)))
    }
  }

  const handleSelectPreset = (presetColor: string) => {
    const rgb = parseColorToRgb(presetColor)
    const hsv = rgbToHsv(rgb)
    commitColor(hsv)
    handleFinalizeColor(presetColor)
  }

  // Active color string and solid hue for canvas background
  const activeHex = rgbToHex(hsvToRgb(internalHsv), allowAlpha)
  const pureHueHex = rgbToHex(hsvToRgb({ h: internalHsv.h, s: 1, v: 1, a: 1 }), false)

  const triggerSizeClasses = {
    sm: "h-7 px-2 text-xs gap-1.5",
    default: "h-8 px-2.5 text-xs gap-2",
    lg: "h-9 px-3 text-sm gap-2.5",
  }[size]

  return (
    <PopoverPrimitive.Root open={isOpen} onOpenChange={setIsOpen}>
      <div className={cn("inline-flex items-center", className)}>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={ariaLabel}
            className={cn(
              "group relative flex items-center justify-between rounded-md border border-border bg-surface font-mono text-foreground shadow-sm transition-all duration-fast ease-forge hover:border-border-strong hover:bg-surface-container focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
              isOpen && "border-accent ring-2 ring-accent/30",
              triggerSizeClasses,
              triggerClassName,
            )}
          >
            <div className="flex items-center gap-2">
              {/* Color Swatch Chip */}
              <span
                className="relative size-4 shrink-0 overflow-hidden rounded-[4px] border border-border-strong/60 shadow-inner"
                style={{
                  backgroundImage:
                    "linear-gradient(45deg, #25354f 25%, transparent 25%), linear-gradient(-45deg, #25354f 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #25354f 75%), linear-gradient(-45deg, transparent 75%, #25354f 75%)",
                  backgroundSize: "6px 6px",
                  backgroundPosition: "0 0, 0 3px, 3px -3px, -3px 0",
                }}
              >
                <span
                  className="absolute inset-0 block transition-colors duration-fast"
                  style={{ backgroundColor: activeHex }}
                />
              </span>
              <span className="font-mono text-[11px] uppercase tracking-wider text-foreground">
                {formatHexDisplay(activeHex)}
              </span>
            </div>
          </button>
        </PopoverPrimitive.Trigger>

        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align={align}
            side={side}
            sideOffset={sideOffset}
            className={cn(
              "z-50 w-64 rounded-xl border border-border bg-elevated p-3 text-foreground shadow-e3 outline-none select-none",
              "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            )}
          >
            <div className="flex flex-col gap-3">
              {/* 2D Saturation / Value Gradient Canvas */}
              <div
                ref={satValCanvasRef}
                onPointerDown={handleSatValPointerDown}
                onPointerMove={handleSatValPointerMove}
                onPointerUp={handleSatValPointerUp}
                className="relative h-32 w-full cursor-crosshair overflow-hidden rounded-lg border border-border-strong/40 shadow-inner touch-none"
                style={{ backgroundColor: pureHueHex }}
              >
                {/* Saturation gradient (white to transparent) */}
                <div
                  className="absolute inset-0"
                  style={{
                    background: "linear-gradient(to right, #ffffff, transparent)",
                  }}
                />
                {/* Value/Brightness gradient (black to transparent) */}
                <div
                  className="absolute inset-0"
                  style={{
                    background: "linear-gradient(to top, #000000, transparent)",
                  }}
                />

                {/* Crosshair Cursor */}
                <div
                  className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_2px_rgba(0,0,0,0.8)] transition-transform duration-fast"
                  style={{
                    left: `${Math.max(0, Math.min(100, internalHsv.s * 100))}%`,
                    top: `${Math.max(0, Math.min(100, (1 - internalHsv.v) * 100))}%`,
                  }}
                >
                  <div
                    className="size-full rounded-full border border-black/60"
                    style={{ backgroundColor: activeHex }}
                  />
                </div>
              </div>

              {/* Sliders & Controls */}
              <div className="flex flex-col gap-2.5">
                {/* Hue Rainbow Spectrum Slider */}
                <div
                  ref={hueTrackRef}
                  onPointerDown={handleHuePointerDown}
                  onPointerMove={handleHuePointerMove}
                  onPointerUp={handleHuePointerUp}
                  className="relative h-3 w-full cursor-pointer rounded-full border border-border-strong/40 shadow-inner touch-none"
                  style={{
                    background:
                      "linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)",
                  }}
                >
                  <div
                    className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-foreground shadow-md transition-transform duration-fast"
                    style={{
                      left: `${Math.max(0, Math.min(100, (internalHsv.h / 360) * 100))}%`,
                    }}
                  />
                </div>

                {/* Optional Alpha / Opacity Slider */}
                {allowAlpha && (
                  <div
                    ref={alphaTrackRef}
                    onPointerDown={handleAlphaPointerDown}
                    onPointerMove={handleAlphaPointerMove}
                    onPointerUp={handleAlphaPointerUp}
                    className="relative h-3 w-full cursor-pointer overflow-hidden rounded-full border border-border-strong/40 shadow-inner touch-none"
                    style={{
                      backgroundImage:
                        "linear-gradient(45deg, #25354f 25%, transparent 25%), linear-gradient(-45deg, #25354f 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #25354f 75%), linear-gradient(-45deg, transparent 75%, #25354f 75%)",
                      backgroundSize: "6px 6px",
                      backgroundPosition: "0 0, 0 3px, 3px -3px, -3px 0",
                    }}
                  >
                    <div
                      className="absolute inset-0"
                      style={{
                        background: `linear-gradient(to right, transparent, ${rgbToHex(hsvToRgb({ ...internalHsv, a: 1 }))})`,
                      }}
                    />
                    <div
                      className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-foreground shadow-md transition-transform duration-fast"
                      style={{
                        left: `${Math.max(0, Math.min(100, internalHsv.a * 100))}%`,
                      }}
                    />
                  </div>
                )}
              </div>

              {/* Hex Input & Tool Buttons */}
              <div className="flex items-center gap-1.5 pt-1">
                {hasEyeDropper && (
                  <button
                    type="button"
                    onClick={handlePickEyeDropper}
                    title="Pick color from screen"
                    className="flex size-7 items-center justify-center rounded-md border border-border bg-surface text-subtle-foreground transition-colors duration-fast hover:border-border-strong hover:bg-surface-container hover:text-foreground focus-visible:border-accent focus-visible:outline-none"
                  >
                    <Pipette className="size-3.5" aria-hidden />
                  </button>
                )}

                <div className="relative flex-1">
                  <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 font-mono text-[11px] text-subtle-foreground">
                    #
                  </span>
                  <input
                    type="text"
                    spellCheck={false}
                    value={hexInput.replace(/^#/, "")}
                    onChange={handleHexInputChange}
                    onBlur={handleHexInputBlur}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur()
                      }
                    }}
                    className="h-7 w-full rounded-md border border-border bg-surface pr-2 pl-5 font-mono text-xs text-foreground uppercase outline-none transition-colors duration-fast focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/40"
                  />
                </div>

                {allowAlpha && (
                  <div className="flex h-7 w-12 items-center justify-center rounded-md border border-border bg-surface px-1 font-mono text-[11px] text-subtle-foreground">
                    {Math.round(internalHsv.a * 100)}%
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleCopyHex}
                  title={copied ? "Copied!" : "Copy HEX code"}
                  className="flex size-7 items-center justify-center rounded-md border border-border bg-surface text-subtle-foreground transition-colors duration-fast hover:border-border-strong hover:bg-surface-container hover:text-foreground focus-visible:border-accent focus-visible:outline-none"
                >
                  {copied ? (
                    <Check className="size-3.5 text-success animate-in zoom-in" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
              </div>

              {/* Preset Color Swatches */}
              {presets.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-border/80 pt-2.5">
                  <span className="text-[10px] font-semibold tracking-wider text-subtle-foreground uppercase">
                    Presets
                  </span>
                  <div className="grid grid-cols-6 gap-1.5">
                    {presets.map((preset) => {
                      const isActive =
                        preset.toLowerCase() === activeHex.toLowerCase()
                      return (
                        <button
                          key={preset}
                          type="button"
                          title={preset}
                          onClick={() => handleSelectPreset(preset)}
                          className={cn(
                            "group relative size-6 overflow-hidden rounded-md border border-border transition-all duration-fast hover:scale-105 hover:border-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                            isActive && "border-white ring-2 ring-accent shadow-sm",
                          )}
                        >
                          <span
                            className="block size-full"
                            style={{ backgroundColor: preset }}
                          />
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Recent Colors */}
              {showRecent && recentColors.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-border/80 pt-2">
                  <span className="text-[10px] font-semibold tracking-wider text-subtle-foreground uppercase">
                    Recent
                  </span>
                  <div className="flex items-center gap-1.5">
                    {recentColors.map((recent) => (
                      <button
                        key={recent}
                        type="button"
                        title={recent}
                        onClick={() => handleSelectPreset(recent)}
                        className={cn(
                          "group relative size-5 overflow-hidden rounded border border-border transition-all duration-fast hover:scale-110 hover:border-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                          recent.toLowerCase() === activeHex.toLowerCase() &&
                            "border-white ring-1 ring-accent",
                        )}
                      >
                        <span
                          className="block size-full"
                          style={{ backgroundColor: recent }}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </div>
    </PopoverPrimitive.Root>
  )
}
