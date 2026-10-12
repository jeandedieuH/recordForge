import { describe, expect, it } from "vitest"
import type { LibraryRecording } from "@recordforge/contracts"
import { isCameraRecording } from "./library"

function makeRecording(source?: LibraryRecording["source"]): LibraryRecording {
  return {
    id: "recording-1",
    sessionId: "session-1",
    name: "Recording 1",
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
    durationMs: 10_000,
    sizeBytes: 1024,
    width: 1280,
    height: 720,
    fps: 30,
    status: "completed",
    tags: [],
    // Rows predating the `source` column arrive without it at runtime.
    source: source as LibraryRecording["source"],
    profileName: "camera-balanced",
    outputPath: "C:/recordforge/session-1/output.mp4",
    webcamPath: null,
    workDir: "C:/recordforge/session-1",
    thumbnailPath: null,
    markers: [],
  }
}

describe("isCameraRecording", () => {
  it("detects camera-source recordings", () => {
    const recording = makeRecording({
      kind: "camera",
      id: "Integrated Webcam",
      name: "Integrated Webcam",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    })
    expect(isCameraRecording(recording)).toBe(true)
  })

  it("treats screen/window/region and missing sources as non-camera", () => {
    expect(
      isCameraRecording(
        makeRecording({
          kind: "display",
          id: "d1",
          name: "Display",
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        }),
      ),
    ).toBe(false)
    expect(isCameraRecording(makeRecording(undefined))).toBe(false)
    expect(isCameraRecording(null)).toBe(false)
    expect(isCameraRecording(undefined)).toBe(false)
  })
})
