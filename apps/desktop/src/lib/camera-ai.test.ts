import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CameraClip, ProjectAsset } from "@recordforge/contracts"

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }))
vi.mock("./ipc", () => ({ invokeValidated: vi.fn() }))

import { invokeValidated } from "./ipc"
import { loadCameraAiArtifactsForExport } from "./camera-ai"

const mockedInvoke = vi.mocked(invokeValidated)

function makeCameraClip(streamIndex: number, assetId: string): CameraClip {
  return {
    id: `clip-${streamIndex}`,
    kind: "camera",
    assetId,
    streamIndex,
    startMs: 0,
    durationMs: 10_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
    speed: 1,
    transform: {
      x: 0,
      y: 0,
      width: 320,
      height: 240,
      opacity: 1,
      shape: "rectangle",
      visible: true,
      borderWidth: 0,
      shadowEnabled: false,
    },
  } as CameraClip
}

function makeAsset(id: string, path: string, streamIndex: number): ProjectAsset {
  return {
    id,
    role: "webcam",
    path,
    status: "available",
    derivativeVersion: 1,
    durationMs: 10_000,
    hasAudio: false,
    streamIndex,
  }
}

describe("loadCameraAiArtifactsForExport", () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it("keys standalone webcam artifacts by -1 while fetching the synthetic stream dir", async () => {
    mockedInvoke.mockImplementation((command: string) => {
      if (command === "get_camera_ai_artifacts") {
        return Promise.resolve({ mattePath: "/work/stream_003/matte.mp4" })
      }
      return Promise.resolve(null)
    })

    const assets = [makeAsset("rec-1:webcam:3", "webcam.mp4", 3)]
    const result = await loadCameraAiArtifactsForExport(
      "rec-1",
      [makeCameraClip(3, "rec-1:webcam:3")],
      assets,
    )

    // The derivative dir keeps the synthetic stream index…
    expect(mockedInvoke).toHaveBeenCalledWith(
      "get_camera_ai_artifacts",
      { recordingId: "rec-1", streamIndex: 3 },
      expect.anything(),
    )
    // …but the render plan looks standalone webcams up under "-1".
    expect(result["-1"]?.mattePath).toBe("/work/stream_003/matte.mp4")
    expect(result["3"]).toBeUndefined()
  })

  it("keeps the real stream key for webcam streams inside the output file", async () => {
    mockedInvoke.mockImplementation((command: string) => {
      if (command === "get_camera_ai_artifacts") {
        return Promise.resolve({ mattePath: "/work/stream_001/matte.mp4" })
      }
      return Promise.resolve(null)
    })

    // Embedded camera stream: same container path as the primary output.
    const assets = [makeAsset("rec-1:webcam:1", "output.mp4", 1)]
    const result = await loadCameraAiArtifactsForExport(
      "rec-1",
      [makeCameraClip(1, "rec-1:webcam:1")],
      assets,
    )

    expect(result["1"]?.mattePath).toBe("/work/stream_001/matte.mp4")
    expect(result["-1"]).toBeUndefined()
  })
})
