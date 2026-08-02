import { useEffect, useMemo, useRef, useState } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { Button } from "@recordforge/ui"
import {
  createAddCaptionClipCommand,
  createAddMarkerCommand,
  createAddTrackCommand,
  createDeleteMarkerCommand,
  formatTime,
} from "@recordforge/editor-core"
import { Input, Progress } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { ClipInspector } from "./clip-inspector"
import { ExportPanel } from "./export-panel"
import { Playhead } from "./playhead"
import { TimelineMarkerView } from "./timeline-marker"
import { TimelineRuler } from "./timeline-ruler"
import { TimelineToolbar } from "./timeline-toolbar"
import { TimelineTrack } from "./timeline-track"

interface TimelineViewProps {
  recordingId: string
  onClose: () => void
}

// Compute the source path for the small waveform image from the active prepare job.
function useWaveformImageUrl() {
  const job = useTimelineStore((state) => state.activeJob)
  return useMemo(() => {
    if (!job?.outputs?.waveformImagePath) return null
    return convertFileSrc(job.outputs.waveformImagePath)
  }, [job])
}

// Main timeline editor view. Loads the timeline, renders the preview, and
// composes the ruler, tracks, playhead, markers, and edit panels.
export function TimelineView({ recordingId, onClose }: TimelineViewProps) {
  const store = useTimelineStore()
  const engine = store.engine
  const view = store.view
  const videoRef = useRef<HTMLVideoElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [markerLabel, setMarkerLabel] = useState("")
  const [captionText, setCaptionText] = useState("")

  useEffect(() => {
    void store.load(recordingId)
    void store.startListening()
    return () => {
      store.stopListening()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId])

  const proxyUrl = useMemo(() => {
    const path = store.activeJob?.outputs?.proxyPath
    return path ? convertFileSrc(path) : null
  }, [store.activeJob])

  const waveformUrl = useWaveformImageUrl()

  // Keep the playhead in sync with the playing video.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handler = () => store.seek(video.currentTime * 1000)
    video.addEventListener("timeupdate", handler)
    return () => video.removeEventListener("timeupdate", handler)
  }, [store])

  // Play/pause the video when the store playback state changes.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (view.isPlaying) {
      void video.play()
    } else {
      video.pause()
    }
  }, [view.isPlaying])

  // When the user seeks via the timeline, jump the video to the new time.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const threshold = view.isPlaying ? 250 : 100
    const diff = Math.abs(video.currentTime * 1000 - view.playheadMs)
    if (diff > threshold) {
      video.currentTime = view.playheadMs / 1000
    }
  }, [view.playheadMs, view.isPlaying])

  const contentWidth = useMemo(
    () => Math.max(320, (engine ? view.durationMs : 0) / view.zoom),
    [view.durationMs, view.zoom, engine],
  )

  function handleRulerClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const scrollLeft = scrollRef.current?.scrollLeft ?? 0
    const contentX = x + scrollLeft
    const ms = contentX * view.zoom
    store.seek(ms)
  }

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    store.setScroll(e.currentTarget.scrollLeft * view.zoom)
  }

  function handleAddMarker() {
    store.execute(createAddMarkerCommand(view.playheadMs, markerLabel || "Marker"))
    setMarkerLabel("")
  }

  function handleDeleteMarker(id: string) {
    store.execute(createDeleteMarkerCommand(id))
  }

  function handleAddCaption() {
    const captionsTrack = engine?.history.present.tracks.find((t) => t.kind === "captions")
    if (!captionsTrack) {
      store.execute(createAddTrackCommand("captions", "Captions"))
      return
    }
    if (!captionText) return
    store.execute(
      createAddCaptionClipCommand(captionsTrack.id, captionText, view.playheadMs, 3_000),
    )
    setCaptionText("")
  }

  if (store.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-foreground/70">Loading timeline...</p>
      </div>
    )
  }

  if (store.error) {
    return (
      <div className="space-y-4 p-4">
        <p className="text-sm text-red-600">{store.error}</p>
        <Button onClick={store.clearError}>Dismiss</Button>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    )
  }

  if (!proxyUrl) {
    return (
      <div className="space-y-4 p-4">
        <p className="text-sm text-foreground/70">
          This recording has not been prepared for editing yet. Run the prepare job from the library
          first.
        </p>
        <Button onClick={onClose}>Close editor</Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{engine?.history.present.name ?? "Editor"}</h2>
          <p className="text-sm text-foreground/70">
            {formatTime(view.durationMs)} at {engine?.history.present.canvas.fps} fps
          </p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      <TimelineToolbar />

      <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          src={proxyUrl}
          className="h-full w-full"
          preload="metadata"
          playsInline
          onClick={() => store.togglePlay()}
        />
      </div>

      {waveformUrl ? (
        <div className="h-24 w-full overflow-hidden rounded-lg bg-muted">
          <img src={waveformUrl} alt="Waveform" className="h-full w-full object-fill" />
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="relative flex-1 overflow-x-auto overflow-y-hidden rounded-lg border border-border bg-background"
        onScroll={handleScroll}
        role="none"
      >
        <div style={{ minWidth: `${contentWidth}px` }}>
          <TimelineRuler width={contentWidth} onClick={handleRulerClick} />

          <div className="relative">
            {engine?.history.present.markers.map((marker) => (
              <TimelineMarkerView
                key={marker.id}
                marker={marker}
                onClick={(m) => store.seek(m.timeMs)}
              />
            ))}
          </div>

          <div className="relative">
            {engine?.history.present.tracks.map((track) => (
              <TimelineTrack
                key={track.id}
                track={track}
                laneWidth={contentWidth}
                selectedClipId={selectedClipId}
                onSelectClip={setSelectedClipId}
              />
            ))}
          </div>

          <Playhead />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 rounded-lg border border-border bg-muted p-4">
          <h3 className="text-sm font-medium">Markers</h3>
          <div className="flex gap-2">
            <Input
              placeholder="Marker label"
              value={markerLabel}
              onChange={(e) => setMarkerLabel(e.target.value)}
            />
            <Button onClick={handleAddMarker}>Add</Button>
          </div>
          <ul className="max-h-32 space-y-1 overflow-y-auto text-sm">
            {engine?.history.present.markers.map((m) => (
              <li key={m.id} className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => store.seek(m.timeMs)}
                  className="truncate text-foreground/80 hover:text-foreground"
                >
                  {formatTime(m.timeMs)} — {m.label}
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteMarker(m.id)}
                  className="text-red-600 hover:text-red-700"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-muted p-4">
          <h3 className="text-sm font-medium">Captions</h3>
          <div className="flex gap-2">
            <Input
              placeholder="Caption text"
              value={captionText}
              onChange={(e) => setCaptionText(e.target.value)}
            />
            <Button onClick={handleAddCaption}>Add</Button>
          </div>
          <p className="text-xs text-foreground/60">
            Adds a caption clip at the playhead on a captions track.
          </p>
        </div>

        <ClipInspector clipId={selectedClipId ?? ""} onClear={() => setSelectedClipId(null)} />
      </div>

      <ExportPanel />

      {store.activeExportJob ? (
        <div className="space-y-1.5 rounded-lg border border-border bg-muted p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="capitalize text-foreground/80">{store.activeExportJob.stage}</span>
            <span className="text-foreground/60">
              {Math.round(store.activeExportJob.progress * 100)}%
            </span>
          </div>
          <Progress value={store.activeExportJob.progress} />
          {store.activeExportJob.error ? (
            <p className="text-xs text-red-600">{store.activeExportJob.error}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
