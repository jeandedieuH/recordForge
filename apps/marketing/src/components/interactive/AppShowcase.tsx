import React, { useState, useEffect } from "react"
import {
  Monitor,
  AppWindow,
  Crop,
  Play,
  Circle,
  Square,
  Mic,
  Volume2,
  Video,
  Sparkles,
  MousePointer,
  Cpu,
  HardDrive,
  ShieldCheck,
  CheckCircle2,
} from "lucide-react"

type CaptureMode = "fullscreen" | "window" | "region" | "studio"

export function AppShowcase() {
  const [activeMode, setActiveMode] = useState<CaptureMode>("fullscreen")
  const [isRecording, setIsRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(14)
  const [cursorSmoothing, setCursorSmoothing] = useState(true)
  const [webcamEnabled, setWebcamEnabled] = useState(true)
  const [autoZoom, setAutoZoom] = useState(true)
  const [micLevel, setMicLevel] = useState(65)
  const [systemLevel, setSystemLevel] = useState(42)
  const [cursorPos, setCursorPos] = useState({ x: 38, y: 44 })
  const [clicks, setClicks] = useState<Array<{ id: number; x: number; y: number }>>([])

  // Simulated recording timer
  useEffect(() => {
    let interval: NodeJS.Timeout
    if (isRecording) {
      interval = setInterval(() => {
        setRecordSeconds((prev) => prev + 1)
        // fluctuate VU meters
        setMicLevel(Math.floor(45 + Math.random() * 45))
        setSystemLevel(Math.floor(30 + Math.random() * 40))
      }, 1000)
    }
    return () => clearInterval(interval)
  }, [isRecording])

  // Simulated smooth cursor wander
  useEffect(() => {
    const wanderInterval = setInterval(() => {
      if (isRecording) {
        const nextX = Math.min(85, Math.max(15, cursorPos.x + (Math.random() * 30 - 15)))
        const nextY = Math.min(80, Math.max(20, cursorPos.y + (Math.random() * 26 - 13)))
        setCursorPos({ x: nextX, y: nextY })

        if (Math.random() > 0.6) {
          const clickId = Date.now()
          setClicks((prev) => [...prev.slice(-3), { id: clickId, x: nextX, y: nextY }])
        }
      }
    }, 1400)
    return () => clearInterval(wanderInterval)
  }, [isRecording, cursorPos])

  const formatDuration = (secs: number) => {
    const mins = Math.floor(secs / 60)
    const rem = secs % 60
    return `00:${mins.toString().padStart(2, "0")}:${rem.toString().padStart(2, "0")}`
  }

  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    setCursorPos({ x, y })
    const clickId = Date.now()
    setClicks((prev) => [...prev.slice(-4), { id: clickId, x, y }])
  }

  return (
    <div className="relative w-full max-w-6xl mx-auto rounded-2xl border border-border bg-surface/95 backdrop-blur-2xl shadow-[0_20px_70px_rgba(0,0,0,0.8)] overflow-hidden">
      {/* Top Window Chrome Bar with Official Brand Mark */}
      <div className="flex items-center justify-between px-4 py-3 bg-surface-dim border-b border-border select-none">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-recording border border-recording/40"></div>
            <div className="w-3 h-3 rounded-full bg-track-title border border-track-title/40"></div>
            <div className="w-3 h-3 rounded-full bg-track-mic border border-track-mic/40"></div>
          </div>
          <div className="flex items-center gap-2 pl-2 border-l border-border">
            <img src="/forge-mark.svg" alt="recordForge mark" className="w-4 h-4 object-contain" />
            <span className="text-xs font-semibold text-foreground tracking-wide">
              record<span className="text-track-screen">Forge</span> Desktop Studio
            </span>
            <span className="text-[10px] font-mono text-muted-foreground hidden sm:inline">
              — Local Session #0412 (SQLite WAL)
            </span>
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface border border-primary/30 text-[11px] font-mono text-track-screen">
            <Cpu className="w-3 h-3 text-track-screen" />
            <span>NVENC 4K60</span>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface border border-track-mic/30 text-[11px] font-mono text-track-mic">
            <HardDrive className="w-3 h-3 text-track-mic" />
            <span>WASAPI 48kHz</span>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface border border-secondary/30 text-[11px] font-mono text-track-annotation">
            <ShieldCheck className="w-3 h-3 text-track-annotation" />
            <span>SQLite WAL</span>
          </div>
        </div>
      </div>

      {/* Mode Selector Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 bg-surface border-b border-border">
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-surface-dim border border-border">
          <button
            onClick={() => setActiveMode("fullscreen")}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeMode === "fullscreen"
                ? "bg-primary text-foreground shadow-md shadow-primary/40"
                : "text-muted-foreground hover:text-foreground hover:bg-surface-container-high"
            }`}
          >
            <Monitor className="w-3.5 h-3.5 text-track-screen" />
            Full Screen (4K)
          </button>
          <button
            onClick={() => setActiveMode("window")}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeMode === "window"
                ? "bg-primary text-foreground shadow-md shadow-primary/40"
                : "text-muted-foreground hover:text-foreground hover:bg-surface-container-high"
            }`}
          >
            <AppWindow className="w-3.5 h-3.5 text-track-screen" />
            Active Window
          </button>
          <button
            onClick={() => setActiveMode("region")}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeMode === "region"
                ? "bg-primary text-foreground shadow-md shadow-primary/40"
                : "text-muted-foreground hover:text-foreground hover:bg-surface-container-high"
            }`}
          >
            <Crop className="w-3.5 h-3.5 text-track-graphic" />
            Custom Area
          </button>
          <button
            onClick={() => setActiveMode("studio")}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeMode === "studio"
                ? "bg-secondary text-foreground shadow-md shadow-secondary/40"
                : "text-muted-foreground hover:text-foreground hover:bg-surface-container-high"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-track-annotation" />
            Studio Pro
          </button>
        </div>

        {/* Feature Quick Toggles */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCursorSmoothing(!cursorSmoothing)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              cursorSmoothing
                ? "bg-primary/20 border-track-screen text-track-screen"
                : "bg-surface-dim border-border text-muted-foreground"
            }`}
            title="Toggle high-frequency vector cursor smoothing"
          >
            <MousePointer className="w-3.5 h-3.5" />
            <span>Smooth Cursor</span>
            {cursorSmoothing && <span className="w-1.5 h-1.5 rounded-full bg-track-screen"></span>}
          </button>

          <button
            onClick={() => setWebcamEnabled(!webcamEnabled)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              webcamEnabled
                ? "bg-secondary/20 border-track-webcam text-track-webcam"
                : "bg-surface-dim border-border text-muted-foreground"
            }`}
          >
            <Video className="w-3.5 h-3.5" />
            <span>PiP Camera</span>
            {webcamEnabled && <span className="w-1.5 h-1.5 rounded-full bg-track-webcam"></span>}
          </button>

          <button
            onClick={() => setAutoZoom(!autoZoom)}
            className={`hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              autoZoom
                ? "bg-track-mic/15 border-track-mic text-track-mic"
                : "bg-surface-dim border-border text-muted-foreground"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Auto Zoom</span>
            {autoZoom && <span className="w-1.5 h-1.5 rounded-full bg-track-mic"></span>}
          </button>
        </div>
      </div>

      {/* Main Interactive Stage Area */}
      <div
        className="relative h-72 sm:h-96 md:h-105 bg-background overflow-hidden cursor-crosshair select-none"
        onClick={handleCanvasClick}
      >
        {/* Background Grid Mock App Content */}
        <div className="absolute inset-0 p-6 opacity-30 pointer-events-none flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-border pb-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/30 border border-primary/50 flex items-center justify-center">
                <img src="/forge-mark.svg" alt="logo" className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <div className="w-32 h-3 rounded bg-white/20"></div>
                <div className="w-20 h-2 rounded bg-white/10"></div>
              </div>
            </div>
            <div className="flex gap-2">
              <div className="w-16 h-6 rounded bg-surface-container-high border border-border"></div>
              <div className="w-16 h-6 rounded bg-surface-container-high border border-border"></div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 flex-1">
            <div className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-2">
              <div className="w-12 h-3 rounded bg-track-screen/40"></div>
              <div className="w-full h-16 rounded bg-surface-container-high"></div>
              <div className="w-3/4 h-2 rounded bg-muted-foreground/20"></div>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-2">
              <div className="w-12 h-3 rounded bg-secondary/40"></div>
              <div className="w-full h-16 rounded bg-surface-container-high"></div>
              <div className="w-3/4 h-2 rounded bg-muted-foreground/20"></div>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-2">
              <div className="w-12 h-3 rounded bg-track-mic/40"></div>
              <div className="w-full h-16 rounded bg-surface-container-high"></div>
              <div className="w-3/4 h-2 rounded bg-muted-foreground/20"></div>
            </div>
          </div>
        </div>

        {/* Capture Frame Overlay based on Mode */}
        {activeMode === "window" && (
          <div className="absolute inset-8 rounded-xl border-2 border-track-screen shadow-[0_0_30px_rgba(56,189,248,0.3)] pointer-events-none transition-all duration-300">
            <div className="absolute -top-3 left-4 px-2 py-0.5 rounded bg-primary text-[10px] font-mono text-white tracking-wide">
              TARGET WINDOW: VS Code (1920x1080)
            </div>
          </div>
        )}

        {activeMode === "region" && (
          <div className="absolute top-12 left-16 right-20 bottom-16 rounded-lg border-2 border-dashed border-track-graphic bg-track-graphic/5 shadow-[0_0_40px_rgba(34,211,238,0.2)] pointer-events-none transition-all duration-300">
            <div className="absolute -top-3 left-4 px-2 py-0.5 rounded bg-primary text-[10px] font-mono text-white">
              CUSTOM REGION: 1280 x 720 • 60 FPS
            </div>
            <div className="absolute -bottom-2 -right-2 w-4 h-4 bg-track-graphic rounded-sm"></div>
          </div>
        )}

        {/* Auto Zoom Focus Aura */}
        {autoZoom && (
          <div
            className="absolute pointer-events-none transition-all duration-700 ease-out -translate-x-1/2 -translate-y-1/2 rounded-full border border-track-screen/40 bg-primary/10 blur-sm"
            style={{
              left: `${cursorPos.x}%`,
              top: `${cursorPos.y}%`,
              width: "180px",
              height: "180px",
            }}
          />
        )}

        {/* Simulated Telemetry Cursor with Bezier Trail */}
        <div
          className={`absolute pointer-events-none z-30 transition-all ${
            cursorSmoothing ? "duration-300 ease-out" : "duration-75"
          }`}
          style={{
            left: `${cursorPos.x}%`,
            top: `${cursorPos.y}%`,
            transform: "translate(-2px, -2px)",
          }}
        >
          <svg className="w-6 h-6 drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]" viewBox="0 0 24 24">
            <path
              d="M3 3l7 18 3-7 7-3L3 3z"
              fill="#ffffff"
              stroke="#070b14"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
          {cursorSmoothing && (
            <div className="absolute -top-4 -right-16 px-1.5 py-0.5 rounded bg-primary text-[9px] font-mono text-white whitespace-nowrap shadow">
              60Hz Smoothed
            </div>
          )}
        </div>

        {/* Click Ripple Wave Animations */}
        {clicks.map((click) => (
          <div
            key={click.id}
            className="absolute pointer-events-none -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-track-screen animate-ping z-20"
            style={{
              left: `${click.x}%`,
              top: `${click.y}%`,
              width: "36px",
              height: "36px",
              animationDuration: "0.8s",
            }}
          />
        ))}

        {/* PiP Camera Overlay (Movable & Stylish) */}
        {webcamEnabled && (
          <div className="absolute bottom-6 right-6 w-24 h-24 sm:w-28 sm:h-28 rounded-2xl border-2 border-secondary bg-linear-to-tr from-surface-container-high via-surface to-secondary/40 shadow-2xl shadow-secondary/30 overflow-hidden z-20 flex flex-col items-center justify-center pointer-events-none">
            <div className="w-10 h-10 rounded-full bg-secondary/25 border border-track-webcam/40 flex items-center justify-center">
              <Video className="w-5 h-5 text-track-webcam" />
            </div>
            <span className="text-[10px] text-track-annotation font-medium mt-1">Camera PiP</span>
            <div className="absolute bottom-1.5 right-1.5 flex gap-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-track-mic"></span>
            </div>
          </div>
        )}

        {/* Floating Recording Control Bar Overlay */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2 rounded-2xl bg-surface-dim/95 border border-border backdrop-blur-xl shadow-[0_12px_40px_rgba(0,0,0,0.8)] z-40">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setIsRecording(!isRecording)
            }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold tracking-wide transition-all shadow-lg ${
              isRecording
                ? "bg-recording hover:brightness-110 text-white shadow-recording/30"
                : "bg-primary hover:bg-primary-hover text-white shadow-primary/40"
            }`}
          >
            {isRecording ? (
              <>
                <Square className="w-3.5 h-3.5 fill-white" />
                <span>STOP</span>
              </>
            ) : (
              <>
                <Circle className="w-3.5 h-3.5 fill-white animate-pulse" />
                <span>START RECORDING</span>
              </>
            )}
          </button>

          {/* Live Timer */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border">
            <span
              className={`w-2 h-2 rounded-full ${
                isRecording ? "bg-recording animate-rec-pulse" : "bg-tertiary"
              }`}
            ></span>
            <span className="font-mono text-xs font-bold tracking-wider text-white">
              {formatDuration(recordSeconds)}
            </span>
          </div>

          {/* Audio VU Meters (WASAPI Engine) */}
          <div className="hidden sm:flex items-center gap-3 pl-2 border-l border-border">
            {/* Mic Meter */}
            <div className="flex items-center gap-1.5">
              <Mic className="w-3.5 h-3.5 text-track-mic" />
              <div className="w-12 h-2 bg-surface-container-high rounded-full overflow-hidden flex gap-0.5">
                <div
                  className="h-full bg-track-mic transition-all duration-150"
                  style={{ width: `${isRecording ? micLevel : 0}%` }}
                ></div>
              </div>
            </div>

            {/* System Audio Meter */}
            <div className="flex items-center gap-1.5">
              <Volume2 className="w-3.5 h-3.5 text-track-screen" />
              <div className="w-12 h-2 bg-surface-container-high rounded-full overflow-hidden flex gap-0.5">
                <div
                  className="h-full bg-track-screen transition-all duration-150"
                  style={{ width: `${isRecording ? systemLevel : 0}%` }}
                ></div>
              </div>
            </div>
          </div>
        </div>

        {/* Tip Badge */}
        <div className="absolute top-4 right-4 px-2.5 py-1 rounded-md bg-surface-dim/80 border border-border text-[11px] text-muted-foreground backdrop-blur-md pointer-events-none">
          Click anywhere to simulate cursor telemetry &amp; click ripples
        </div>
      </div>

      {/* Bottom Timeline Preview Strip */}
      <div className="p-3 bg-surface-dim border-t border-border flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-foreground font-medium">
            <span className="w-2 h-2 rounded-full bg-primary"></span>
            Non-Linear Timeline Engine
          </div>
          <span className="hidden sm:inline text-border-strong">|</span>
          <span className="hidden sm:inline text-muted-foreground">6 Synchronized Tracks</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-track-mic flex items-center gap-1 font-mono text-[11px]">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Zero Frame Drop Guarantee
          </span>
        </div>
      </div>
    </div>
  )
}
