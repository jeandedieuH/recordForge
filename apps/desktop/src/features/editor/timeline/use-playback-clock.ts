import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { TimelineState } from "@recordforge/contracts"
import {
  buildPreviewSegments,
  createPlaybackClock,
  nextPreviewSegment,
  previewSegmentAt,
  type PlaybackClock,
  type PreviewQualityMode,
  type PreviewSegment,
} from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"
import { getPlayheadSnapshot, subscribeToPlayhead } from "./use-playback-state"

type ScreenSlot = 0 | 1
type SlotRefs = [React.RefObject<HTMLVideoElement | null>, React.RefObject<HTMLVideoElement | null>]

interface UsePlaybackClockOptions {
  timeline: TimelineState | null
  previewQuality: PreviewQualityMode
  mediaUrl?: string | null
  onSeek: (ms: number) => void
  onPause?: () => void
}

/**
 * Drive the preview playhead from the active screen video's frame clock.
 *
 * The screen surface is a pair of media elements: the active one plays, the
 * standby is pre-seeked to the next preview segment. At a cut the pair swaps,
 * so Smart Cut's dense splices no longer cause a seek (and an audio dropout)
 * every couple of seconds. The hook stays imperative so the timeline view does
 * not re-render every video frame.
 */
export interface UsePlaybackClockResult {
  isReady: boolean
  isSeeking: boolean
  activeSlot: ScreenSlot
  screenSlots: SlotRefs
  videoProps: {
    onSeeking: (event: React.SyntheticEvent<HTMLVideoElement>) => void
    onSeeked: (event: React.SyntheticEvent<HTMLVideoElement>) => void
    onPlaying: (event: React.SyntheticEvent<HTMLVideoElement>) => void
    onCanPlay: (event: React.SyntheticEvent<HTMLVideoElement>) => void
    onTimeUpdate: (event: React.SyntheticEvent<HTMLVideoElement>) => void
  }
}

export function usePlaybackClock({
  timeline,
  previewQuality,
  mediaUrl,
  onSeek,
  onPause,
}: UsePlaybackClockOptions): UsePlaybackClockResult {
  const isPlaying = useTimelineStore((state) => state.view.isPlaying)
  const playbackRate = useTimelineStore((state) => state.view.playbackRate)
  const clock = useMemo<PlaybackClock | null>(() => {
    if (!timeline) return null
    return createPlaybackClock(timeline, { mode: previewQuality, fps: timeline.canvas.fps })
  }, [timeline, previewQuality])

  const segments = useMemo<PreviewSegment[]>(() => {
    const track = timeline?.tracks.find((candidate) => candidate.kind === "screen")
    if (!track) return []
    return buildPreviewSegments(track.clips, () => mediaUrl ?? "")
  }, [timeline, mediaUrl])

  const [isReady, setIsReady] = useState(false)
  const [isSeeking, setIsSeeking] = useState(false)
  const [activeSlot, setActiveSlot] = useState<ScreenSlot>(0)
  const isSeekingRef = useRef(false)

  const slot0Ref = useRef<HTMLVideoElement | null>(null)
  const slot1Ref = useRef<HTMLVideoElement | null>(null)
  const screenSlots = useMemo<SlotRefs>(() => [slot0Ref, slot1Ref], [])
  const activeSlotRef = useRef<ScreenSlot>(0)
  const slotSegmentsRef = useRef<[number, number]>([-1, -1])

  // The playhead is read imperatively (subscription below) instead of via
  // usePlayheadMs: this hook's owner renders the whole timeline view, so a
  // render-bound playhead subscription would re-render it every video frame.
  const playheadRef = useRef(getPlayheadSnapshot())
  const drivenPlayheadRef = useRef(getPlayheadSnapshot())
  const isPlayingRef = useRef(isPlaying)
  const playbackRateRef = useRef(playbackRate)
  const clipIdRef = useRef<string | null>(null)
  const onSeekRef = useRef(onSeek)
  const onPauseRef = useRef(onPause)
  const vfcRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const gapRafRef = useRef<number | null>(null)

  // Keep refs synchronized immediately during render so callbacks never observe stale values
  isPlayingRef.current = isPlaying
  playbackRateRef.current = playbackRate
  onSeekRef.current = onSeek
  onPauseRef.current = onPause

  const activeElement = useCallback(() => screenSlots[activeSlotRef.current].current, [screenSlots])
  const standbyElement = useCallback(
    () => screenSlots[activeSlotRef.current === 0 ? 1 : 0].current,
    [screenSlots],
  )
  const frameMs = clock?.frameMs ?? 1000 / 30

  const segmentReady = useCallback(
    (element: HTMLVideoElement | null, segment: PreviewSegment): boolean => {
      if (!element || element.readyState < 2) return false
      return Math.abs(element.currentTime * 1000 - segment.sourceInMs) <= frameMs
    },
    [frameMs],
  )

  const seekElement = useCallback((element: HTMLVideoElement | null, sourceMs: number) => {
    if (!element) return
    const seconds = Math.max(0, sourceMs) / 1000
    if (Math.abs(element.currentTime - seconds) <= 0.0005) return
    // Never queue a second seek on an element that is already seeking: Chromium
    // aborts the in-flight request and can loop.
    if (element.seeking) return
    element.currentTime = seconds
  }, [])

  /** Pre-roll the standby slot to the segment after `playheadMs`. */
  const preRollStandby = useCallback(
    (playheadMs: number) => {
      const element = standbyElement()
      if (!element) return
      const standbySlot = (activeSlotRef.current === 0 ? 1 : 0) as ScreenSlot
      const index = nextPreviewSegment(segments, playheadMs)
      if (index < 0) {
        element.pause()
        slotSegmentsRef.current[standbySlot] = -1
        return
      }
      const segment = segments[index]!
      if (slotSegmentsRef.current[standbySlot] !== index) {
        element.pause()
        slotSegmentsRef.current[standbySlot] = index
        seekElement(element, segment.sourceInMs)
      } else if (Math.abs(element.currentTime * 1000 - segment.sourceInMs) > frameMs) {
        seekElement(element, segment.sourceInMs)
      }
    },
    [frameMs, seekElement, segments, standbyElement],
  )

  /** Swap to the pre-rolled standby when it holds `segment`; returns success. */
  const swapToStandby = useCallback(
    (segment: PreviewSegment, index: number): boolean => {
      const standby = standbyElement()
      const current = activeElement()
      const standbySlot = (activeSlotRef.current === 0 ? 1 : 0) as ScreenSlot
      if (
        !standby ||
        slotSegmentsRef.current[standbySlot] !== index ||
        !segmentReady(standby, segment)
      ) {
        return false
      }
      const wasMuted = current?.muted ?? true
      current?.pause()
      if (current) {
        current.style.visibility = "hidden"
        current.muted = true
      }
      // Carry the preview mute state across the swap without waiting for the
      // next render, while the retiring slot stays silenced.
      standby.muted = wasMuted
      standby.style.visibility = "visible"
      activeSlotRef.current = standbySlot
      setActiveSlot(standbySlot)
      slotSegmentsRef.current[standbySlot] = index
      if (isPlayingRef.current) {
        standby.play().catch(() => {
          onPauseRef.current?.()
        })
      }
      return true
    },
    [activeElement, segmentReady, standbyElement],
  )

  const handleSeeking = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      if (event.currentTarget !== activeElement()) return
      isSeekingRef.current = true
      setIsSeeking(true)
    },
    [activeElement],
  )

  const handleSeeked = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      if (event.currentTarget !== activeElement()) return
      isSeekingRef.current = false
      setIsSeeking(false)
      const video = event.currentTarget
      if (isPlayingRef.current && video.paused) {
        video.play().catch(() => {
          onPauseRef.current?.()
        })
      }
    },
    [activeElement],
  )

  const handleTransient = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      if (event.currentTarget !== activeElement()) return
      const video = event.currentTarget
      if (!video.seeking) {
        isSeekingRef.current = false
        setIsSeeking(false)
      }
    },
    [activeElement],
  )

  const videoProps = useMemo(
    () => ({
      onSeeking: handleSeeking,
      onSeeked: handleSeeked,
      onPlaying: handleTransient,
      onCanPlay: handleTransient,
      onTimeUpdate: handleTransient,
    }),
    [handleSeeking, handleSeeked, handleTransient],
  )

  // Re-attach listeners whenever the active element can change.
  useEffect(() => {
    const video = activeElement()
    if (!video) return

    video.addEventListener("seeking", handleSeeking as unknown as EventListener)
    video.addEventListener("seeked", handleSeeked as unknown as EventListener)
    video.addEventListener("playing", handleTransient as unknown as EventListener)
    video.addEventListener("canplay", handleTransient as unknown as EventListener)
    video.addEventListener("timeupdate", handleTransient as unknown as EventListener)

    if (!video.seeking && isSeekingRef.current) {
      isSeekingRef.current = false
      setIsSeeking(false)
    }

    return () => {
      video.removeEventListener("seeking", handleSeeking as unknown as EventListener)
      video.removeEventListener("seeked", handleSeeked as unknown as EventListener)
      video.removeEventListener("playing", handleTransient as unknown as EventListener)
      video.removeEventListener("canplay", handleTransient as unknown as EventListener)
      video.removeEventListener("timeupdate", handleTransient as unknown as EventListener)
    }
  }, [activeElement, activeSlot, handleSeeking, handleSeeked, handleTransient, mediaUrl])

  const syncVideo = useCallback(() => {
    let video = activeElement()
    if (!video || !clock) {
      setIsReady(false)
      return
    }
    const index = previewSegmentAt(segments, playheadRef.current)
    if (index < 0) {
      video.pause()
      video.style.visibility = "hidden"
      clipIdRef.current = null
      if (isSeekingRef.current) {
        isSeekingRef.current = false
        setIsSeeking(false)
      }
      preRollStandby(playheadRef.current)
      return
    }

    const segment = segments[index]!
    const slot = activeSlotRef.current
    if (slotSegmentsRef.current[slot] !== index) {
      if (!swapToStandby(segment, index)) {
        slotSegmentsRef.current[slot] = index
        const sourceMs = Math.max(
          segment.sourceInMs,
          Math.min(
            segment.sourceOutMs,
            segment.sourceInMs + (playheadRef.current - segment.startMs) * segment.speed,
          ),
        )
        seekElement(video, sourceMs)
      }
      // A swap changes which element is active: every write below must target
      // the slot that is now on screen.
      video = activeElement() ?? video
    }

    video.style.visibility = "visible"
    const playbackRateNow = Math.max(0.25, Math.min(4, playbackRateRef.current * segment.speed))
    video.playbackRate = playbackRateNow
    clipIdRef.current = segment.clipIds[0] ?? null

    const sourceMs = Math.max(
      segment.sourceInMs,
      Math.min(
        segment.sourceOutMs,
        segment.sourceInMs + (playheadRef.current - segment.startMs) * segment.speed,
      ),
    )
    const sourceSeconds = sourceMs / 1000
    const previousDrivenMs = drivenPlayheadRef.current
    const playheadJumpMs = Math.abs(playheadRef.current - previousDrivenMs)

    const shouldSeekVideo =
      !isPlayingRef.current ||
      playheadJumpMs > clock.frameMs * 2 ||
      Math.abs(video.currentTime - sourceSeconds) > 0.25

    if (shouldSeekVideo) {
      const driftSeconds = Math.abs(video.currentTime - sourceSeconds)
      if (driftSeconds > (clock.frameMs * 0.5) / 1000) {
        if (!isSeekingRef.current && !video.seeking) {
          isSeekingRef.current = true
          setIsSeeking(true)
          video.currentTime = sourceSeconds
        }
      }
    } else if (!video.seeking && isSeekingRef.current) {
      isSeekingRef.current = false
      setIsSeeking(false)
    }

    drivenPlayheadRef.current = playheadRef.current
    setIsReady(true)
    preRollStandby(playheadRef.current)
  }, [activeElement, clock, preRollStandby, segments, seekElement, swapToStandby])

  // Reset the slots when the media source or segment list changes
  // (proxy/original switch, timeline edit).
  useEffect(() => {
    slotSegmentsRef.current = [-1, -1]
    activeSlotRef.current = 0
    setActiveSlot(0)
  }, [mediaUrl, segments])

  // Sync the media element when playback toggles or the source changes.
  useEffect(() => {
    syncVideo()
    const video = activeElement()
    if (!video) return

    if (isPlaying) {
      if (video.paused) {
        video.play().catch(() => {
          onPauseRef.current?.()
        })
      }
    } else if (!video.paused) {
      video.pause()
    }
  }, [activeElement, isPlaying, playbackRate, previewQuality, mediaUrl, syncVideo])

  // Playhead changes arrive through an imperative subscription so the editor
  // does not re-render every video frame.
  useEffect(() => {
    return subscribeToPlayhead(() => {
      const ms = getPlayheadSnapshot()
      playheadRef.current = ms
      if (Math.abs(drivenPlayheadRef.current - ms) > (clock?.frameMs ?? 33) * 2) {
        drivenPlayheadRef.current = ms
      }
      syncVideo()
      const video = activeElement()
      if (video && isPlayingRef.current && video.paused && !isSeekingRef.current) {
        video.play().catch(() => {
          onPauseRef.current?.()
        })
      }
    })
  }, [activeElement, clock, syncVideo])

  const handleFrame = useCallback(
    (sourceMs: number) => {
      if (!clock || !timeline) return
      const video = activeElement()
      if (video && !video.seeking) {
        if (isSeekingRef.current) {
          isSeekingRef.current = false
          setIsSeeking(false)
        }
      }
      if (video?.seeking) return

      const mapped = clock.mapSourceToTimeline(sourceMs, {
        preferClipId: clipIdRef.current ?? undefined,
      })

      if (mapped) {
        const rounded = clock.roundToFrame(mapped.timelineMs)
        clock.reportDrift(drivenPlayheadRef.current, rounded)
        if (rounded !== drivenPlayheadRef.current) {
          onSeekRef.current(rounded)
          drivenPlayheadRef.current = rounded
        }
        clipIdRef.current = mapped.clipId

        const index = previewSegmentAt(segments, drivenPlayheadRef.current)
        const segment = index >= 0 ? segments[index]! : null
        if (segment) {
          const isNearSegmentEnd =
            sourceMs >= segment.sourceOutMs - clock.frameMs ||
            drivenPlayheadRef.current >= segment.endMs - clock.frameMs
          if (isNearSegmentEnd) {
            const nextIndex = nextPreviewSegment(segments, drivenPlayheadRef.current)
            const nextSegment = nextIndex >= 0 ? segments[nextIndex]! : null
            if (!nextSegment) {
              onPauseRef.current?.()
              onSeekRef.current(segment.endMs)
              drivenPlayheadRef.current = segment.endMs
              return
            }
            if (nextSegment.startMs <= segment.endMs + 1) {
              if (swapToStandby(nextSegment, nextIndex)) {
                drivenPlayheadRef.current = nextSegment.startMs
                // The frame clock now reads the new slot: anchor its clip so
                // the first mapped frame cannot drive the playhead backwards.
                clipIdRef.current = nextSegment.clipIds[0] ?? null
                // The old active slot is now the standby: refill it with the
                // segment after the one we just switched to.
                preRollStandby(nextSegment.startMs)
                onSeekRef.current(nextSegment.startMs)
                return
              }
              // Standby not ready: fall back to today's seek.
              const active = activeElement()
              const nextSourceSeconds = nextSegment.sourceInMs / 1000
              if (
                active &&
                Math.abs(active.currentTime - nextSourceSeconds) > (clock.frameMs * 0.5) / 1000
              ) {
                if (!isSeekingRef.current && !active.seeking) {
                  isSeekingRef.current = true
                  setIsSeeking(true)
                  active.currentTime = nextSourceSeconds
                }
              }
              slotSegmentsRef.current[activeSlotRef.current] = nextIndex
              clipIdRef.current = nextSegment.clipIds[0] ?? null
              drivenPlayheadRef.current = nextSegment.startMs
              onSeekRef.current(nextSegment.startMs)
              return
            }
            // A gap follows: let the gap clock advance to the next segment.
            clipIdRef.current = null
            drivenPlayheadRef.current = nextSegment.startMs
            onSeekRef.current(nextSegment.startMs)
            return
          }
        }
      } else {
        const index = previewSegmentAt(segments, drivenPlayheadRef.current)
        const current = index >= 0 ? segments[index]! : null
        if (current && sourceMs < current.sourceInMs) {
          drivenPlayheadRef.current = current.startMs
          onSeekRef.current(current.startMs)
          clipIdRef.current = current.clipIds[0] ?? null
          return
        }
        const nextIndex = nextPreviewSegment(
          segments,
          current ? current.startMs : drivenPlayheadRef.current,
        )
        const nextSegment = nextIndex >= 0 ? segments[nextIndex]! : null
        if (!nextSegment) {
          const endMs = current?.endMs ?? drivenPlayheadRef.current
          onPauseRef.current?.()
          onSeekRef.current(endMs)
          drivenPlayheadRef.current = endMs
          return
        }
        clipIdRef.current = null
        drivenPlayheadRef.current = nextSegment.startMs
        onSeekRef.current(nextSegment.startMs)
      }
    },
    [activeElement, clock, preRollStandby, segments, swapToStandby, timeline],
  )

  useEffect(() => {
    const video = activeElement()
    if (!video || !clock) return

    function hasFrameCallback(element: HTMLVideoElement | null): boolean {
      if (!element) return false
      return (
        typeof (element as HTMLVideoElement & { requestVideoFrameCallback?: unknown })
          .requestVideoFrameCallback === "function"
      )
    }

    function scheduleNext() {
      const current = activeElement()
      if (!current) return
      if (hasFrameCallback(current)) {
        const callback: VideoFrameRequestCallback = (_now, metadata) => {
          if (!isPlayingRef.current) return
          handleFrame(metadata.mediaTime * 1000)
          if (isPlayingRef.current) {
            const next = activeElement()
            if (next) {
              vfcRef.current = (
                next as HTMLVideoElement & {
                  requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => number
                }
              ).requestVideoFrameCallback(callback)
            }
          }
        }
        vfcRef.current = (
          current as HTMLVideoElement & {
            requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => number
          }
        ).requestVideoFrameCallback(callback)
        return
      }

      // Fallback: poll currentTime on animation frames.
      const step = () => {
        if (!isPlayingRef.current) return
        const next = activeElement()
        if (!next) return
        handleFrame(next.currentTime * 1000)
        rafRef.current = requestAnimationFrame(step)
      }
      rafRef.current = requestAnimationFrame(step)
    }

    if (isPlaying) {
      scheduleNext()
    }

    return () => {
      const current = activeElement()
      if (vfcRef.current && hasFrameCallback(current)) {
        ;(
          current as HTMLVideoElement & { cancelVideoFrameCallback: (handle: number) => void }
        ).cancelVideoFrameCallback(vfcRef.current)
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
      vfcRef.current = null
      rafRef.current = null
    }
  }, [activeElement, activeSlot, clock, handleFrame, isPlaying, mediaUrl])

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

  return { isReady, isSeeking, activeSlot, screenSlots, videoProps }
}
