import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { TimelineState } from "@recordforge/contracts"
import {
  buildPreviewSegments,
  classifyPreviewFrame,
  createPlaybackClock,
  nextPreviewSegment,
  previewSegmentAt,
  previewSegmentSourceMs,
  type PlaybackClock,
  type PreviewQualityMode,
  type PreviewSegment,
} from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"
import { getPlayheadSnapshot, subscribeToPlayhead } from "./use-playback-state"
import { planCutTransition, planSegmentFrameTick } from "./playback/cut-transition"

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
 *
 * Frame mapping is segment-relative: a presented frame is only ever applied to
 * the segment the playhead is already inside. Frames from the retiring slot, or
 * from the deleted range a segment jumps over, can therefore never move the
 * playhead backwards — they either cross the cut or trigger a corrective seek.
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
  /** A cut holding its last frame until the standby can take over. */
  const pendingCutRef = useRef<{ index: number; sinceMs: number } | null>(null)

  // The playhead is read imperatively (subscription below) instead of via
  // usePlayheadMs: this hook's owner renders the whole timeline view, so a
  // render-bound playhead subscription would re-render it every video frame.
  const playheadRef = useRef(getPlayheadSnapshot())
  const drivenPlayheadRef = useRef(getPlayheadSnapshot())
  const isPlayingRef = useRef(isPlaying)
  const playbackRateRef = useRef(playbackRate)
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

  const setSeeking = useCallback((value: boolean) => {
    if (isSeekingRef.current === value) return
    isSeekingRef.current = value
    setIsSeeking(value)
  }, [])

  const segmentReady = useCallback(
    (element: HTMLVideoElement | null, segment: PreviewSegment): boolean => {
      if (!element || element.seeking || element.readyState < 2) return false
      return Math.abs(element.currentTime * 1000 - segment.sourceInMs) <= frameMs
    },
    [frameMs],
  )

  const effectiveRate = useCallback((segment: PreviewSegment): number => {
    return Math.max(0.25, Math.min(4, playbackRateRef.current * segment.speed))
  }, [])

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
      standby.playbackRate = effectiveRate(segment)
      activeSlotRef.current = standbySlot
      setActiveSlot(standbySlot)
      slotSegmentsRef.current[standbySlot] = index
      setSeeking(false)
      if (isPlayingRef.current) {
        standby.play().catch(() => {
          onPauseRef.current?.()
        })
      }
      return true
    },
    [activeElement, effectiveRate, segmentReady, setSeeking, standbyElement],
  )

  const handleSeeking = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      if (event.currentTarget !== activeElement()) return
      setSeeking(true)
    },
    [activeElement, setSeeking],
  )

  const handleSeeked = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      if (event.currentTarget !== activeElement()) return
      setSeeking(false)
      const video = event.currentTarget
      if (isPlayingRef.current && video.paused) {
        video.play().catch(() => {
          onPauseRef.current?.()
        })
      }
    },
    [activeElement, setSeeking],
  )

  const handleTransient = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      if (event.currentTarget !== activeElement()) return
      const video = event.currentTarget
      if (!video.seeking) setSeeking(false)
    },
    [activeElement, setSeeking],
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

    if (!video.seeking && isSeekingRef.current && !pendingCutRef.current) {
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

  /** Move the preview playhead, keeping the driven ref in step. */
  const driveTo = useCallback((timelineMs: number) => {
    if (timelineMs === drivenPlayheadRef.current) return
    drivenPlayheadRef.current = timelineMs
    onSeekRef.current(timelineMs)
  }, [])

  /**
   * Hold the active slot on its last segment frame while a cut waits for the
   * standby. Releasing audio here keeps the preview from drifting during the
   * hold (see `isVideoSeeking` in the audio preview).
   */
  const holdActiveSlot = useCallback(() => {
    const video = activeElement()
    if (video && !video.paused) video.pause()
    setSeeking(true)
  }, [activeElement, setSeeking])

  /**
   * Put the active slot on a segment without changing element ownership. This
   * is both the cut fallback (standby not ready) and the resync path (a frame
   * from outside the active segment). Returns false when the element is busy;
   * the caller must retry instead of claiming the slot holds the segment.
   */
  const seekActiveToSegment = useCallback(
    (segment: PreviewSegment, index: number, sourceMs: number, playheadMs: number): boolean => {
      const video = activeElement()
      if (!video) return false
      const seconds = Math.max(0, sourceMs) / 1000
      const onTarget = Math.abs(video.currentTime - seconds) * 1000 <= frameMs
      if (!onTarget) {
        if (video.seeking) return false
        setSeeking(true)
        video.currentTime = seconds
      }
      slotSegmentsRef.current[activeSlotRef.current] = index
      video.playbackRate = effectiveRate(segment)
      if (isPlayingRef.current && video.paused) {
        video.play().catch(() => {
          onPauseRef.current?.()
        })
      }
      driveTo(playheadMs)
      return true
    },
    [activeElement, driveTo, effectiveRate, frameMs, setSeeking],
  )

  /**
   * Cross the cut at the end of `segment` (index `index`). Returns true when
   * the transition is resolved; false while the preview holds the cut frame.
   */
  const crossCut = useCallback(
    (index: number, segment: PreviewSegment): boolean => {
      const nextIndex = index + 1 < segments.length ? index + 1 : -1
      const nextSegment = nextIndex >= 0 ? segments[nextIndex]! : null
      const standbySlot = (activeSlotRef.current === 0 ? 1 : 0) as ScreenSlot
      const standby = standbyElement()
      const active = activeElement()
      const pending = pendingCutRef.current
      const heldMs =
        pending && pending.index === nextIndex ? performance.now() - pending.sinceMs : null

      const plan = planCutTransition({
        hasNext: nextSegment !== null,
        contiguous: nextSegment !== null && nextSegment.startMs <= segment.endMs + 1,
        standbyHoldsNext: nextIndex >= 0 && slotSegmentsRef.current[standbySlot] === nextIndex,
        standbyReady: nextSegment !== null && segmentReady(standby, nextSegment),
        activeSeekable: active !== null && !active.seeking,
        heldMs,
      })

      switch (plan.kind) {
        case "end": {
          pendingCutRef.current = null
          active?.pause()
          slotSegmentsRef.current[activeSlotRef.current] = index
          driveTo(segment.endMs)
          preRollStandby(segment.endMs)
          onPauseRef.current?.()
          return true
        }
        case "gap": {
          // The next segment starts after a gap: jump the playhead over it and
          // let the next sync place the media.
          pendingCutRef.current = null
          driveTo(nextSegment!.startMs)
          return true
        }
        case "swap": {
          if (!swapToStandby(nextSegment!, nextIndex)) return false
          pendingCutRef.current = null
          driveTo(nextSegment!.startMs)
          preRollStandby(nextSegment!.startMs)
          return true
        }
        case "seek": {
          pendingCutRef.current = null
          return seekActiveToSegment(
            nextSegment!,
            nextIndex,
            nextSegment!.sourceInMs,
            nextSegment!.startMs,
          )
        }
        default: {
          // Hold the boundary frame and retry: the standby is still seeking, or
          // the active element is busy and must not be given a second seek.
          pendingCutRef.current =
            pending && pending.index === nextIndex
              ? pending
              : { index: nextIndex, sinceMs: performance.now() }
          if (plan.pauseActive) holdActiveSlot()
          preRollStandby(drivenPlayheadRef.current)
          return false
        }
      }
    },
    [
      activeElement,
      driveTo,
      holdActiveSlot,
      preRollStandby,
      segmentReady,
      seekActiveToSegment,
      segments,
      standbyElement,
      swapToStandby,
    ],
  )

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
      if (isSeekingRef.current && !pendingCutRef.current) {
        isSeekingRef.current = false
        setIsSeeking(false)
      }
      preRollStandby(playheadRef.current)
      return
    }

    if (pendingCutRef.current) {
      // A cut is waiting for its standby. Keep holding the boundary frame and
      // keep the standby primed instead of seeking the playing element.
      if (!video.paused) video.pause()
      preRollStandby(playheadRef.current)
      return
    }

    const segment = segments[index]!
    const slot = activeSlotRef.current
    if (slotSegmentsRef.current[slot] !== index) {
      if (!swapToStandby(segment, index)) {
        const resynced = seekActiveToSegment(
          segment,
          index,
          previewSegmentSourceMs(segment, playheadRef.current),
          playheadRef.current,
        )
        if (!resynced) return
      }
      // A swap changes which element is active: every write below must target
      // the slot that is now on screen.
      video = activeElement() ?? video
    }

    video.style.visibility = "visible"
    video.playbackRate = effectiveRate(segment)

    const sourceMs = previewSegmentSourceMs(segment, playheadRef.current)
    const sourceSeconds = sourceMs / 1000
    const playheadJumpMs = Math.abs(playheadRef.current - drivenPlayheadRef.current)

    const shouldSeekVideo =
      !isPlayingRef.current ||
      playheadJumpMs > clock.frameMs * 2 ||
      Math.abs(video.currentTime - sourceSeconds) > 0.25

    if (shouldSeekVideo) {
      const driftSeconds = Math.abs(video.currentTime - sourceSeconds)
      if (driftSeconds > (clock.frameMs * 0.5) / 1000) {
        if (!isSeekingRef.current && !video.seeking) {
          setSeeking(true)
          video.currentTime = sourceSeconds
        }
      }
    } else if (!video.seeking && isSeekingRef.current) {
      isSeekingRef.current = false
      setIsSeeking(false)
    }

    setIsReady(true)
    preRollStandby(playheadRef.current)
  }, [
    activeElement,
    clock,
    effectiveRate,
    preRollStandby,
    segments,
    seekActiveToSegment,
    setSeeking,
    swapToStandby,
  ])

  // Reset the slots when the media source or segment list changes
  // (proxy/original switch, timeline edit).
  useEffect(() => {
    slotSegmentsRef.current = [-1, -1]
    pendingCutRef.current = null
    activeSlotRef.current = 0
    setActiveSlot(0)
  }, [mediaUrl, segments])

  // Sync the media element when playback toggles or the source changes.
  useEffect(() => {
    if (!isPlaying) pendingCutRef.current = null
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
        // A user seek (or an edit) supersedes any cut that is still waiting.
        drivenPlayheadRef.current = ms
        pendingCutRef.current = null
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
      if (!clock || !timeline || segments.length === 0) return
      const video = activeElement()
      if (!video) return

      // A pending cut owns the transition; the retry loop resumes the preview.
      if (pendingCutRef.current) return
      if (video.seeking) return
      if (isSeekingRef.current) {
        isSeekingRef.current = false
        setIsSeeking(false)
      }

      const index = previewSegmentAt(segments, drivenPlayheadRef.current)
      if (index < 0) return // the playhead is in a gap: the gap clock owns it

      const segment = segments[index]!
      const toleranceMs = clock.frameMs
      const tick = planSegmentFrameTick({
        segment,
        playheadMs: drivenPlayheadRef.current,
        sourceMs,
        toleranceMs,
      })

      if (tick.kind === "past-end") {
        crossCut(index, segment)
        return
      }

      if (tick.kind === "before-start") {
        // The element is showing media from before this segment (a frame from
        // the retiring slot, or a seek that has not landed yet).
        const previous = index > 0 ? segments[index - 1]! : null
        const justEntered = drivenPlayheadRef.current - segment.startMs <= toleranceMs * 2
        const frameIsFromPrevious =
          previous !== null &&
          classifyPreviewFrame(previous, sourceMs, toleranceMs) !== "before-start"
        if (previous && justEntered && frameIsFromPrevious) {
          // The frame belongs to the segment we just left: cross that cut
          // rather than rewinding the playhead.
          crossCut(index - 1, previous)
          return
        }
        seekActiveToSegment(
          segment,
          index,
          previewSegmentSourceMs(segment, drivenPlayheadRef.current),
          drivenPlayheadRef.current,
        )
        return
      }

      // Frame rounding must never push the playhead outside the segment it was
      // mapped from: a millisecond below the start would read as the previous
      // segment (and re-trigger its cut).
      const rounded = Math.max(
        segment.startMs,
        Math.min(segment.endMs, clock.roundToFrame(tick.timelineMs)),
      )
      clock.reportDrift(drivenPlayheadRef.current, rounded)
      if (rounded > drivenPlayheadRef.current) {
        driveTo(rounded)
      }
      setIsReady(true)
      preRollStandby(drivenPlayheadRef.current)
    },
    [
      activeElement,
      clock,
      crossCut,
      driveTo,
      preRollStandby,
      seekActiveToSegment,
      segments,
      timeline,
    ],
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

  // Animation-frame clock for gaps, and the retry loop for a cut that is
  // holding its last frame until the standby can take over.
  useEffect(() => {
    if (!isPlaying || !clock) return

    let lastTime = performance.now()
    const step = (now: number) => {
      if (!isPlayingRef.current || !clock) return
      const elapsed = now - lastTime
      lastTime = now
      const pending = pendingCutRef.current
      if (pending) {
        const previousIndex = pending.index - 1
        const previous = previousIndex >= 0 ? segments[previousIndex] : null
        if (!previous) {
          pendingCutRef.current = null
        } else {
          crossCut(previousIndex, previous)
        }
      } else {
        const position = clock.mapTimelineToSource(
          drivenPlayheadRef.current,
          playbackRateRef.current,
        )
        if (!position) {
          const next = clock.advanceFrame(
            drivenPlayheadRef.current,
            elapsed,
            playbackRateRef.current,
          )
          if (next !== drivenPlayheadRef.current) {
            driveTo(next)
          }
        } else {
          // Watchdog: the frame clock only advances while the active element is
          // presenting frames. If playback was meant to run and the element is
          // sitting idle (a rejected play(), an occluded window), restart it
          // instead of leaving the playhead parked mid-segment.
          const video = activeElement()
          if (video && video.paused && !video.seeking && !isSeekingRef.current) {
            video.play().catch(() => {
              onPauseRef.current?.()
            })
          }
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
  }, [activeElement, clock, crossCut, driveTo, isPlaying, segments])

  return { isReady, isSeeking, activeSlot, screenSlots, videoProps }
}
