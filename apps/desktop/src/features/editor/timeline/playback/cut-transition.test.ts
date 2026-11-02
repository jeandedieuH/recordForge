import { describe, expect, it } from "vitest"
import type { PreviewSegment } from "@recordforge/editor-core"
import { planCutTransition, planSegmentFrameTick } from "./cut-transition"

function segment(startMs: number, endMs: number, sourceInMs: number, speed = 1): PreviewSegment {
  return {
    startMs,
    endMs,
    sourceInMs,
    sourceOutMs: sourceInMs + (endMs - startMs) * speed,
    speed,
    sourceKey: "screen",
    clipIds: [`clip-${startMs}`],
  }
}

// A Smart Cut splice: the output is contiguous but the source jumps forward
// over the removed range.
const active = segment(0, 2_000, 10_000)
const next = segment(2_000, 4_000, 13_500)

describe("planSegmentFrameTick", () => {
  it("advances the playhead from the media clock inside the segment", () => {
    const tick = planSegmentFrameTick({
      segment: active,
      playheadMs: 500,
      sourceMs: 10_500,
      toleranceMs: 16,
    })
    expect(tick).toEqual({ kind: "advance", timelineMs: 500 })
  })

  it("requests the cut once the media reaches the segment out-point", () => {
    expect(
      planSegmentFrameTick({
        segment: active,
        playheadMs: 1_900,
        sourceMs: 12_000,
        toleranceMs: 16,
      }),
    ).toEqual({ kind: "past-end" })
  })

  it("requests the cut when the playhead already sits on the last frame", () => {
    expect(
      planSegmentFrameTick({
        segment: active,
        playheadMs: 1_990,
        sourceMs: 11_900,
        toleranceMs: 16,
      }),
    ).toEqual({ kind: "past-end" })
  })

  it("never maps a frame from the previous segment backwards", () => {
    // A stale frame from the retiring slot arrives after the playhead already
    // moved to the next segment.
    const tick = planSegmentFrameTick({
      segment: next,
      playheadMs: next.startMs,
      sourceMs: 11_000,
      toleranceMs: 16,
    })
    expect(tick).toEqual({ kind: "before-start" })
  })

  it("treats a frame in the deleted range as the end of the active segment", () => {
    // The element kept playing into the removed range instead of stopping at
    // sourceOut. That must cross the cut, not freeze the playhead.
    const tick = planSegmentFrameTick({
      segment: active,
      playheadMs: 1_800,
      sourceMs: 12_400,
      toleranceMs: 16,
    })
    expect(tick).toEqual({ kind: "past-end" })
  })

  it("maps source to timeline through the segment speed", () => {
    const fast = segment(0, 1_000, 4_000, 2)
    expect(
      planSegmentFrameTick({
        segment: fast,
        playheadMs: 100,
        sourceMs: 4_400,
        toleranceMs: 16,
      }),
    ).toEqual({ kind: "advance", timelineMs: 200 })
  })

  it("clamps an advance to the segment window", () => {
    const tick = planSegmentFrameTick({
      segment: active,
      playheadMs: 100,
      sourceMs: 11_900,
      toleranceMs: 16,
    })
    expect(tick).toEqual({ kind: "advance", timelineMs: 1_900 })
  })

  it("never fires a cut at the start of a sub-two-frame segment", () => {
    // A 15 ms segment with a 10 ms tolerance: the playhead is inside the edge
    // zone, but only the media clock may retire a segment this short.
    const tiny = segment(2_000, 2_015, 13_500)
    const tick = planSegmentFrameTick({
      segment: tiny,
      playheadMs: 2_005,
      sourceMs: 13_500,
      toleranceMs: 10,
    })
    expect(tick).toEqual({ kind: "advance", timelineMs: 2_000 })
  })
})

describe("planCutTransition", () => {
  const base = {
    hasNext: true,
    contiguous: true,
    standbyHoldsNext: true,
    standbyReady: true,
    activeSeekable: true,
    heldMs: null,
  }

  it("swaps to a ready standby", () => {
    expect(planCutTransition(base)).toEqual({ kind: "swap" })
  })

  it("waits for a standby that is still seeking instead of seeking the player", () => {
    expect(planCutTransition({ ...base, standbyReady: false })).toEqual({
      kind: "hold",
      pauseActive: true,
    })
  })

  it("falls back to a seek once the wait budget is spent", () => {
    expect(planCutTransition({ ...base, standbyReady: false, heldMs: 400 })).toEqual({
      kind: "seek",
    })
  })

  it("never queues a seek on a busy element, even after the budget", () => {
    expect(
      planCutTransition({
        ...base,
        standbyReady: false,
        heldMs: 400,
        activeSeekable: false,
      }),
    ).toEqual({ kind: "hold", pauseActive: false })
  })

  it("seeks immediately when the standby is not even primed for the cut", () => {
    expect(planCutTransition({ ...base, standbyReady: false, standbyHoldsNext: false })).toEqual({
      kind: "seek",
    })
  })

  it("jumps a timeline gap and stops at the end", () => {
    expect(planCutTransition({ ...base, contiguous: false })).toEqual({ kind: "gap" })
    expect(planCutTransition({ ...base, hasNext: false })).toEqual({ kind: "end" })
  })
})
