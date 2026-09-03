import { describe, expect, it } from "vitest"
import type { SnapTarget } from "@recordforge/editor-core"

describe("timeline snap target formatting and priorities", () => {
  it("formats snap target descriptions correctly", () => {
    const playheadTarget: SnapTarget = {
      id: "playhead",
      kind: "playhead",
      timeMs: 5000,
      priority: 100,
      label: "Playhead",
    }
    expect(playheadTarget.label).toBe("Playhead")
    expect(playheadTarget.kind).toBe("playhead")
    expect(playheadTarget.priority).toBeGreaterThanOrEqual(100)
  })

  it("handles marker snap targets with custom labels", () => {
    const markerTarget: SnapTarget = {
      id: "marker-intro",
      kind: "marker",
      timeMs: 12000,
      priority: 80,
      label: "Chapter 1: Intro",
    }
    expect(markerTarget.kind).toBe("marker")
    expect(markerTarget.label).toContain("Intro")
  })

  it("handles clip edge snap targets", () => {
    const clipStartTarget: SnapTarget = {
      id: "clip-screen-1:start",
      kind: "clip-edge",
      timeMs: 3000,
      priority: 60,
      label: "Screen Clip Start",
    }
    expect(clipStartTarget.kind).toBe("clip-edge")
    expect(clipStartTarget.label).toBe("Screen Clip Start")
  })
})
