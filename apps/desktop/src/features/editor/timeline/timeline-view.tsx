import { useEffect, useMemo, useRef, useState } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import {
  Eye,
  Lock,
  Mic,
  Monitor,
  Pause,
  Play,
  Scissors,
  SkipBack,
  SkipForward,
  Video,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { Slider } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { ClipInspector } from "./clip-inspector"

interface TimelineViewProps {
  recordingId: string
  onClose: () => void
  onOpenExport?: () => void
}

export function TimelineView({ recordingId, onClose, onOpenExport }: TimelineViewProps) {
  const store = useTimelineStore()
  const view = store.view
  const videoRef = useRef<HTMLVideoElement>(null)
  const [selectedClipId, setSelectedClipId] = useState<string>("webcam-clip")
  const [zoomLevel, setZoomLevel] = useState([50])

  useEffect(() => {
    void store.load(recordingId)
  }, [recordingId, store])

  // Subscribe to media-job-update events so the editor shows proxy/export
  // progress without requiring the user to close and reopen it.
  useEffect(() => {
    void store.startListening()
    return () => {
      store.stopListening()
    }
  }, [store])

  const proxyUrl = useMemo(() => {
    const path = store.activeJob?.outputs?.proxyPath
    return path ? convertFileSrc(path) : null
  }, [store.activeJob])

  return (
    <div className="flex h-full flex-col bg-background text-foreground select-none overflow-hidden">
      {/* Upper Area: Video Preview Canvas + Inspector */}
      <div className="flex flex-1 min-h-0 border-b border-border">
        {/* Main Video Viewport & Floating Transport */}
        <div className="flex flex-1 flex-col items-center justify-between p-6 bg-background">
          {/* Resolution Badge Header & Close Button */}
          <div className="self-start w-full flex items-center justify-between">
            <div className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-mono font-medium text-muted-foreground">
              <span className="size-2 rounded-full bg-success" />
              <span>1920x1080 • 60fps</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-subtle-foreground hover:bg-overlay hover:text-foreground transition-colors"
              title="Close Editor"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Video Player Monitor Container */}
          <div className="relative aspect-video max-h-105 w-full max-w-4xl overflow-hidden rounded-xl border border-border bg-black shadow-2xl flex items-center justify-center">
            {proxyUrl ? (
              <video
                ref={videoRef}
                src={proxyUrl}
                className="h-full w-full object-contain"
                playsInline
                onClick={() => store.togglePlay()}
              />
            ) : (
              <div className="relative flex h-full w-full items-center justify-center bg-surface-dim">
                {/* Grid Overlay */}
                <div className="absolute inset-0 opacity-15 bg-[radial-gradient(var(--color-primary)_1px,transparent_1px)] bg-size-[16px_16px]" />
                <div className="z-10 flex flex-col items-center gap-2">
                  <Monitor className="size-16 text-primary/40" />
                  <span className="font-mono text-sm font-semibold text-muted-foreground">
                    Product Demo Q3
                  </span>
                </div>
              </div>
            )}

            {/* Webcam Picture-In-Picture Overlay */}
            <div className="absolute bottom-4 right-4 flex aspect-video w-48 items-center justify-center rounded-lg border border-primary/60 bg-surface shadow-2xl overflow-hidden">
              <div className="flex flex-col items-center gap-1 text-subtle-foreground">
                <Video className="size-6 text-tertiary" />
                <span className="text-[10px] font-mono font-semibold text-foreground">
                  Webcam PIP
                </span>
              </div>
            </div>
          </div>

          {/* Floating Playback Controls Bar */}
          <div className="flex items-center gap-4 rounded-xl border border-border bg-surface/90 px-5 py-2.5 shadow-xl backdrop-blur">
            <button
              type="button"
              onClick={() => store.seek(0)}
              className="text-subtle-foreground hover:text-foreground transition-colors"
              title="Skip Back"
            >
              <SkipBack className="size-4" />
            </button>

            <button
              type="button"
              onClick={() => store.togglePlay()}
              className="flex size-9 items-center justify-center rounded-lg bg-primary text-white transition-transform hover:scale-105 shadow"
            >
              {view.isPlaying ? (
                <Pause className="size-4 fill-white" />
              ) : (
                <Play className="size-4 fill-white ml-0.5" />
              )}
            </button>

            <button
              type="button"
              onClick={() => store.seek(view.durationMs)}
              className="text-subtle-foreground hover:text-foreground transition-colors"
              title="Skip Forward"
            >
              <SkipForward className="size-4" />
            </button>

            <div className="h-4 w-px bg-border" />

            <div className="font-mono text-xs font-bold tracking-widest text-muted-foreground">
              00:04:12:15
            </div>

            {onOpenExport ? (
              <button
                type="button"
                onClick={onOpenExport}
                className="ml-2 rounded-md bg-tertiary px-3 py-1 text-xs font-medium text-white hover:bg-tertiary-hover"
              >
                Export
              </button>
            ) : null}
          </div>
        </div>

        {/* Right Inspector Sidebar */}
        <ClipInspector clipId={selectedClipId} onClear={() => setSelectedClipId("")} />
      </div>

      {/* Lower Area: Multi-Track Timeline */}
      <div className="flex h-72 flex-col bg-surface-dim">
        {/* Timeline Toolbar */}
        <div className="flex h-10 items-center justify-between border-b border-border px-4 select-none">
          {/* Tool actions left */}
          <div className="flex items-center gap-1 rounded-md border border-border bg-surface p-1">
            <button
              type="button"
              className="rounded p-1 text-foreground bg-overlay"
              title="Select Tool"
            >
              <Play className="size-3.5 -rotate-90 fill-white" />
            </button>
            <button
              type="button"
              className="rounded p-1 text-subtle-foreground hover:text-foreground"
              title="Split Tool (Scissors)"
            >
              <Scissors className="size-3.5" />
            </button>
          </div>

          {/* Zoom Controls right */}
          <div className="flex items-center gap-3">
            <ZoomOut className="size-3.5 text-subtle-foreground" />
            <Slider
              value={zoomLevel}
              onValueChange={setZoomLevel}
              max={100}
              step={1}
              className="w-32"
            />
            <ZoomIn className="size-3.5 text-subtle-foreground" />
          </div>
        </div>

        {/* Timeline Ruler & Playhead Lane */}
        <div className="relative flex flex-1 overflow-x-auto overflow-y-auto">
          {/* Track Headers (Left Column) */}
          <div className="w-56 shrink-0 border-r border-border bg-surface-dim flex flex-col">
            {/* Ruler Header Blank Corner */}
            <div className="h-8 border-b border-border bg-surface-dim" />

            {/* Track Header Items */}
            <div className="flex h-12 items-center justify-between border-b border-border px-4 text-xs font-semibold text-muted-foreground">
              <div className="flex items-center gap-2">
                <Monitor className="size-4 text-track-screen" />
                <span>Screen</span>
              </div>
            </div>

            <div className="flex h-12 items-center justify-between border-b border-border px-4 text-xs font-semibold text-muted-foreground">
              <div className="flex items-center gap-2">
                <Video className="size-4 text-track-webcam" />
                <span>Webcam</span>
              </div>
              <div className="flex items-center gap-2 text-subtle-foreground">
                <Eye className="size-3.5 cursor-pointer hover:text-foreground" />
                <Lock className="size-3.5 cursor-pointer hover:text-foreground" />
              </div>
            </div>

            <div className="flex h-12 items-center justify-between border-b border-border px-4 text-xs font-semibold text-muted-foreground">
              <div className="flex items-center gap-2">
                <Mic className="size-4 text-track-mic" />
                <span>Mic Audio</span>
              </div>
            </div>
          </div>

          {/* Timeline Tracks Lane */}
          <div className="relative flex flex-1 flex-col min-w-200 bg-surface-dim">
            {/* Time Ruler */}
            <div className="flex h-8 items-center border-b border-border px-4 font-mono text-[11px] text-subtle-foreground gap-24">
              <span>00:01</span>
              <span>00:02</span>
              <span>00:03</span>
              <span className="text-foreground font-bold">00:04</span>
              <span>00:05</span>
              <span>00:06</span>
            </div>

            {/* Playhead vertical line */}
            <div className="absolute top-0 bottom-0 left-85 z-20 w-0.5 bg-primary shadow-[0_0_8px_var(--color-primary)]">
              <div className="absolute -top-1 -left-1.5 size-3 rotate-45 rounded-xs bg-primary" />
            </div>

            {/* Track 1: Screen Clip Lane */}
            <div className="relative flex h-12 items-center border-b border-border px-4">
              <div className="absolute left-32 flex h-8 w-72 items-center rounded-lg border border-primary/50 bg-primary/20 px-3 font-mono text-xs text-foreground">
                Screen_Rec_01.mp4
              </div>
            </div>

            {/* Track 2: Webcam Clip Lane */}
            <div className="relative flex h-12 items-center border-b border-border px-4">
              <div className="absolute left-64 flex h-8 w-60 items-center rounded-lg border border-tertiary/50 bg-tertiary/20 px-3 font-mono text-xs text-foreground">
                Webcam_01.mp4
              </div>
            </div>

            {/* Track 3: Mic Audio Waveform Clip Lane */}
            <div className="relative flex h-12 items-center border-b border-border px-4">
              <div className="absolute left-32 flex h-8 w-96 items-center rounded-lg border border-track-mic/50 bg-track-mic/20 px-3 font-mono text-xs text-foreground">
                Mic_Audio.wav
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
