import { useEffect, useRef, useState } from "react"
import { MousePointer2, Wand2 } from "lucide-react"
import { Badge, Button, Slider, Switch, cn } from "@recordforge/ui"
import type { ClickFeedback, CursorSettings } from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/contracts"
import { RenderCursorPreset } from "../../editor/cursor/cursor-asset"
import { getSetting, isTauri, setSetting } from "../../../lib/settings"

interface RippleEffect {
  id: number
  x: number
  y: number
  color: string
}

export function CursorStep() {
  const [smoothing, setSmoothing] = useState(true)
  const [clickFeedback, setClickFeedback] = useState<ClickFeedback>("ripple")
  const [cursorScale, setCursorScale] = useState(1.2)
  const [spotlight, setSpotlight] = useState(false)
  const [activeColor, setActiveColor] = useState("#38bdf8")

  const playgroundRef = useRef<HTMLDivElement>(null)
  const [pointerPos, setPointerPos] = useState<{ x: number; y: number } | null>(null)
  const [smoothPos, setSmoothPos] = useState<{ x: number; y: number } | null>(null)
  const [ripples, setRipples] = useState<RippleEffect[]>([])

  // Load any stored cursor defaults
  useEffect(() => {
    async function loadCursorPrefs() {
      try {
        const raw = await getSetting("defaultCursorSettings")
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<CursorSettings>
          if (parsed.smoothMovement !== undefined) setSmoothing(parsed.smoothMovement)
          if (parsed.clickFeedback) setClickFeedback(parsed.clickFeedback)
          if (parsed.scale) setCursorScale(parsed.scale)
          if (parsed.clickColor) setActiveColor(parsed.clickColor)
        }
      } catch {
        // Fallback to defaults
      }
    }
    void loadCursorPrefs()
  }, [])

  // Smooth cursor motion interpolation loop
  useEffect(() => {
    if (!pointerPos) return
    if (!smoothing) {
      setSmoothPos(pointerPos)
      return
    }

    let animFrame: number
    const animate = () => {
      setSmoothPos((prev) => {
        if (!prev) return pointerPos
        const dx = pointerPos.x - prev.x
        const dy = pointerPos.y - prev.y
        const factor = 0.28
        return {
          x: prev.x + dx * factor,
          y: prev.y + dy * factor,
        }
      })
      animFrame = requestAnimationFrame(animate)
    }

    animFrame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(animFrame)
  }, [pointerPos, smoothing])

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!playgroundRef.current) return
    const rect = playgroundRef.current.getBoundingClientRect()
    setPointerPos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
  }

  function handleMouseLeave() {
    setPointerPos(null)
    setSmoothPos(null)
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!playgroundRef.current || clickFeedback === "none") return
    const rect = playgroundRef.current.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top

    const newRipple: RippleEffect = {
      id: Date.now() + Math.random(),
      x: clickX,
      y: clickY,
      color: activeColor,
    }

    setRipples((prev) => [...prev.slice(-4), newRipple])

    setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== newRipple.id))
    }, 600)
  }

  function saveCurrentCursorSettings(updates: Partial<CursorSettings>) {
    const updated: CursorSettings = {
      ...defaultCursorSettings,
      smoothMovement: smoothing,
      clickFeedback,
      scale: cursorScale,
      clickColor: activeColor,
      spotlightMode: spotlight,
      ...updates,
    }
    if (isTauri()) {
      void setSetting("defaultCursorSettings", JSON.stringify(updated))
    }
  }

  return (
    <div className="flex flex-col gap-5 text-foreground">
      {/* Header Info */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Wand2 className="size-4 text-primary" />
            Smart Cursor Telemetry & Effects
          </h3>
          <p className="text-xs text-subtle-foreground">
            Move and click in the interactive preview below to test RecordForge's smooth cursor
            rendering.
          </p>
        </div>
        <Badge variant="outline" className="text-xs px-2.5 py-0.5">
          Pure WASM Telemetry
        </Badge>
      </div>

      {/* Interactive Live Playground Canvas */}
      <div
        ref={playgroundRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        className={cn(
          "relative h-44 w-full rounded-xl border border-border-strong bg-surface-dim overflow-hidden select-none cursor-none shadow-e2 transition-all flex items-center justify-center",
          spotlight && pointerPos && "bg-surface-dim/95",
        )}
      >
        {/* Decorative Grid Backdrop */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(56,189,248,0.06),transparent_70%)] pointer-events-none" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-size-[24px_24px] pointer-events-none" />

        {/* Center Prompt */}
        {!pointerPos && (
          <div className="flex flex-col items-center gap-2 text-center pointer-events-none animate-pulse">
            <MousePointer2 className="size-6 text-primary/70" />
            <span className="text-xs font-medium text-subtle-foreground">
              Hover and click anywhere inside this sandbox
            </span>
          </div>
        )}

        {/* Spotlight Overlay */}
        {spotlight && pointerPos && (
          <div
            className="absolute inset-0 pointer-events-none transition-opacity duration-fast"
            style={{
              background: `radial-gradient(circle 90px at ${pointerPos.x}px ${pointerPos.y}px, transparent 0%, rgba(7, 11, 20, 0.75) 100%)`,
            }}
          />
        )}

        {/* Click Ripples */}
        {ripples.map((ripple) => (
          <div
            key={ripple.id}
            className="absolute pointer-events-none rounded-full animate-ping"
            style={{
              left: `${ripple.x}px`,
              top: `${ripple.y}px`,
              width: "36px",
              height: "36px",
              marginLeft: "-18px",
              marginTop: "-18px",
              backgroundColor: ripple.color,
              opacity: 0.6,
            }}
          />
        ))}

        {/* Custom Smoothed Cursor Pointer */}
        {smoothPos && (
          <div
            className="absolute pointer-events-none transition-transform will-change-transform z-30"
            style={{
              left: `${smoothPos.x - 9.33 * cursorScale}px`,
              top: `${smoothPos.y - 9.33 * cursorScale}px`,
              transform: `scale(${cursorScale})`,
              transformOrigin: "top left",
              filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.4))",
            }}
          >
            <div className="relative">
              {/* Highlight Aura */}
              <div
                className="absolute -inset-2 rounded-full blur-xs opacity-40 pointer-events-none"
                style={{ backgroundColor: activeColor }}
              />
              <RenderCursorPreset
                preset="recorded-system"
                fillColor={activeColor}
                fillOpacity={1}
                strokeColor="#ffffff"
                strokeWidth={2}
                strokeOpacity={1}
                className="relative z-10"
              />
            </div>
          </div>
        )}
      </div>

      {/* Live Customization Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 rounded-xl border border-border bg-surface/60 p-3.5">
        {/* Click Feedback Selector */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-subtle-foreground block">Click Feedback</label>
          <div className="flex items-center gap-1.5">
            {(["ripple", "pulse", "none"] as ClickFeedback[]).map((mode) => (
              <Button
                key={mode}
                variant={clickFeedback === mode ? "primary" : "outline"}
                size="sm"
                className={cn(
                  "h-7 px-2.5 text-xs capitalize flex-1",
                  clickFeedback === mode && "bg-primary text-white",
                )}
                onClick={() => {
                  setClickFeedback(mode)
                  saveCurrentCursorSettings({ clickFeedback: mode })
                }}
              >
                {mode}
              </Button>
            ))}
          </div>
        </div>

        {/* Smoothing & Spotlight Toggles */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-subtle-foreground">Smooth Movement</span>
            <Switch
              checked={smoothing}
              onCheckedChange={(checked) => {
                setSmoothing(checked)
                saveCurrentCursorSettings({ smoothMovement: checked })
              }}
              aria-label="Toggle smooth cursor movement"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-subtle-foreground">Spotlight Focus</span>
            <Switch
              checked={spotlight}
              onCheckedChange={(checked) => {
                setSpotlight(checked)
                saveCurrentCursorSettings({ spotlightMode: checked })
              }}
              aria-label="Toggle spotlight mode"
            />
          </div>
        </div>

        {/* Cursor Scale */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-subtle-foreground">Cursor Scale</span>
            <span className="text-xs font-mono text-foreground font-semibold">
              {cursorScale.toFixed(1)}x
            </span>
          </div>
          <Slider
            value={[cursorScale]}
            min={0.8}
            max={3.5}
            step={0.1}
            onValueChange={([val]) => {
              setCursorScale(val)
              saveCurrentCursorSettings({ scale: val })
            }}
            className="w-full"
          />
        </div>
      </div>
    </div>
  )
}
