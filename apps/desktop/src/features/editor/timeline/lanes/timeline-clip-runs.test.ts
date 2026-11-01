import { describe, expect, it } from "vitest"
import type { TimelineClip } from "@recordforge/contracts"
import { computeClipRuns } from "./timeline-clip-runs"

function mockClip(id: string, startMs: number, durationMs: number): TimelineClip {
  return {
    id,
    kind: "screen",
    assetId: "asset",
    startMs,
    durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
  } as unknown as TimelineClip
}

describe("computeClipRuns", () => {
  it("merges exactly adjacent clips into one run", () => {
    const { byClip, runs } = computeClipRuns(
      [mockClip("a", 0, 1000), mockClip("b", 1000, 1000)],
      0.05,
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ id: "a", startMs: 0, endMs: 2000, clipIds: ["a", "b"] })
    expect(byClip.get("a")?.position).toBe("first")
    expect(byClip.get("b")?.position).toBe("last")
  })

  it("merges gaps within the 1ms tolerance", () => {
    const { runs } = computeClipRuns([mockClip("a", 0, 1000), mockClip("b", 1001, 1000)], 10)
    expect(runs).toHaveLength(1)
  })

  it("splits a real gap at any zoom", () => {
    const { byClip, runs } = computeClipRuns(
      [mockClip("a", 0, 1000), mockClip("b", 2000, 1000)],
      10,
    )
    expect(runs).toHaveLength(2)
    expect(byClip.get("a")?.position).toBe("single")
    expect(byClip.get("b")?.position).toBe("single")
  })

  it("merges sub-pixel gaps at fit zoom but splits them at high zoom", () => {
    const clips = [mockClip("a", 0, 1000), mockClip("b", 1005, 1000)]
    // 5ms gap: at 0.1 px/ms that's 0.5px — invisible, merges.
    expect(computeClipRuns(clips, 0.1).runs).toHaveLength(1)
    // At 1 px/ms that's 5px — a real visible gap, splits.
    expect(computeClipRuns(clips, 1).runs).toHaveLength(2)
  })

  it("handles unsorted input", () => {
    const { runs } = computeClipRuns([mockClip("b", 1000, 1000), mockClip("a", 0, 1000)], 0.05)
    expect(runs).toHaveLength(1)
    expect(runs[0].id).toBe("a")
    expect(runs[0].clipIds).toEqual(["a", "b"])
  })

  it("assigns first/middle/last across a three-clip run", () => {
    const { byClip, runs } = computeClipRuns(
      [mockClip("a", 0, 1000), mockClip("b", 1000, 1000), mockClip("c", 2000, 1000)],
      0.05,
    )
    expect(runs).toHaveLength(1)
    expect(byClip.get("a")?.position).toBe("first")
    expect(byClip.get("b")?.position).toBe("middle")
    expect(byClip.get("c")?.position).toBe("last")
    expect(runs[0].clipIds).toEqual(["a", "b", "c"])
  })

  it("tracks immediate neighbors regardless of run boundaries", () => {
    const { byClip } = computeClipRuns(
      [mockClip("a", 0, 1000), mockClip("b", 3000, 1000), mockClip("c", 4000, 1000)],
      0.05,
    )
    expect(byClip.get("a")).toMatchObject({ prevEndMs: null, nextStartMs: 3000 })
    expect(byClip.get("b")).toMatchObject({ prevEndMs: 1000, nextStartMs: 4000 })
    expect(byClip.get("c")).toMatchObject({ prevEndMs: 4000, nextStartMs: null })
  })
})
