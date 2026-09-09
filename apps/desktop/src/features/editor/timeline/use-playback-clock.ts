import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { TimelineState } from "@recordforge/contracts"
import {
  createPlaybackClock,
  findNextTimelineClip,
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
export interface UsePlaybackClockResult {
  isReady: boolean
  isSeeking: boolean
  videoProps: {
    onSeeking: () => void
    onSeeked: () => void
    onPlaying: () => void
    onCanPlay: () => void
    onTimeUpdate: () => void
  }
}

export function usePlaybackClock({
  videoRef,
  timeline,
  previewQuality,
  mediaUrl,
  onSeek,
  onPlayNext,
  onPause,
}: UsePlaybackClockOptions): UsePlaybackClockResult {
  const playheadMs = usePlayheadMs()
  const isPlaying = useTimelineStore((state) => state.view.isPlaying)
  const playbackRate = useTimelineStore((state) => state.view.playbackRate)
  const clock = useMemo<PlaybackClock | null>(() => {
    if (!timeline) return null
    return createPlaybackClock(timeline, { mode: previewQuality, fps: timeline.canvas.fps })
  }, [timeline, previewQuality])

  const [isReady, setIsReady] = useState(false)
  const [isSeeking, setIsSeeking] = useState(false)
  const isSeekingRef = useRef(false)

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

  // Keep refs synchronized immediately during render so callbacks never observe stale values
  playheadRef.current = playheadMs
  isPlayingRef.current = isPlaying
  playbackRateRef.current = playbackRate
  onSeekRef.current = onSeek
  onPlayNextRef.current = onPlayNext
  onPauseRef.current = onPause

  // If the authoritative playhead has jumped (e.g. user seek while paused),
  // reset the driven playhead so the frame loop starts from the right place.
  if (Math.abs(drivenPlayheadRef.current - playheadMs) > (clock?.frameMs ?? 33) * 2) {
    drivenPlayheadRef.current = playheadMs
  }

  const handleSeeking = useCallback(() => {
    isSeekingRef.current = true
    setIsSeeking(true)
  }, [])

  const handleSeeked = useCallback(() => {
    isSeekingRef.current = false
    setIsSeeking(false)
    const video = videoRef.current
    if (video && isPlayingRef.current && video.paused) {
      video.play().catch(() => {
        onPauseRef.current?.()
      })
    }
  }, [videoRef])

  const handlePlaying = useCallback(() => {
    const video = videoRef.current
    if (video && !video.seeking) {
      isSeekingRef.current = false
      setIsSeeking(false)
    }
  }, [videoRef])

  const handleCanPlay = useCallback(() => {
    const video = videoRef.current
    if (video && !video.seeking) {
      isSeekingRef.current = false
      setIsSeeking(false)
    }
  }, [videoRef])

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    if (video && !video.seeking && isSeekingRef.current) {
      isSeekingRef.current = false
      setIsSeeking(false)
    }
  }, [videoRef])

  const videoProps = useMemo(
    () => ({
      onSeeking: handleSeeking,
      onSeeked: handleSeeked,
      onPlaying: handlePlaying,
      onCanPlay: handleCanPlay,
      onTimeUpdate: handleTimeUpdate,
    }),
    [handleSeeking, handleSeeked, handlePlaying, handleCanPlay, handleTimeUpdate],
  )

  // Track video element seeking state to prevent seek-storms across cuts
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.addEventListener("seeking", handleSeeking)
    video.addEventListener("seeked", handleSeeked)
    video.addEventListener("playing", handlePlaying)
    video.addEventListener("canplay", handleCanPlay)
    video.addEventListener("timeupdate", handleTimeUpdate)

    if (!video.seeking && isSeekingRef.current) {
      isSeekingRef.current = false
      setIsSeeking(false)
    }

    return () => {
      video.removeEventListener("seeking", handleSeeking)
      video.removeEventListener("seeked", handleSeeked)
      video.removeEventListener("playing", handlePlaying)
      video.removeEventListener("canplay", handleCanPlay)
      video.removeEventListener("timeupdate", handleTimeUpdate)
    }
  }, [
    mediaUrl,
    videoRef,
    handleSeeking,
    handleSeeked,
    handlePlaying,
    handleCanPlay,
    handleTimeUpdate,
  ])

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
      if (isSeekingRef.current) {
        isSeekingRef.current = false
        setIsSeeking(false)
      }
      return
    }

    video.style.visibility = "visible"
    const isClipChanged = clipIdRef.current !== null && clipIdRef.current !== position.clipId
    clipIdRef.current = position.clipId
    video.playbackRate = position.playbackRate

    const sourceSeconds = position.sourceMs / 1000
    const previousDrivenMs = drivenPlayheadRef.current
    const playheadJumpMs = Math.abs(playheadRef.current - previousDrivenMs)

    // The playhead is driven from the video frame clock during playback, so
    // we only force the video element to a new time when the playhead has
    // jumped (user seek / boundary), the active clip changed across a cut,
    // or when we are not currently playing.
    // Chasing the video time on every playhead update creates a feedback loop
    // where the playhead appears to dance between two frames.
    const shouldSeekVideo =
      !isPlayingRef.current || isClipChanged || playheadJumpMs > clock.frameMs * 2

    if (shouldSeekVideo) {
      const driftSeconds = Math.abs(video.currentTime - sourceSeconds)
      if (driftSeconds > (clock.frameMs * 0.5) / 1000) {
        // Never assign video.currentTime while a seek is in-flight, which triggers
        // an abort-seek loop in Chromium/WebView2
        if (!isSeekingRef.current && !video.seeking) {
          isSeekingRef.current = true
          setIsSeeking(true)
          video.currentTime = sourceSeconds
        }
      }
    } else if (video && !video.seeking && isSeekingRef.current) {
      isSeekingRef.current = false
      setIsSeeking(false)
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
      if (video.paused) {
        video.play().catch(() => {
          onPauseRef.current?.()
        })
      }
    } else {
      if (!video.paused) {
        video.pause()
      }
    }
  }, [playheadMs, isPlaying, playbackRate, previewQuality, mediaUrl, syncVideo, videoRef])

  const handleFrame = useCallback(
    (sourceMs: number) => {
      if (!clock || !timeline) return
      const video = videoRef.current
      if (video && !video.seeking) {
        if (isSeekingRef.current) {
          isSeekingRef.current = false
          setIsSeeking(false)
        }
      }
      // If a seek is currently in flight in the browser video element, skip intermediate frame updates
      if (video?.seeking) return

      const mapped = clock.mapSourceToTimeline(sourceMs, {
        preferClipId: clipIdRef.current ?? undefined,
      })

      if (mapped) {
        const rounded = clock.roundToFrame(mapped.timelineMs)
        clock.reportDrift(drivenPlayheadRef.current, rounded)
        // Drive the playhead smoothly from the video frame clock whenever a new frame arrives
        if (rounded !== drivenPlayheadRef.current) {
          onSeekRef.current(rounded)
          drivenPlayheadRef.current = rounded
        }
        clipIdRef.current = mapped.clipId

        // Check if we reached or are immediately approaching the boundary of the current clip
        const currentPos = clock.mapTimelineToSource(
          drivenPlayheadRef.current,
          playbackRateRef.current,
        )
        if (currentPos) {
          const clipEndMs = currentPos.clip.startMs + currentPos.clip.durationMs
          const isNearClipEnd =
            sourceMs >= currentPos.clip.sourceOutMs - clock.frameMs * 1.0 ||
            drivenPlayheadRef.current >= clipEndMs - clock.frameMs * 1.0

          if (isNearClipEnd) {
            const boundary = clock.nextBoundary(drivenPlayheadRef.current)
            if (!boundary || boundary.kind === "end") {
              onPauseRef.current?.()
              onSeekRef.current(clipEndMs)
              drivenPlayheadRef.current = clipEndMs
              return
            }

            const nextClip = findNextTimelineClip(timeline, "screen", boundary.timelineMs)
            if (nextClip && nextClip.startMs === boundary.timelineMs) {
              const nextSourceSeconds = nextClip.sourceInMs / 1000
              if (
                video &&
                Math.abs(video.currentTime - nextSourceSeconds) > (clock.frameMs * 0.5) / 1000
              ) {
                if (!isSeekingRef.current && !video.seeking) {
                  isSeekingRef.current = true
                  setIsSeeking(true)
                  video.currentTime = nextSourceSeconds
                }
              }
              clipIdRef.current = nextClip.id
              drivenPlayheadRef.current = nextClip.startMs
              onSeekRef.current(nextClip.startMs)
              return
            }
            onPlayNextRef.current?.(boundary)
            return
          }
        }
      } else {
        // If mapped is null, check where we are relative to current clip
        const currentPos = clock.mapTimelineToSource(
          drivenPlayheadRef.current,
          playbackRateRef.current,
        )

        // If sourceMs is before the current clip, the video is starting or seeking into clip start;
        // do not treat as end of clip
        if (currentPos && sourceMs < currentPos.clip.sourceInMs) {
          drivenPlayheadRef.current = currentPos.clip.startMs
          onSeekRef.current(currentPos.clip.startMs)
          clipIdRef.current = currentPos.clip.id
          return
        }

        // The video element has played into cut-out / deleted footage.
        // The preceding clip is completed; do NOT seek backwards into the old clip.
        const clipEndMs = currentPos
          ? currentPos.clip.startMs + currentPos.clip.durationMs
          : drivenPlayheadRef.current
        const boundary = clock.nextBoundary(drivenPlayheadRef.current)

        if (!boundary || boundary.kind === "end") {
          onPauseRef.current?.()
          onSeekRef.current(clipEndMs)
          drivenPlayheadRef.current = clipEndMs
          return
        }

        const nextClip = findNextTimelineClip(timeline, "screen", boundary.timelineMs)
        if (nextClip && nextClip.startMs === boundary.timelineMs) {
          const nextSourceSeconds = nextClip.sourceInMs / 1000
          if (
            video &&
            Math.abs(video.currentTime - nextSourceSeconds) > (clock.frameMs * 0.5) / 1000
          ) {
            if (!isSeekingRef.current && !video.seeking) {
              isSeekingRef.current = true
              setIsSeeking(true)
              video.currentTime = nextSourceSeconds
            }
          }
          clipIdRef.current = nextClip.id
          drivenPlayheadRef.current = nextClip.startMs
          onSeekRef.current(nextClip.startMs)
          return
        }

        // Downstream clip with a gap in between: advance playhead to boundary
        clipIdRef.current = null
        drivenPlayheadRef.current = boundary.timelineMs
        onSeekRef.current(boundary.timelineMs)
        onPlayNextRef.current?.(boundary)
        return
      }
    },
    [clock, timeline, videoRef],
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

  return { isReady, isSeeking, videoProps }
}
