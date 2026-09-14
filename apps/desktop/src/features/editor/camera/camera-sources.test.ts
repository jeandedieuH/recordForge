import { describe, expect, it } from "vitest"
import type {
  CameraClip,
  LibraryRecording,
  MediaJob,
  MediaMetadata,
  TimelineState,
  recordForgeProject,
} from "@recordforge/contracts"
import { collectCameraSources, resolveCameraSourceSize } from "./camera-sources"

function makeClip(overrides?: Partial<CameraClip>): CameraClip {
  return {
    id: "camera-clip",
    kind: "camera",
    assetId: "recording",
    streamIndex: 1,
    startMs: 0,
    durationMs: 10_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
    speed: 1,
    transform: {
      x: 0,
      y: 0,
      width: 240,
      height: 336,
      opacity: 1,
      shape: "rectangle",
    },
    ...overrides,
  }
}

const emptyCtx = { project: null, metadata: null, activeJob: null, recording: null }

describe("resolveCameraSourceSize", () => {
  it("prefers the prepared derivative output", () => {
    const clip = makeClip()
    const size = resolveCameraSourceSize(clip, {
      ...emptyCtx,
      activeJob: {
        outputs: { videoTracks: [{ streamIndex: 1, width: 1920, height: 1080 }] },
      } as unknown as MediaJob,
      project: { assets: [{ id: "recording", width: 640, height: 480 }] } as recordForgeProject,
      metadata: {
        streams: [{ index: 1, kind: "video", width: 800, height: 600 }],
      } as MediaMetadata,
    })
    expect(size).toEqual({ width: 1920, height: 1080 })
  })

  it("falls back to the project asset, then the probed stream", () => {
    const clip = makeClip()
    const fromAsset = resolveCameraSourceSize(clip, {
      ...emptyCtx,
      project: { assets: [{ id: "recording", width: 640, height: 480 }] } as recordForgeProject,
      metadata: {
        streams: [{ index: 1, kind: "video", width: 800, height: 600 }],
      } as MediaMetadata,
    })
    expect(fromAsset).toEqual({ width: 640, height: 480 })

    const fromStream = resolveCameraSourceSize(clip, {
      ...emptyCtx,
      metadata: {
        streams: [{ index: 1, kind: "video", width: 800, height: 600 }],
      } as MediaMetadata,
    })
    expect(fromStream).toEqual({ width: 800, height: 600 })
  })

  it("uses a 720p placeholder for unprobed webcam captures", () => {
    const clip = makeClip()
    const size = resolveCameraSourceSize(clip, {
      ...emptyCtx,
      recording: { webcamPath: "webcam.mp4" } as LibraryRecording,
    })
    expect(size).toEqual({ width: 1280, height: 720 })
  })

  it("returns null when nothing is known", () => {
    // streamIndex 0 + no webcam path = not treated as a camera stream
    const clip = makeClip({ streamIndex: 0 })
    expect(resolveCameraSourceSize(clip, emptyCtx)).toBeNull()
  })
})

describe("collectCameraSources", () => {
  it("maps resolvable camera clips and skips everything else", () => {
    const timeline = {
      tracks: [
        {
          id: "screen",
          kind: "screen",
          clips: [{ id: "screen-clip", kind: "screen" }],
        },
        {
          id: "camera",
          kind: "camera",
          clips: [makeClip({ id: "cam-a" }), makeClip({ id: "cam-b", streamIndex: 0 })],
        },
      ],
    } as unknown as TimelineState

    const sources = collectCameraSources(timeline, {
      ...emptyCtx,
      metadata: {
        streams: [{ index: 1, kind: "video", width: 1280, height: 720 }],
      } as MediaMetadata,
    })

    expect(sources).toEqual({ "cam-a": { width: 1280, height: 720 } })
  })
})
