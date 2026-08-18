import React, { useState, useEffect } from "react"
import {
  Play,
  Pause,
  Scissors,
  RotateCcw,
  Volume2,
  Mic,
  Video,
  Monitor,
  Sparkles,
  Layers,
  ZoomIn,
  Check,
} from "lucide-react"

export function TimelineSandbox() {
  const [isPlaying, setIsPlaying] = useState(false)
  const [playheadMs, setPlayheadMs] = useState(3200)
  const [selectedTrack, setSelectedTrack] = useState<string>("screen")
  const [splitCount, setSplitCount] = useState(2)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const maxDurationMs = 12000

  // Playhead loop animation
  useEffect(() => {
    let animId: number
    let lastTimestamp = performance.now()

    const step = (now: number) => {
      const delta = now - lastTimestamp
      lastTimestamp = now

      if (isPlaying) {
        setPlayheadMs((prev) => {
          const next = prev + delta
          return next >= maxDurationMs ? 0 : next
        })
      }
      animId = requestAnimationFrame(step)
    }

    animId = requestAnimationFrame(step)
    return () => cancelAnimationFrame(animId)
  }, [isPlaying])

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    setPlayheadMs(clickRatio * maxDurationMs)
  }

  const triggerSplit = () => {
    setSplitCount((prev) => prev + 1)
    setActionNotice("Non-destructive split created at playhead (0ms latency)")
    setTimeout(() => setActionNotice(null), 3000)
  }

  const formatMs = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const frames = Math.floor(((ms % 1000) / 1000) * 60)
    return `00:${seconds.toString().padStart(2, "0")}:${frames.toString().padStart(2, "0")}`
  }

  const progressPercent = (playheadMs / maxDurationMs) * 100

  return (
    <div className="w-full rounded-2xl border border-border bg-surface/95 backdrop-blur-xl p-6 sm:p-8 shadow-2xl overflow-hidden">
      {/* Header & Editing Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-border">
        <div>
          <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
            <Layers className="w-5 h-5 text-track-webcam" />
            Proxy-Based Non-Linear Timeline
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Instant 60fps scrubbing with multi-track A/V sync, zero proxy generation lag, and 100%
            lossless exports.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all shadow ${
              isPlaying
                ? "bg-track-title hover:brightness-110 text-foreground"
                : "bg-primary hover:bg-primary-hover text-foreground"
            }`}
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
            {isPlaying ? "Pause Timeline" : "Play Preview"}
          </button>

          <button
            onClick={triggerSplit}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest border border-border text-xs font-medium text-foreground transition-colors"
          >
            <Scissors className="w-3.5 h-3.5 text-track-screen" />
            Split Clip
          </button>

          <button
            onClick={() => {
              setPlayheadMs(0)
              setIsPlaying(false)
            }}
            className="p-1.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest border border-border text-muted-foreground hover:text-foreground transition-colors"
            title="Rewind"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Mini Video & Waveform Preview Canvas */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-5">
        {/* Visual Preview Screen */}
        <div className="lg:col-span-1 h-44 rounded-xl bg-background border border-border relative overflow-hidden flex flex-col justify-between p-3 select-none">
          <div className="flex items-center justify-between text-[11px] font-mono">
            <span className="px-2 py-0.5 rounded bg-surface border border-primary/40 text-track-screen">
              Preview Canvas
            </span>
            <span className="text-muted-foreground">{formatMs(playheadMs)}</span>
          </div>

          {/* Synthetic visual output matching playhead */}
          <div className="relative w-full h-24 rounded-lg bg-linear-to-br from-surface via-surface-container-high to-surface-dim border border-border flex items-center justify-center overflow-hidden">
            <div className="text-center">
              <Monitor className="w-8 h-8 mx-auto text-track-screen/80 mb-1" />
              <div className="text-[10px] text-foreground font-mono">Screen @ 3840x2160</div>
            </div>

            {/* Simulated webcam PiP inside preview */}
            <div className="absolute bottom-2 right-2 w-10 h-10 rounded-full border border-track-webcam bg-surface flex items-center justify-center shadow">
              <Video className="w-4 h-4 text-track-webcam" />
            </div>

            {/* Simulated Zoom Keyframe indicator */}
            {playheadMs > 4000 && playheadMs < 8000 && (
              <div className="absolute inset-0 border-2 border-dashed border-track-title/70 bg-track-title/5 flex items-start justify-start p-1 pointer-events-none">
                <span className="text-[8px] font-mono text-track-title bg-background/90 px-1 rounded border border-track-title/30">
                  Zoom Active (1.5x)
                </span>
              </div>
            )}
          </div>

          <div className="text-[10px] text-subtle-foreground flex justify-between">
            <span>Proxy Renderer: WASM Fast Path</span>
            <span>60.0 FPS</span>
          </div>
        </div>

        {/* Multi-Track Editor Viewport */}
        <div className="lg:col-span-2 rounded-xl bg-background border border-border p-3 flex flex-col justify-between">
          {/* Ruler & Scrub Bar */}
          <div
            className="relative h-6 bg-surface-dim rounded border border-border cursor-pointer flex items-center px-2 text-[10px] font-mono text-muted-foreground select-none overflow-hidden"
            onClick={handleTimelineClick}
          >
            <div className="flex justify-between w-full opacity-60">
              <span>00:00:00</span>
              <span>00:03:00</span>
              <span>00:06:00</span>
              <span>00:09:00</span>
              <span>00:12:00</span>
            </div>

            {/* Playhead Marker */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-recording z-30 pointer-events-none shadow-[0_0_8px_rgba(239,68,68,0.9)]"
              style={{ left: `${progressPercent}%` }}
            >
              <div className="w-2.5 h-2.5 bg-recording -translate-x-1 rotate-45"></div>
            </div>
          </div>

          {/* Tracks List matching spec-010 Tokens */}
          <div className="space-y-1.5 mt-2 relative" onClick={handleTimelineClick}>
            {/* Playhead Overlay across all tracks */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-recording/90 z-20 pointer-events-none shadow-[0_0_8px_rgba(239,68,68,0.9)]"
              style={{ left: `${progressPercent}%` }}
            />

            {/* Track 1: Video/Screen -- track-screen */}
            <div
              onClick={(e) => {
                e.stopPropagation()
                setSelectedTrack("screen")
              }}
              className={`h-8 rounded-md flex items-center px-2 border text-xs cursor-pointer transition-all ${
                selectedTrack === "screen"
                  ? "bg-surface border-track-screen shadow"
                  : "bg-surface-dim border-border hover:border-border-strong"
              }`}
            >
              <div className="w-24 flex items-center gap-1.5 text-track-screen font-medium text-[11px] shrink-0">
                <Monitor className="w-3 h-3 text-track-screen" />
                <span>Screen 4K</span>
              </div>
              <div className="flex-1 flex gap-1 h-5 overflow-hidden">
                <div className="w-5/12 bg-track-screen/20 border border-track-screen/40 rounded px-2 flex items-center text-[10px] text-track-screen">
                  Clip_01.mp4
                </div>
                <div className="w-4/12 bg-track-screen/20 border border-track-screen/40 rounded px-2 flex items-center text-[10px] text-track-screen">
                  Clip_02.mp4
                </div>
                <div className="flex-1 bg-track-screen/15 border border-track-screen/30 rounded px-2 flex items-center text-[10px] text-track-screen">
                  Clip_03.mp4
                </div>
              </div>
            </div>

            {/* Track 2: Webcam PiP -- track-webcam */}
            <div
              onClick={(e) => {
                e.stopPropagation()
                setSelectedTrack("webcam")
              }}
              className={`h-8 rounded-md flex items-center px-2 border text-xs cursor-pointer transition-all ${
                selectedTrack === "webcam"
                  ? "bg-surface border-track-webcam shadow"
                  : "bg-surface-dim border-border hover:border-border-strong"
              }`}
            >
              <div className="w-24 flex items-center gap-1.5 text-track-webcam font-medium text-[11px] shrink-0">
                <Video className="w-3 h-3 text-track-webcam" />
                <span>Webcam PiP</span>
              </div>
              <div className="flex-1 flex gap-1 h-5 overflow-hidden">
                <div className="w-9/12 bg-track-webcam/20 border border-track-webcam/40 rounded px-2 flex items-center text-[10px] text-track-webcam">
                  Facecam_Synced.mp4
                </div>
              </div>
            </div>

            {/* Track 3: Microphone (WASAPI) -- track-mic */}
            <div
              onClick={(e) => {
                e.stopPropagation()
                setSelectedTrack("mic")
              }}
              className={`h-8 rounded-md flex items-center px-2 border text-xs cursor-pointer transition-all ${
                selectedTrack === "mic"
                  ? "bg-surface border-track-mic shadow"
                  : "bg-surface-dim border-border hover:border-border-strong"
              }`}
            >
              <div className="w-24 flex items-center gap-1.5 text-track-mic font-medium text-[11px] shrink-0">
                <Mic className="w-3 h-3 text-track-mic" />
                <span>Mic Audio</span>
              </div>
              <div className="flex-1 flex gap-1 h-5 overflow-hidden">
                <div className="w-full bg-track-mic/20 border border-track-mic/40 rounded px-2 flex items-center justify-between text-[10px] text-track-mic">
                  <span>WASAPI 48kHz WAV</span>
                  <span className="font-mono text-[9px] opacity-70">No Drift</span>
                </div>
              </div>
            </div>

            {/* Track 4: Zoom Keyframes -- track-title */}
            <div
              onClick={(e) => {
                e.stopPropagation()
                setSelectedTrack("zoom")
              }}
              className={`h-8 rounded-md flex items-center px-2 border text-xs cursor-pointer transition-all ${
                selectedTrack === "zoom"
                  ? "bg-surface border-track-title shadow"
                  : "bg-surface-dim border-border hover:border-border-strong"
              }`}
            >
              <div className="w-24 flex items-center gap-1.5 text-track-title font-medium text-[11px] shrink-0">
                <ZoomIn className="w-3 h-3 text-track-title" />
                <span>Smart Zoom</span>
              </div>
              <div className="flex-1 flex gap-1 h-5 overflow-hidden items-center pl-16">
                <div className="w-36 bg-track-title/20 border border-track-title/50 rounded px-2 py-0.5 text-[9px] font-mono text-track-title">
                  🔍 1.5x Auto-Focus Segment
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Action Notification Toast */}
      {actionNotice && (
        <div className="mt-3 p-2.5 rounded-lg bg-surface border border-primary/50 text-xs text-track-screen flex items-center gap-2">
          <Check className="w-4 h-4 text-track-screen shrink-0" />
          <span>{actionNotice}</span>
        </div>
      )}

      {/* Bottom Summary Bar */}
      <div className="mt-4 pt-3 border-t border-border flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span>
            Active Track: <strong className="text-foreground capitalize">{selectedTrack}</strong>
          </span>
          <span>•</span>
          <span>
            Total Splits: <strong className="text-foreground">{splitCount} cuts</strong>
          </span>
          <span>•</span>
          <span className="text-track-mic font-medium">Non-Destructive Session Journal</span>
        </div>
        <div className="text-[11px] text-subtle-foreground">Click anywhere on the ruler to seek</div>
      </div>
    </div>
  )
}
