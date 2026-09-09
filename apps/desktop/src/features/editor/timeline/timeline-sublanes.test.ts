import { describe, expect, it } from "vitest"
import type { TimelineClip } from "@recordforge/contracts"
import { computeClipSublanes } from "./timeline-lanes"

function mockClip(id: string, startMs: number, durationMs: number): TimelineClip {
  return {
    id,
    kind: "text",
    startMs,
    durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
    primaryText: `Clip ${id}`,
  } as unknown as TimelineClip
}

describe("computeClipSublanes cluster-based allocation", () => {
  it("assigns single clips full lane height (count: 1)", () => {
    const clip = mockClip("c1", 0, 5000)
    const result = computeClipSublanes([clip])
    expect(result.get("c1")).toEqual({ index: 0, count: 1 })
  })

  it("assigns sequential non-overlapping clips full lane height (count: 1)", () => {
    const c1 = mockClip("c1", 0, 4000)
    const c2 = mockClip("c2", 5000, 4000)
    const c3 = mockClip("c3", 10000, 3000)
    const result = computeClipSublanes([c1, c2, c3])

    expect(result.get("c1")).toEqual({ index: 0, count: 1 })
    expect(result.get("c2")).toEqual({ index: 0, count: 1 })
    expect(result.get("c3")).toEqual({ index: 0, count: 1 })
  })

  it("splits overlapping clips into distinct sublanes with count: 2", () => {
    const c1 = mockClip("c1", 1000, 4000) // 1000 - 5000
    const c2 = mockClip("c2", 2000, 4000) // 2000 - 6000
    const result = computeClipSublanes([c1, c2])

    const sub1 = result.get("c1")
    const sub2 = result.get("c2")
    expect(sub1?.count).toBe(2)
    expect(sub2?.count).toBe(2)
    expect(sub1?.index).not.toBe(sub2?.index)
  })

  it("keeps non-overlapping clips at count: 1 when another cluster has overlaps", () => {
    // Cluster 1: c1 and c2 overlap
    const c1 = mockClip("c1", 0, 4000)
    const c2 = mockClip("c2", 2000, 3000)
    // Cluster 2: c3 is completely isolated later
    const c3 = mockClip("c3", 15000, 4000)

    const result = computeClipSublanes([c1, c2, c3])
    expect(result.get("c1")?.count).toBe(2)
    expect(result.get("c2")?.count).toBe(2)
    expect(result.get("c3")).toEqual({ index: 0, count: 1 })
  })

  it("caps maximum sublanes at 3 for highly dense clusters", () => {
    const c1 = mockClip("c1", 0, 10000)
    const c2 = mockClip("c2", 1000, 10000)
    const c3 = mockClip("c3", 2000, 10000)
    const c4 = mockClip("c4", 3000, 10000)

    const result = computeClipSublanes([c1, c2, c3, c4])
    expect(result.get("c1")?.count).toBe(3)
    expect(result.get("c2")?.count).toBe(3)
    expect(result.get("c3")?.count).toBe(3)
    expect(result.get("c4")?.count).toBe(3)
    for (const id of ["c1", "c2", "c3", "c4"]) {
      expect(result.get(id)?.index).toBeLessThanOrEqual(2)
    }
  })
})
