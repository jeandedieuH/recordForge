import { describe, expect, it } from "vitest"
import type { PreviewSegment } from "@recordforge/editor-core"
import { planDualSlotTick, previewSegmentSourceMs } from "./use-dual-media-slots"

function segment(startMs: number, endMs: number, sourceInMs = startMs, speed = 1): PreviewSegment {
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

const segments = [segment(0, 1_000), segment(1_000, 2_000), segment(2_500, 3_500)]

describe("planDualSlotTick", () => {
  it("keeps the active slot while it already holds the active segment", () => {
    const plan = planDualSlotTick({
      segments,
      playheadMs: 500,
      activeSlot: 0,
      slotSegments: [0, -1],
      standbyReady: false,
    })
    expect(plan.swapped).toBe(false)
    expect(plan.activeSlot).toBe(0)
    expect(plan.activeIndex).toBe(0)
    expect(plan.standbyIndex).toBe(1)
  })

  it("swaps to a ready standby exactly at the cut", () => {
    const plan = planDualSlotTick({
      segments,
      playheadMs: 1_000,
      activeSlot: 0,
      slotSegments: [0, 1],
      standbyReady: true,
    })
    expect(plan.activeIndex).toBe(1)
    expect(plan.swapped).toBe(true)
    expect(plan.activeSlot).toBe(1)
    expect(plan.targetSlot).toBe(1)
    expect(plan.standbyIndex).toBe(2)
  })

  it("falls back to the active slot when the standby is not ready", () => {
    const plan = planDualSlotTick({
      segments,
      playheadMs: 1_000,
      activeSlot: 0,
      slotSegments: [0, 1],
      standbyReady: false,
    })
    expect(plan.swapped).toBe(false)
    expect(plan.activeSlot).toBe(0)
    expect(plan.targetSlot).toBe(0)
  })

  it("pauses both slots in a gap and pre-rolls the next segment", () => {
    const plan = planDualSlotTick({
      segments,
      playheadMs: 2_200,
      activeSlot: 0,
      slotSegments: [1, 2],
      standbyReady: false,
    })
    expect(plan.pauseAll).toBe(true)
    expect(plan.activeIndex).toBe(-1)
    expect(plan.standbyIndex).toBe(2)
    expect(plan.activeSlot).toBe(0)
  })

  it("maps the playhead into a segment's source, honoring speed and clamping", () => {
    const fast = segment(0, 1_000, 10_000, 2)
    expect(previewSegmentSourceMs(fast, 0)).toBe(10_000)
    expect(previewSegmentSourceMs(fast, 500)).toBe(11_000)
    expect(previewSegmentSourceMs(fast, 1_500)).toBe(12_000)
    expect(previewSegmentSourceMs(fast, -100)).toBe(10_000)
  })
})
