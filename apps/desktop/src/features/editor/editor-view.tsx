import { useEffect, useMemo, useRef, useState } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { Button } from "@recordforge/ui"
import type {
  MediaJob,
  MediaMetadata,
  ThumbnailManifest,
  WaveformData,
} from "@recordforge/contracts"
import { getMediaJob, getMediaMetadata, listMediaJobs } from "../../lib/media"

interface EditorViewProps {
  recordingId: string
  onClose: () => void
}

// Dedicated editor view for a prepared recording.
// Loads the proxy, thumbnails, waveform, and metadata produced by a prepare job.
export function EditorView({ recordingId, onClose }: EditorViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [job, setJob] = useState<MediaJob | null>(null)
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null)
  const [manifest, setManifest] = useState<ThumbnailManifest | null>(null)
  const [waveformData, setWaveformData] = useState<WaveformData | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        const jobs = await listMediaJobs(recordingId)
        const completed = jobs.find((j) => j.status === "completed")
        const latest = completed ?? (jobs.length > 0 ? jobs[0] : null)

        if (latest) {
          const full = await getMediaJob(latest.id)
          if (!cancelled) setJob(full)

          if (full.outputs.thumbnailManifestPath) {
            try {
              const response = await fetch(convertFileSrc(full.outputs.thumbnailManifestPath))
              const json = await response.json()
              setManifest(json as ThumbnailManifest)
            } catch (e) {
              console.warn("Failed to load thumbnail manifest:", e)
            }
          }

          if (full.outputs.waveformPath) {
            try {
              const response = await fetch(convertFileSrc(full.outputs.waveformPath))
              const json = await response.json()
              setWaveformData(json as WaveformData)
            } catch (e) {
              console.warn("Failed to load waveform data:", e)
            }
          }
        }

        const meta = await getMediaMetadata(recordingId)
        if (!cancelled) setMetadata(meta)
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [recordingId])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const el = video
    function handleTimeUpdate() {
      setCurrentTime(el.currentTime * 1000)
    }

    video.addEventListener("timeupdate", handleTimeUpdate)
    return () => video.removeEventListener("timeupdate", handleTimeUpdate)
  }, [job?.outputs.proxyPath])

  const durationMs = metadata?.durationMs ?? waveformData?.durationMs ?? 0
  const proxyUrl = useMemo(
    () => (job?.outputs.proxyPath ? convertFileSrc(job.outputs.proxyPath) : null),
    [job?.outputs.proxyPath],
  )
  const spriteUrl = useMemo(
    () => (manifest?.spritePath ? convertFileSrc(manifest.spritePath) : null),
    [manifest?.spritePath],
  )
  const waveformImageUrl = useMemo(
    () => (job?.outputs.waveformImagePath ? convertFileSrc(job.outputs.waveformImagePath) : null),
    [job?.outputs.waveformImagePath],
  )

  const thumbIndex = useMemo(() => {
    if (!manifest || manifest.intervalMs <= 0 || durationMs <= 0) return 0
    const idx = Math.floor(currentTime / manifest.intervalMs)
    return Math.min(idx, manifest.count - 1)
  }, [currentTime, manifest, durationMs])

  function handleSeek(percent: number) {
    const video = videoRef.current
    if (!video || durationMs <= 0) return
    const nextMs = percent * durationMs
    video.currentTime = nextMs / 1000
    setCurrentTime(nextMs)
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-foreground/70">Loading editor...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4 p-4">
        <p className="text-sm text-red-600">{error}</p>
        <Button onClick={onClose}>Close editor</Button>
      </div>
    )
  }

  if (!job || job.status !== "completed" || !proxyUrl) {
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
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Editor</h2>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          src={proxyUrl}
          className="h-full w-full"
          controls
          preload="metadata"
        />
      </div>

      {waveformImageUrl ? (
        <div className="h-24 w-full overflow-hidden rounded-lg bg-muted">
          <img src={waveformImageUrl} alt="Waveform" className="h-full w-full object-fill" />
        </div>
      ) : null}

      {spriteUrl && manifest ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground/70">Thumbnails</p>
          <div
            className="h-16 w-28 overflow-hidden rounded bg-muted"
            style={{
              backgroundImage: `url(${spriteUrl})`,
              backgroundPosition: thumbnailPosition(manifest, thumbIndex),
              backgroundSize: `${manifest.columns * 100}% ${manifest.rows * 100}%`,
            }}
            aria-label="Current thumbnail"
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-foreground/70">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(durationMs)}</span>
        </div>
        <div
          className="h-2 w-full cursor-pointer overflow-hidden rounded-full bg-muted"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const percent = (e.clientX - rect.left) / rect.width
            handleSeek(percent)
          }}
          role="slider"
          aria-valuenow={Math.round(currentTime)}
          aria-valuemin={0}
          aria-valuemax={durationMs}
          aria-label="Timeline"
        >
          <div
            className="h-full bg-primary"
            style={{ width: `${durationMs > 0 ? (currentTime / durationMs) * 100 : 0}%` }}
          />
        </div>
      </div>
    </div>
  )
}

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function thumbnailPosition(manifest: ThumbnailManifest, index: number) {
  const col = index % manifest.columns
  const row = Math.floor(index / manifest.columns)
  const x = manifest.columns > 1 ? (col / (manifest.columns - 1)) * 100 : 0
  const y = manifest.rows > 1 ? (row / (manifest.rows - 1)) * 100 : 0
  return `${x}% ${y}%`
}
