import { useEffect, useRef, useState } from "react"
import type { TimelineClip } from "@recordforge/contracts"
import {
  computePreviewMediaSync,
  nextPreviewSegment,
  previewSegmentAt,
  type PreviewSegment,
} from "@recordforge/editor-core"

export type MediaSlot = 0 | 1

export interface DualSlotPlanInput {
  segments: PreviewSegment[]
  playheadMs: number
  activeSlot: MediaSlot
  /** Segment index each slot currently holds, -1 when empty. */
  slotSegments: readonly [number, number]
  /** The standby element is loaded at the active segment's source in-point. */
  standbyReady: boolean
}

export interface DualSlotPlan {
  /** Slot playback should continue in after this tick. */
  activeSlot: MediaSlot
  activeIndex: number
  standbyIndex: number
  /** The standby took over the active segment (a seamless cut). */
  swapped: boolean
  /** Slot that must show `activeIndex` (already loaded when `swapped`). */
  targetSlot: MediaSlot
  pauseAll: boolean
}

/**
 * Decide which slot plays the active preview segment. A cut swaps to the
 * pre-rolled standby when it is ready for the new segment; otherwise the
 * active slot keeps ownership and its caller falls back to a seek.
 */
export function planDualSlotTick(input: DualSlotPlanInput): DualSlotPlan {
  const activeIndex = previewSegmentAt(input.segments, input.playheadMs)
  const standbyIndex = nextPreviewSegment(input.segments, input.playheadMs)
  if (activeIndex < 0) {
    return {
      activeSlot: input.activeSlot,
      activeIndex: -1,
      standbyIndex,
      swapped: false,
      targetSlot: input.activeSlot,
      pauseAll: true,
    }
  }
  if (input.slotSegments[input.activeSlot] === activeIndex) {
    return {
      activeSlot: input.activeSlot,
      activeIndex,
      standbyIndex,
      swapped: false,
      targetSlot: input.activeSlot,
      pauseAll: false,
    }
  }
  const standbySlot = (1 - input.activeSlot) as MediaSlot
  const standbyTakesOver = input.standbyReady && input.slotSegments[standbySlot] === activeIndex
  return {
    activeSlot: standbyTakesOver ? standbySlot : input.activeSlot,
    activeIndex,
    standbyIndex,
    swapped: standbyTakesOver,
    targetSlot: standbyTakesOver ? standbySlot : input.activeSlot,
    pauseAll: false,
  }
}

/** Source milliseconds a segment maps the playhead to. */
export function previewSegmentSourceMs(segment: PreviewSegment, playheadMs: number): number {
  const sourceMs = segment.sourceInMs + (playheadMs - segment.startMs) * segment.speed
  return Math.max(segment.sourceInMs, Math.min(segment.sourceOutMs, sourceMs))
}

function segmentSignature(segment: PreviewSegment): string {
  return `${segment.startMs}:${segment.endMs}:${segment.sourceInMs}:${segment.sourceOutMs}:${segment.speed}`
}

function previewClipLike(segment: PreviewSegment): TimelineClip {
  // `computePreviewMediaSync` only reads these five fields.
  return {
    startMs: segment.startMs,
    durationMs: segment.endMs - segment.startMs,
    sourceInMs: segment.sourceInMs,
    sourceOutMs: segment.sourceOutMs,
    speed: segment.speed,
  } as unknown as TimelineClip
}

function seekElement(element: HTMLMediaElement, sourceMs: number): void {
  const seconds = Math.max(0, sourceMs) / 1000
  if (Math.abs(element.currentTime - seconds) <= 0.0005) return
  try {
    element.currentTime = seconds
  } catch {
    // Metadata is not loaded yet; the next tick retries.
  }
}

function slotHoldsSegment(
  element: HTMLMediaElement | null,
  segment: PreviewSegment | undefined,
  frameMs: number,
): boolean {
  if (!element || !segment) return false
  if (element.readyState < 2) return false
  return Math.abs(element.currentTime * 1000 - segment.sourceInMs) <= frameMs
}

export interface DualMediaSlotOptions {
  segments: PreviewSegment[]
  playheadMs: number
  isPlaying: boolean
  playbackRate: number
  frameMs: number
  kind: "camera" | "audio"
  enabled: boolean
  slots: readonly [
    React.RefObject<HTMLMediaElement | null>,
    React.RefObject<HTMLMediaElement | null>,
  ]
  /** Resolve a segment's `sourceKey` to a playable URL. */
  sourceUrlOf: (sourceKey: string) => string | null
  /** Apply caller-specific state (volume envelope, mute) after each sync. */
  onSync?: (
    slot: MediaSlot,
    segment: PreviewSegment | null,
    element: HTMLMediaElement,
    isActive: boolean,
  ) => void
}

export interface DualMediaSlotResult {
  activeSlot: MediaSlot
}

/**
 * Keep a pair of media elements playing one track seamlessly.
 *
 * The standby element is pre-seeked to the next segment while the active one
 * plays. At a cut the two swap, so no seek (and no stall) happens on the
 * visible element. When the standby is not ready the cut falls back to a seek.
 */
export function useDualMediaSlots({
  segments,
  playheadMs,
  isPlaying,
  playbackRate,
  frameMs,
  kind,
  enabled,
  slots,
  sourceUrlOf,
  onSync,
}: DualMediaSlotOptions): DualMediaSlotResult {
  const [activeSlot, setActiveSlot] = useState<MediaSlot>(0)
  const activeSlotRef = useRef<MediaSlot>(0)
  const slotSegmentsRef = useRef<[number, number]>([-1, -1])
  const slotSignatureRef = useRef<[string, string]>(["", ""])
  const slotSourceRef = useRef<[string | null, string | null]>([null, null])
  const onSyncRef = useRef(onSync)
  onSyncRef.current = onSync

  // A rebuilt segment list (edit, source change) invalidates what each slot
  // holds; the next tick reloads from scratch.
  useEffect(() => {
    slotSegmentsRef.current = [-1, -1]
    slotSignatureRef.current = ["", ""]
  }, [segments])

  useEffect(() => {
    const first = slots[0].current
    const second = slots[1].current
    if (!first || !second) return
    const elements: [HTMLMediaElement, HTMLMediaElement] = [first, second]
    if (!enabled || segments.length === 0) {
      first.pause()
      second.pause()
      return
    }

    const activeSlotNow = activeSlotRef.current
    const standbySlotNow = (1 - activeSlotNow) as MediaSlot
    const activeIndex = previewSegmentAt(segments, playheadMs)
    const standbyReady =
      activeIndex >= 0 && slotHoldsSegment(elements[standbySlotNow], segments[activeIndex], frameMs)
    const plan = planDualSlotTick({
      segments,
      playheadMs,
      activeSlot: activeSlotNow,
      slotSegments: slotSegmentsRef.current,
      standbyReady,
    })

    const ensureSegment = (slot: MediaSlot, index: number, seekSourceMs?: number): boolean => {
      const segment = segments[index]
      const element = elements[slot]
      if (!segment) return false
      const url = sourceUrlOf(segment.sourceKey)
      if (!url) return false
      const signature = segmentSignature(segment)
      if (slotSourceRef.current[slot] !== url) {
        slotSourceRef.current[slot] = url
        slotSegmentsRef.current[slot] = index
        slotSignatureRef.current[slot] = signature
        element.src = url
        seekElement(element, seekSourceMs ?? segment.sourceInMs)
        return true
      }
      if (slotSegmentsRef.current[slot] !== index || slotSignatureRef.current[slot] !== signature) {
        slotSegmentsRef.current[slot] = index
        slotSignatureRef.current[slot] = signature
        seekElement(element, seekSourceMs ?? segment.sourceInMs)
        return true
      }
      if (seekSourceMs !== undefined) seekElement(element, seekSourceMs)
      return true
    }

    if (plan.pauseAll) {
      first.pause()
      second.pause()
      const preIndex = plan.standbyIndex
      if (preIndex >= 0) {
        ensureSegment(standbySlotNow, preIndex)
      }
      onSyncRef.current?.(activeSlotNow, null, elements[activeSlotNow], false)
      return
    }

    const segment = segments[plan.activeIndex]!
    if (plan.swapped) {
      // The standby was pre-rolled: just start it and retire the old slot.
      elements[activeSlotNow].pause()
      activeSlotRef.current = plan.activeSlot
      setActiveSlot(plan.activeSlot)
      slotSegmentsRef.current[plan.activeSlot] = plan.activeIndex
    } else if (
      slotSegmentsRef.current[plan.targetSlot] !== plan.activeIndex ||
      slotSignatureRef.current[plan.targetSlot] !== segmentSignature(segment)
    ) {
      // The active slot is not loaded for this segment (first play, scrub, or
      // a trim edit): place it once and let drift correction take over.
      const targetMs = previewSegmentSourceMs(segment, playheadMs)
      const loaded = ensureSegment(plan.targetSlot, plan.activeIndex, targetMs)
      if (!loaded) return
    }

    const element = elements[plan.activeSlot]
    const clipLike = previewClipLike(segment)
    const decision = computePreviewMediaSync({
      kind,
      clip: clipLike,
      playheadMs,
      currentTimeMs: element.currentTime * 1000,
      playbackRate,
      isPlaying: isPlaying && enabled,
      frameMs,
    })
    element.preservesPitch = decision.preservesPitch
    if (Math.abs(element.playbackRate - decision.playbackRate) > 0.001) {
      element.playbackRate = decision.playbackRate
    }
    // A fresh swap must not seek: the standby is already at the cut point.
    const shouldSeek = plan.swapped ? false : decision.shouldSeek
    if (shouldSeek) {
      element.currentTime = decision.targetSourceMs / 1000
    }
    if (decision.shouldPlay) {
      if (element.paused) void element.play().catch(() => undefined)
    } else {
      element.pause()
    }
    onSyncRef.current?.(plan.activeSlot, segment, element, true)

    // Pre-roll the next segment into whichever slot is now the standby.
    const standbySlot = (1 - plan.activeSlot) as MediaSlot
    const preIndex = plan.standbyIndex
    const standbyElement = elements[standbySlot]
    if (preIndex >= 0) {
      const next = segments[preIndex]!
      standbyElement.pause()
      const loaded = ensureSegment(standbySlot, preIndex)
      if (loaded) onSyncRef.current?.(standbySlot, next, standbyElement, false)
    } else {
      standbyElement.pause()
      slotSegmentsRef.current[standbySlot] = -1
      onSyncRef.current?.(standbySlot, null, standbyElement, false)
    }
  }, [enabled, frameMs, isPlaying, kind, playbackRate, playheadMs, segments, slots, sourceUrlOf])

  return { activeSlot }
}
