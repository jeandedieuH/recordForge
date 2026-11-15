import { useEffect, useRef } from "react"
import type { VideoClip } from "@recordforge/contracts"
import { videoLayerPoseAt, videoLayerSourceMs } from "@recordforge/editor-core"
import { cn } from "@recordforge/ui"
import { usePlayheadMs } from "../timeline/use-playback-state"

/** One b-roll layer with the track's mute/volume applied. */
export interface VideoLayerPreviewItem {
  clip: VideoClip
  muted: boolean
  volume: number
}

interface VideoLayerOverlayProps {
  /** Layers in paint order (first = bottom). */
  layers: VideoLayerPreviewItem[]
  isPlaying: boolean
  playbackRate: number
  canvasWidth: number
  canvasHeight: number
  assetUrls: Record<string, string>
  selectedClipId?: string | null
  className?: string
}

function isActive(clip: VideoClip, playheadMs: number): boolean {
  return (
    clip.enabled !== false &&
    playheadMs >= clip.startMs &&
    playheadMs < clip.startMs + clip.durationMs
  )
}

/**
 * Preview surface for b-roll / media-track video (#13). One `<video>` per active
 * layer, positioned and faded by the same `video-layers` resolver the render
 * plan samples into keyframes, so the canvas matches the exported file.
 */
export function VideoLayerOverlay({
  layers,
  isPlaying,
  playbackRate,
  canvasWidth,
  canvasHeight,
  assetUrls,
  selectedClipId,
  className,
}: VideoLayerOverlayProps) {
  const playheadMs = usePlayheadMs()
  return (
    <div
      className={cn("pointer-events-none absolute inset-0 size-full overflow-hidden", className)}
    >
      {layers.map(({ clip, muted, volume }) => {
        if (!isActive(clip, playheadMs)) return null
        return (
          <VideoLayerSurface
            key={clip.id}
            clip={clip}
            muted={muted}
            volume={volume}
            playheadMs={playheadMs}
            isPlaying={isPlaying}
            playbackRate={playbackRate}
            canvasWidth={canvasWidth}
            canvasHeight={canvasHeight}
            src={assetUrls[clip.assetId] ?? null}
            selected={selectedClipId === clip.id}
          />
        )
      })}
    </div>
  )
}

interface VideoLayerSurfaceProps {
  clip: VideoClip
  muted: boolean
  volume: number
  playheadMs: number
  isPlaying: boolean
  playbackRate: number
  canvasWidth: number
  canvasHeight: number
  src: string | null
  selected: boolean
}

function VideoLayerSurface({
  clip,
  muted,
  volume,
  playheadMs,
  isPlaying,
  playbackRate,
  canvasWidth,
  canvasHeight,
  src,
  selected,
}: VideoLayerSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const sourceMs = videoLayerSourceMs(clip, playheadMs)
  const pose = videoLayerPoseAt(clip, { width: canvasWidth, height: canvasHeight }, playheadMs)

  // Keep the element near the timeline position: free-run while playing and
  // re-seek only when the drift is visible. Scrubbing seeks exactly.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!src) return
    const targetSec = Math.max(0, sourceMs) / 1000
    const drift = Math.abs(video.currentTime - targetSec)
    if (!isPlaying || drift > 0.28) {
      if (drift > 0.02) video.currentTime = targetSec
    }
    if (isPlaying) {
      video.playbackRate = Math.min(4, Math.max(0.25, playbackRate))
      if (video.paused) void video.play().catch(() => undefined)
    } else if (!video.paused) {
      video.pause()
    }
  }, [isPlaying, playbackRate, sourceMs, src])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = muted
    video.volume = Math.min(1, Math.max(0, volume))
  }, [muted, volume])

  const leftPercent = (pose.rect.x / canvasWidth) * 100
  const topPercent = (pose.rect.y / canvasHeight) * 100
  const widthPercent = (pose.rect.width / canvasWidth) * 100
  const heightPercent = (pose.rect.height / canvasHeight) * 100
  const fit = clip.layoutMode === "fullscreen" ? "cover" : clip.fit

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute select-none", selected && "ring-2 ring-info")}
      style={{
        left: `${leftPercent}%`,
        top: `${topPercent}%`,
        width: `${widthPercent}%`,
        height: `${heightPercent}%`,
        opacity: pose.opacity,
        transform: `rotate(${clip.rotation}deg)`,
        transformOrigin: `${clip.anchorX * 100}% ${clip.anchorY * 100}%`,
        borderRadius: `${clip.borderRadius}px`,
        border:
          clip.borderWidth > 0 ? `${clip.borderWidth}px solid ${clip.borderColor}` : undefined,
        boxShadow: clip.shadowEnabled
          ? `${clip.shadowColor} 0 4px ${clip.shadowBlur}px`
          : undefined,
      }}
    >
      {src ? (
        <video
          ref={videoRef}
          src={src}
          preload="auto"
          playsInline
          className="size-full"
          style={{ objectFit: fit, borderRadius: `${clip.borderRadius}px` }}
        />
      ) : (
        <div
          className="flex size-full items-center justify-center bg-surface-dim/70 text-[10px] text-muted-foreground"
          style={{ borderRadius: `${clip.borderRadius}px` }}
        >
          Video clip
        </div>
      )}
    </div>
  )
}
