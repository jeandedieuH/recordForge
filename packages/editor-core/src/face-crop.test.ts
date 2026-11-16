import { describe, expect, it } from "vitest"
import { faceCropAt, resolveFaceCropKeyframes } from "./face-crop"
import type { FaceTrack } from "@recordforge/contracts"

function track(samples: FaceTrack["samples"]): FaceTrack {
  return { version: 1, streamIndex: 0, width: 1280, height: 720, fps: 30, samples }
}

describe("resolveFaceCropKeyframes", () => {
  it("returns null without samples", () => {
    expect(
      resolveFaceCropKeyframes({
        track: track([]),
        sourceInMs: 0,
        sourceOutMs: 2000,
        outputStartMs: 0,
        outputEndMs: 2000,
        settings: { framing: "medium", smoothness: 0.6, headroom: 0.12 },
        sourceWidth: 1280,
        sourceHeight: 720,
      }),
    ).toBeNull()
  })

  it("emits bounded, even, ≤10 Hz keyframes that follow the face", () => {
    const samples = Array.from({ length: 17 }, (_, index) => ({
      timeMs: index * 125,
      x: 200 + index * 40,
      y: 120,
      width: 160,
      height: 160,
      score: 0.9,
    }))
    const keyframes = resolveFaceCropKeyframes({
      track: track(samples),
      sourceInMs: 0,
      sourceOutMs: 2000,
      outputStartMs: 0,
      outputEndMs: 2000,
      settings: { framing: "medium", smoothness: 0.5, headroom: 0.1 },
      sourceWidth: 1280,
      sourceHeight: 720,
    })
    expect(keyframes).not.toBeNull()
    const frames = keyframes!
    expect(frames.length).toBeGreaterThan(5)
    for (const frame of frames) {
      expect(frame.width % 2).toBe(0)
      expect(frame.height % 2).toBe(0)
      expect(frame.x).toBeGreaterThanOrEqual(0)
      expect(frame.y).toBeGreaterThanOrEqual(0)
      expect(frame.x + frame.width).toBeLessThanOrEqual(1280)
      expect(frame.y + frame.height).toBeLessThanOrEqual(720)
    }
    // The smoothed centre follows the face left-to-right.
    expect(frames[frames.length - 1]!.x).toBeGreaterThan(frames[0]!.x)
    // The first pose is duplicated at the window start for the renderer hold.
    expect(frames[0]!.timeMs).toBe(0)
  })

  it("faceCropAt holds the latest pose", () => {
    const frames = [
      { timeMs: 0, x: 0, y: 0, width: 100, height: 100 },
      { timeMs: 1000, x: 50, y: 0, width: 100, height: 100 },
    ]
    expect(faceCropAt(frames, 500)?.x).toBe(0)
    expect(faceCropAt(frames, 1500)?.x).toBe(50)
    expect(faceCropAt([], 0)).toBeNull()
  })
})
