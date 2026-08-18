import React, { useState, useEffect } from "react"
import {
  MousePointer,
  Sparkles,
  Zap,
  Sliders,
  Play,
  RotateCcw,
  Activity,
  CheckCircle2,
  Circle,
  Eye,
  SlidersHorizontal,
} from "lucide-react"

export function CursorDemo() {
  const [isSmoothed, setIsSmoothed] = useState(true)
  const [showAutoZoom, setShowAutoZoom] = useState(true)
  const [clickStyle, setClickStyle] = useState<"primary" | "secondary" | "gold">("primary")
  const [smoothingLevel, setSmoothingLevel] = useState(85)
  const [activeStep, setActiveStep] = useState(0)

  // Simulation keyframe points representing an interaction sequence
  const waypoints = [
    { x: 18, y: 30, action: "move", label: "Hover Primary Action" },
    { x: 42, y: 22, action: "click", label: "Select Timeline Preset" },
    { x: 68, y: 48, action: "move", label: "Scrub Audio Track" },
    { x: 80, y: 72, action: "click", label: "Split Video Clip" },
    { x: 35, y: 65, action: "move", label: "Inspect NVENC Buffer" },
  ]

  const currentPoint = waypoints[activeStep]

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveStep((prev) => (prev + 1) % waypoints.length)
    }, 2200)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="w-full rounded-2xl border border-border bg-surface/95 backdrop-blur-xl p-6 sm:p-8 shadow-2xl overflow-hidden">
      {/* Controls Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-border">
        <div>
          <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
            <MousePointer className="w-5 h-5 text-track-screen" />
            Studio-Grade Cursor &amp; Telemetry Engine
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Compare jittery raw hardware coordinates against RecordForge’s Rust spring-smoothed
            telemetry (spec-010).
          </p>
        </div>

        {/* Smoothing Toggle Pill */}
        <div className="flex items-center gap-2 p-1 rounded-xl bg-surface-dim border border-border">
          <button
            onClick={() => setIsSmoothed(false)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              !isSmoothed ? "bg-recording/20 text-recording border border-recording/40" : "text-muted-foreground"
            }`}
          >
            Raw Jittery Mouse
          </button>
          <button
            onClick={() => setIsSmoothed(true)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              isSmoothed
                ? "bg-primary text-foreground shadow-lg shadow-primary/40"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            RecordForge Smoothed (60Hz)
          </button>
        </div>
      </div>

      {/* Interactive Visualizer Canvas */}
      <div className="relative mt-5 h-80 sm:h-96 rounded-xl bg-background border border-border overflow-hidden select-none">
        {/* Synthetic App UI Backdrop */}
        <div className="absolute inset-0 p-8 opacity-20 pointer-events-none flex flex-col justify-between">
          <div className="flex justify-between items-center">
            <div className="w-28 h-6 rounded bg-tertiary"></div>
            <div className="flex gap-2">
              <div className="w-16 h-6 rounded bg-primary"></div>
              <div className="w-16 h-6 rounded bg-secondary"></div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-6">
            <div className="h-28 rounded-lg bg-surface border border-border p-3"></div>
            <div className="h-28 rounded-lg bg-surface border border-border p-3"></div>
            <div className="h-28 rounded-lg bg-surface border border-border p-3"></div>
          </div>
          <div className="w-full h-8 rounded bg-surface border border-border"></div>
        </div>

        {/* SVG Motion Path & Bezier Lines */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          {/* Interpolated Smooth Curve */}
          <path
            d="M 18% 30% C 25% 15%, 35% 20%, 42% 22% C 55% 25%, 60% 40%, 68% 48% C 75% 55%, 82% 60%, 80% 72% C 78% 85%, 45% 75%, 35% 65% Z"
            fill="none"
            stroke={isSmoothed ? "var(--color-track-screen)" : "var(--color-tertiary)"}
            strokeWidth={isSmoothed ? "2.5" : "1"}
            strokeDasharray={isSmoothed ? "none" : "4 4"}
            strokeOpacity={isSmoothed ? "0.85" : "0.3"}
          />

          {/* Raw Jitter Dots if in raw mode */}
          {!isSmoothed &&
            waypoints.map((pt, i) => (
              <circle
                key={i}
                cx={`${pt.x + (i % 2 === 0 ? 1.5 : -1.5)}%`}
                cy={`${pt.y + (i % 2 === 0 ? -1.5 : 1.5)}%`}
                r="3"
                fill="var(--color-recording)"
                opacity="0.8"
              />
            ))}
        </svg>

        {/* Dynamic Zoom Spotlight */}
        {showAutoZoom && isSmoothed && (
          <div
            className="absolute rounded-full border border-track-screen/50 bg-track-screen/10 pointer-events-none transition-all duration-700 ease-out -translate-x-1/2 -translate-y-1/2 backdrop-blur-[1px]"
            style={{
              left: `${currentPoint.x}%`,
              top: `${currentPoint.y}%`,
              width: "160px",
              height: "160px",
            }}
          >
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-surface/90 border border-track-screen/40 text-[10px] font-mono text-track-screen whitespace-nowrap">
              Auto-Follow Spotlight
            </div>
          </div>
        )}

        {/* Dynamic Cursor Pointer with Spring Transition */}
        <div
          className={`absolute pointer-events-none z-30 transition-all ${
            isSmoothed ? "duration-700 ease-out" : "duration-75 ease-linear"
          }`}
          style={{
            left: `${currentPoint.x}%`,
            top: `${currentPoint.y}%`,
            transform: "translate(-2px, -2px)",
          }}
        >
          <svg
            className={`w-7 h-7 drop-shadow-[0_4px_12px_rgba(0,0,0,0.9)] ${
              !isSmoothed ? "rotate-6 text-recording" : "text-foreground"
            }`}
            viewBox="0 0 24 24"
          >
            <path
              d="M3 3l7 18 3-7 7-3L3 3z"
              fill={isSmoothed ? "#ffffff" : "#fca5a5"}
              stroke="#070b14"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>

          {/* Click Ripple Wave with Brand Colors */}
          {currentPoint.action === "click" && (
            <div
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none animate-ping ${
                clickStyle === "primary"
                  ? "border-2 border-track-screen bg-primary/30"
                  : clickStyle === "secondary"
                    ? "border-2 border-track-annotation bg-secondary/40"
                    : "border-2 border-track-title bg-track-title/30"
              }`}
              style={{
                left: "2px",
                top: "2px",
                width: "42px",
                height: "42px",
                animationDuration: "0.9s",
              }}
            />
          )}

          {/* Action Label Tooltip */}
          <div className="absolute top-6 left-4 px-2 py-0.5 rounded bg-surface/95 border border-border text-[11px] font-mono text-foreground shadow-lg whitespace-nowrap">
            {currentPoint.label} {currentPoint.action === "click" && "⚡ Click"}
          </div>
        </div>

        {/* Bottom Specs Ribbon */}
        <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-lg bg-surface-dim/95 border border-border text-[11px] font-mono">
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground">
              Algorithm:{" "}
              <strong className="text-track-screen">
                {isSmoothed ? "Cubic Hermite Spline + resvg rasterizer" : "Raw Windows Polling"}
              </strong>
            </span>
            <span className="text-border-strong">•</span>
            <span className="text-muted-foreground">
              Parity: <strong className="text-track-mic">100% Exact High-DPI Scale</strong>
            </span>
          </div>
          <div className="text-muted-foreground">
            Jitter:{" "}
            <span className={isSmoothed ? "text-track-mic" : "text-recording"}>
              {isSmoothed ? "< 0.04 px (Subpixel Precision)" : "± 14.8 px (Noticeable Shake)"}
            </span>
          </div>
        </div>
      </div>

      {/* Interactive Controls & Parameters */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4 pt-4 border-t border-border text-xs">
        <div className="flex flex-col gap-1.5">
          <label className="text-muted-foreground font-medium flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-track-screen" />
              Spring Smoothing Tension
            </span>
            <span className="font-mono text-track-screen">{smoothingLevel}%</span>
          </label>
          <input
            type="range"
            min="20"
            max="100"
            value={smoothingLevel}
            onChange={(e) => setSmoothingLevel(Number(e.target.value))}
            className="w-full accent-primary bg-surface-container-high rounded-lg cursor-pointer h-1.5"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-muted-foreground font-medium flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-secondary" />
            Click Visual Effect
          </label>
          <div className="flex gap-1">
            <button
              onClick={() => setClickStyle("primary")}
              className={`flex-1 py-1 rounded text-center border font-medium transition-all ${
                clickStyle === "primary"
                  ? "bg-primary/25 border-track-screen text-track-screen"
                  : "bg-surface-dim border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              Primary Blue
            </button>
            <button
              onClick={() => setClickStyle("secondary")}
              className={`flex-1 py-1 rounded text-center border font-medium transition-all ${
                clickStyle === "secondary"
                  ? "bg-secondary/25 border-track-annotation text-track-annotation"
                  : "bg-surface-dim border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              Purple Glow
            </button>
            <button
              onClick={() => setClickStyle("gold")}
              className={`flex-1 py-1 rounded text-center border font-medium transition-all ${
                clickStyle === "gold"
                  ? "bg-track-title/25 border-track-title text-track-title"
                  : "bg-surface-dim border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              Gold Accent
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between p-2.5 rounded-lg bg-surface-dim border border-border">
          <div>
            <div className="font-medium text-foreground flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5 text-track-mic" />
              Auto-Follow Spotlight
            </div>
            <div className="text-[10px] text-muted-foreground">Magnify cursor focus areas</div>
          </div>
          <button
            onClick={() => setShowAutoZoom(!showAutoZoom)}
            className={`w-10 h-5 rounded-full p-0.5 transition-colors ${
              showAutoZoom ? "bg-primary" : "bg-border"
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-foreground transition-transform ${
                showAutoZoom ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  )
}
