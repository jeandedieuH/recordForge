import { describe, expect, it } from "vitest"
import type { LibraryRecording, MediaMetadata } from "@recordforge/contracts"
import { createTimelineFromRecording, freeCanvasSize } from "./timeline"

function makeRecording(overrides: Partial<LibraryRecording> = {}): LibraryRecording {
  return {
    id: "recording-1",
    sessionId: "session-1",
    name: "Recording 1",
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
    durationMs: 60_000,
    sizeBytes: 1024,
    width: 1920,
    height: 1080,
    fps: 60,
    status: "completed",
    tags: [],
    source: {
      kind: "display",
      id: "display-1",
      name: "Main Display",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    },
    profileName: "smooth-demo",
    outputPath: "C:/recordforge/session-1/output.mp4",
    webcamPath: null,
    workDir: "C:/recordforge/session-1",
    thumbnailPath: null,
    markers: [],
    ...overrides,
  }
}

function makeMetadata(overrides: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    recordingId: "recording-1",
    path: "C:/recordforge/session-1/output.mp4",
    durationMs: 60_000,
    width: 1920,
    height: 1080,
    fps: 60,
    hasAudio: false,
    streams: [
      {
        index: 0,
        kind: "video",
        codec: "h264",
        title: "Screen",
        startMs: 0,
        durationMs: 60_000,
        width: 1920,
        height: 1080,
        fps: 60,
        bitrateKbps: 8000,
      },
    ],
    format: { name: "mov,mp4,m4a,3gp,3g2,mj2" },
    updatedAt: "2026-08-04T12:00:00.000Z",
    ...overrides,
  }
}

describe("freeCanvasSize", () => {
  it("keeps source dims for 16:9 sources at or under 1080p", () => {
    expect(freeCanvasSize(1920, 1080)).toEqual({ width: 1920, height: 1080 })
    expect(freeCanvasSize(1280, 720)).toEqual({ width: 1280, height: 720 })
    expect(freeCanvasSize(1600, 900)).toEqual({ width: 1600, height: 900 })
  })

  it("caps 16:9 sources above 1080p to 1920×1080", () => {
    expect(freeCanvasSize(3840, 2160)).toEqual({ width: 1920, height: 1080 })
    expect(freeCanvasSize(2560, 1440)).toEqual({ width: 1920, height: 1080 })
  })

  it("normalizes non-16:9 sources to a 16:9 1080p canvas", () => {
    expect(freeCanvasSize(1080, 1920)).toEqual({ width: 1920, height: 1080 })
    expect(freeCanvasSize(2560, 1080)).toEqual({ width: 1920, height: 1080 })
    expect(freeCanvasSize(1024, 768)).toEqual({ width: 1920, height: 1080 })
  })
})

describe("createTimelineFromRecording canvasPolicy", () => {
  it("defaults to the source canvas", () => {
    const timeline = createTimelineFromRecording(
      makeRecording({ width: 1080, height: 1920 }),
      makeMetadata({ width: 1080, height: 1920 }),
    )
    expect(timeline.canvas.width).toBe(1080)
    expect(timeline.canvas.height).toBe(1920)
  })

  it("produces a Free-compliant canvas under the free policy", () => {
    const timeline = createTimelineFromRecording(
      makeRecording({ width: 1080, height: 1920 }),
      makeMetadata({ width: 1080, height: 1920 }),
      undefined,
      undefined,
      { canvasPolicy: "free" },
    )
    expect(timeline.canvas.width).toBe(1920)
    expect(timeline.canvas.height).toBe(1080)

    const capped = createTimelineFromRecording(
      makeRecording({ width: 3840, height: 2160 }),
      makeMetadata({ width: 3840, height: 2160 }),
      undefined,
      undefined,
      { canvasPolicy: "free" },
    )
    expect(capped.canvas.width).toBe(1920)
    expect(capped.canvas.height).toBe(1080)
  })

  it("keeps small 16:9 sources at native size under the free policy", () => {
    const timeline = createTimelineFromRecording(
      makeRecording({ width: 1280, height: 720 }),
      makeMetadata({ width: 1280, height: 720 }),
      undefined,
      undefined,
      { canvasPolicy: "free" },
    )
    expect(timeline.canvas.width).toBe(1280)
    expect(timeline.canvas.height).toBe(720)
  })
})
