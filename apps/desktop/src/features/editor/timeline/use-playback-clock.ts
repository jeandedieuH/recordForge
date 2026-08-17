import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { TimelineState } from "@recordforge/contracts"
import {
  createPlaybackClock,
  shouldCorrectDrift,
  type PlaybackBoundary,
  type PlaybackClock,
  type PreviewQualityMode,
} from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"
import { usePlayheadMs } from "./use-playback-state"

interface UsePlaybackClockOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>
  timeline: TimelineState | null
  previewQuality: PreviewQualityMode
  mediaUrl?: string | null
  onSeek: (ms: number) => void
  onPlayNext?: (boundary: PlaybackBoundary) => void
  onPause?: () => void
}

/**
 * Drive the preview playhead from the video element's frame clock.
 *
 * Uses `requestVideoFrameCallback` when available and falls back to polling
 * `video.currentTime` via `requestAnimationFrame` for older runtimes. The hook
 * is deliberately isolated: it only touches the playhead and the media element,
 * and it reports drift metrics for monitoring.
 */
export function usePlaybackClock({
  videoRef,
  timeline,
  previewQuality,
  mediaUrl,
  onSeek,
  onPlayNext,
  onPause,
}: UsePlaybackClockOptions): { isReady: boolean } {
  const playheadMs = usePlayheadMs()
  const isPlaying = useTimelineStore((state) => state.view.isPlaying)
  const playbackRate = useTimelineStore((state) => state.view.playbackRate)
  const clock = useMemo<PlaybackClock | null>(() => {
    if (!timeline) return null
    return createPlaybackClock(timeline, { mode: previewQuality, fps: timeline.canvas.fps })
  }, [timeline, previewQuality])

  const [isReady, setIsReady] = useState(false)

  const playheadRef = useRef(playheadMs)
  const drivenPlayheadRef = useRef(playheadMs)
  const isPlayingRef = useRef(isPlaying)
  const playbackRateRef = useRef(playbackRate)
  const clipIdRef = useRef<string | null>(null)
  const onSeekRef = useRef(onSeek)
  const onPlayNextRef = useRef(onPlayNext)
  const onPauseRef = useRef(onPause)
  const vfcRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const gapRafRef = useRef<number | null>(null)

  useEffect(() => {
    playheadRef.current = playheadMs
    // If the authoritative playhead has jumped (e.g. user seek while paused),
    // reset the driven playhead so the frame loop starts from the right place.
    if (Math.abs(drivenPlayheadRef.current - playheadMs) > (clock?.frameMs ?? 33) * 2) {
      drivenPlayheadRef.current = playheadMs
    }
  }, [playheadMs, clock])

  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  useEffect(() => {
    playbackRateRef.current = playbackRate
  }, [playbackRate])

  useEffect(() => {
    onSeekRef.current = onSeek
  }, [onSeek])

  useEffect(() => {
    onPlayNextRef.current = onPlayNext
  }, [onPlayNext])

  useEffect(() => {
    onPauseRef.current = onPause
  }, [onPause])

  const syncVideo = useCallback(() => {
    const video = videoRef.current
    if (!video || !clock) {
      setIsReady(false)
      return
    }

    const position = clock.mapTimelineToSource(playheadRef.current, playbackRateRef.current)
    if (!position) {
      video.pause()
      video.style.visibility = "hidden"
      clipIdRef.current = null
      return
    }

    video.style.visibility = "visible"
    clipIdRef.current = position.clipId
    video.playbackRate = position.playbackRate

    const sourceSeconds = position.sourceMs / 1000
    const previousDrivenMs = drivenPlayheadRef.current
    const playheadJumpMs = Math.abs(playheadRef.current - previousDrivenMs)

    // The playhead is driven from the video frame clock during playback, so
    // we only force the video element to a new time when the playhead has
    // jumped (user seek / boundary) or when we are not currently playing.
    // Chasing the video time on every playhead update creates a feedback loop
    // where the playhead appears to dance between two frames.
    const shouldSeekVideo = !isPlayingRef.current || playheadJumpMs > clock.frameMs * 2
    if (shouldSeekVideo) {
      const driftSeconds = Math.abs(video.currentTime - sourceSeconds)
      if (driftSeconds > (clock.frameMs * 2) / 1000) {
        video.currentTime = sourceSeconds
      }
    }

    // Keep the driven playhead in sync with the authoritative playhead so the
    // frame loop does not fight a user seek or boundary transition.
    drivenPlayheadRef.current = playheadRef.current
    setIsReady(true)
  }, [clock, videoRef])

  // Sync the media element when the user explicitly seeks or toggles playback.
  useEffect(() => {
    syncVideo()
    const video = videoRef.current
    if (!video) return

    if (isPlaying) {
      video.play().catch(() => {
        onPauseRef.current?.()
      })
    } else {
      video.pause()
    }
  }, [playheadMs, isPlaying, playbackRate, previewQuality, mediaUrl, syncVideo, videoRef])

  const handleFrame = useCallback(
    (sourceMs: number) => {
      if (!clock) return
      const mapped = clock.mapSourceToTimeline(sourceMs, {
        preferClipId: clipIdRef.current ?? undefined,
      })
      if (mapped) {
        const rounded = clock.roundToFrame(mapped.timelineMs)
        clock.reportDrift(drivenPlayheadRef.current, rounded)
        // Drive the playhead from the video frame clock. The driven playhead is
        // updated immediately here so we do not need to wait for the next React
        // render to see the new position; the playhead ref follows on the next
        // render and keeps the sync effect from fighting user seeks.
        if (shouldCorrectDrift(clock, drivenPlayheadRef.current, rounded)) {
          onSeekRef.current(rounded)
          drivenPlayheadRef.current = rounded
        }
        clipIdRef.current = mapped.clipId
      }

      const position = clock.mapTimelineToSource(drivenPlayheadRef.current, playbackRateRef.current)
      if (!position) return
      if (sourceMs >= position.clip.sourceOutMs - clock.frameMs * 2) {
        const boundary = clock.nextBoundary(playheadRef.current)
        if (!boundary) return
        if (boundary.kind === "end") {
          onPauseRef.current?.()
        } else {
          onPlayNextRef.current?.(boundary)
        }
      }
    },
    [clock],
  )

  useEffect(() => {
    const video = videoRef.current
    if (!video || !clock) return

    function hasFrameCallback(element: HTMLVideoElement | null): boolean {
      if (!element) return false
      return (
        typeof (element as HTMLVideoElement & { requestVideoFrameCallback?: unknown })
          .requestVideoFrameCallback === "function"
      )
    }

    function scheduleNext() {
      if (hasFrameCallback(video)) {
        const callback: VideoFrameRequestCallback = (_now, metadata) => {
          if (!isPlayingRef.current) return
          handleFrame(metadata.mediaTime * 1000)
          if (isPlayingRef.current) {
            vfcRef.current = (
              video as HTMLVideoElement & {
                requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => number
              }
            ).requestVideoFrameCallback(callback)
          }
        }
        vfcRef.current = (
          video as HTMLVideoElement & {
            requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => number
          }
        ).requestVideoFrameCallback(callback)
        return
      }

      // Fallback: poll currentTime on animation frames.
      const step = () => {
        if (!isPlayingRef.current) return
        const currentVideo = videoRef.current
        if (!currentVideo) return
        const sourceMs = currentVideo.currentTime * 1000
        handleFrame(sourceMs)
        rafRef.current = requestAnimationFrame(step)
      }
      rafRef.current = requestAnimationFrame(step)
    }

    if (isPlaying) {
      scheduleNext()
    }

    return () => {
      if (vfcRef.current && hasFrameCallback(video)) {
        ;(
          video as HTMLVideoElement & { cancelVideoFrameCallback: (handle: number) => void }
        ).cancelVideoFrameCallback(vfcRef.current)
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
      vfcRef.current = null
      rafRef.current = null
    }
  }, [clock, handleFrame, isPlaying, mediaUrl, videoRef])

  // Animation-frame clock for gaps where the screen video has no active clip.
  useEffect(() => {
    if (!isPlaying || !clock) return

    let lastTime = performance.now()
    const step = (now: number) => {
      if (!isPlayingRef.current || !clock) return
      const elapsed = now - lastTime
      lastTime = now
      const position = clock.mapTimelineToSource(drivenPlayheadRef.current, playbackRateRef.current)
      if (!position) {
        const next = clock.advanceFrame(drivenPlayheadRef.current, elapsed, playbackRateRef.current)
        if (next !== drivenPlayheadRef.current) {
          onSeekRef.current(next)
          drivenPlayheadRef.current = next
        }
      }
      gapRafRef.current = requestAnimationFrame(step)
    }

    gapRafRef.current = requestAnimationFrame(step)
    return () => {
      if (gapRafRef.current) {
        cancelAnimationFrame(gapRafRef.current)
      }
      gapRafRef.current = null
    }
  }, [clock, isPlaying])

  return { isReady }
}
