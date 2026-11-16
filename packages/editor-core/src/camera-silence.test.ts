import { describe, expect, it } from "vitest"
import type { CameraLayoutSegment } from "@recordforge/contracts"
import { buildCameraSilenceLayouts, isSilenceLayoutSegment } from "./camera-silence"

function manual(id: string, startMs: number, durationMs: number): CameraLayoutSegment {
  return {
    id,
    startMs,
    durationMs,
    layout: "pip",
    transitionInMs: 400,
    transitionOutMs: 400,
    easing: "smooth",
    source: "manual",
    enabled: true,
    locked: false,
  }
}

let counter = 0
const makeId = () => `silence-${counter++}`

describe("buildCameraSilenceLayouts", () => {
  it("pads, frame-snaps and keeps only real silences", () => {
    counter = 0
    const result = buildCameraSilenceLayouts(
      [],
      [
        { startMs: 1000, endMs: 2000 }, // < 2500 min
        { startMs: 5000, endMs: 9000 },
      ],
      { minSilenceMs: 2500, padMs: 150, transitionMs: 300, fps: 30, durationMs: 12_000 },
      makeId,
    )
    expect(result).toHaveLength(1)
    const segment = result[0]!
    expect(segment.layout).toBe("hidden")
    expect(segment.source).toBe("silence")
    expect(segment.startMs).toBe(5167)
    expect(segment.startMs + segment.durationMs).toBe(8867)
    expect(isSilenceLayoutSegment(segment)).toBe(true)
  })

  it("replaces old silence segments but preserves manual ones and splits around them", () => {
    counter = 0
    const existing = [
      manual("manual-1", 6000, 1000),
      {
        ...manual("old-silence", 0, 3000),
        source: "silence" as const,
        layout: "hidden" as const,
      },
    ]
    const result = buildCameraSilenceLayouts(
      existing,
      [{ startMs: 5000, endMs: 9000 }],
      { minSilenceMs: 2000, padMs: 0, transitionMs: 200, fps: 30, durationMs: 12_000 },
      makeId,
    )
    expect(result.some((segment) => segment.id === "manual-1")).toBe(true)
    expect(result.some((segment) => segment.id === "old-silence")).toBe(false)
    const generated = result.filter(isSilenceLayoutSegment)
    expect(generated.map((segment) => segment.startMs)).toEqual([5000, 7000])
    expect(generated[0]!.durationMs).toBe(1000)
    expect(generated[1]!.durationMs).toBe(2000)
  })
})
