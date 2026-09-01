import { describe, expect, it } from "vitest"
import type { LibraryRecording, MediaMetadata } from "@recordforge/contracts"
import { createProjectFromRecording, createTimelineFromRecording } from "./timeline"

function makeRecording(): LibraryRecording {
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
  }
}

describe("domain", () => {
  it("exports shared contracts", () => {
    expect(true).toBe(true)
  })

  it("maps generic SoundHandler metadata to stable capture track names", () => {
    const metadata: MediaMetadata = {
      recordingId: "recording-1",
      path: "C:/recordforge/session-1/output.mp4",
      durationMs: 60_000,
      width: 1920,
      height: 1080,
      fps: 60,
      hasAudio: true,
      streams: [
        { index: 0, kind: "video", codec: "h264" },
        { index: 1, kind: "audio", codec: "aac", title: "SoundHandler", durationMs: 60_000 },
        { index: 2, kind: "audio", codec: "aac", title: "SoundHandler", durationMs: 60_000 },
      ],
      format: { name: "mov,mp4,m4a,3gp,3g2,mj2" },
      updatedAt: "2026-08-04T12:00:00.000Z",
    }

    const timeline = createTimelineFromRecording(makeRecording(), metadata)

    expect(timeline.tracks.map((track) => track.name)).toEqual([
      "Screen",
      "Microphone",
      "System Audio",
    ])
  })

  it("uses probed media duration when the recorder clock runs longer", () => {
    const metadata: MediaMetadata = {
      recordingId: "recording-1",
      path: "C:/recordforge/session-1/output.mp4",
      durationMs: 1_000,
      width: 1920,
      height: 1080,
      fps: 60,
      hasAudio: false,
      streams: [
        {
          index: 0,
          kind: "video",
          codec: "h264",
          durationMs: 1_000,
          width: 1920,
          height: 1080,
          fps: 60,
        },
      ],
      format: { name: "mov,mp4,m4a,3gp,3g2,mj2", durationMs: 1_000 },
      updatedAt: "2026-08-04T12:00:00.000Z",
    }

    const project = createProjectFromRecording(makeRecording(), metadata)

    expect(project.tracks[0].clips[0]).toMatchObject({
      kind: "screen",
      durationMs: 1_000,
      sourceInMs: 0,
      sourceOutMs: 1_000,
    })
    expect(project.assets[0]).toMatchObject({ role: "screen", durationMs: 1_000 })
  })

  it("creates aligned screen, microphone, and system audio tracks from recorded streams", () => {
    const metadata: MediaMetadata = {
      recordingId: "recording-1",
      path: "C:/recordforge/session-1/output.mp4",
      durationMs: 60_000,
      width: 1920,
      height: 1080,
      fps: 60,
      hasAudio: true,
      streams: [
        { index: 0, kind: "video", codec: "h264", width: 1920, height: 1080, fps: 60 },
        {
          index: 1,
          kind: "audio",
          codec: "aac",
          title: "Microphone",
          durationMs: 60_000,
        },
        {
          index: 2,
          kind: "audio",
          codec: "aac",
          title: "System Audio",
          durationMs: 60_000,
        },
      ],
      format: { name: "mov,mp4,m4a,3gp,3g2,mj2" },
      updatedAt: "2026-08-04T12:00:00.000Z",
    }

    const timeline = createTimelineFromRecording(makeRecording(), metadata)

    expect(timeline.tracks.map((track) => track.name)).toEqual([
      "Screen",
      "Microphone",
      "System Audio",
    ])
    expect(timeline.tracks[0].clips[0]).toMatchObject({
      kind: "screen",
      streamIndex: 0,
      startMs: 0,
      durationMs: 60_000,
    })
    expect(timeline.tracks[1].clips[0]).toMatchObject({
      kind: "audio",
      streamIndex: 1,
      startMs: 0,
      durationMs: 60_000,
    })
    expect(timeline.tracks[2].clips[0]).toMatchObject({
      kind: "audio",
      streamIndex: 2,
      startMs: 0,
      durationMs: 60_000,
    })
  })

  it("creates a camera track backed by the standalone webcam asset", () => {
    const recording = {
      ...makeRecording(),
      webcamPath: "C:/recordforge/session-1/webcam.mp4",
    }
    const metadata: MediaMetadata = {
      recordingId: recording.id,
      path: recording.outputPath ?? "",
      durationMs: 60_000,
      width: 1920,
      height: 1080,
      fps: 60,
      hasAudio: false,
      streams: [{ index: 0, kind: "video", codec: "h264" }],
      format: { name: "mov,mp4,m4a,3gp,3g2,mj2" },
      updatedAt: "2026-08-04T12:00:00.000Z",
    }

    const timeline = createTimelineFromRecording(recording, metadata)
    expect(timeline.canvas.background).toBe(
      "linear-gradient(135deg, #10b981 0%, #06b6d4 50%, #3b82f6 100%)",
    )
    expect(timeline.canvas.padding).toBe(96)
    expect(timeline.tracks.map((track) => track.kind)).toEqual(["screen", "camera"])
    expect(timeline.tracks[1].clips[0]).toMatchObject({
      kind: "camera",
      streamIndex: 1,
      durationMs: 60_000,
      transform: {
        preset: "vertical-pip",
        shape: "rectangle",
        shadowEnabled: true,
        borderWidth: 2,
        width: 240,
        height: 336,
      },
    })

    const project = createProjectFromRecording(recording, metadata)
    expect(project.canvas.background).toBe(
      "linear-gradient(135deg, #10b981 0%, #06b6d4 50%, #3b82f6 100%)",
    )
    expect(project.canvas.padding).toBe(96)
    expect(project.assets).toContainEqual(
      expect.objectContaining({
        role: "webcam",
        path: "webcam.mp4",
        streamIndex: 1,
      }),
    )
    expect(project.tracks[1].clips[0].assetId).toContain(":webcam:1")
    expect(project.tracks[1].clips[0]).toMatchObject({
      transform: {
        preset: "vertical-pip",
        shape: "rectangle",
      },
    })
  })

  it("defaults to Northern Lights background gradient and 0 padding without camera", () => {
    const recording = makeRecording()
    const metadata: MediaMetadata = {
      recordingId: recording.id,
      path: recording.outputPath ?? "",
      durationMs: 10_000,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: false,
      streams: [{ index: 0, kind: "video", codec: "h264" }],
      format: { name: "mp4" },
      updatedAt: "2026-08-04T12:00:00.000Z",
    }
    const timeline = createTimelineFromRecording(recording, metadata)
    expect(timeline.canvas.background).toBe(
      "linear-gradient(135deg, #10b981 0%, #06b6d4 50%, #3b82f6 100%)",
    )
    expect(timeline.canvas.padding).toBe(0)

    const project = createProjectFromRecording(recording, metadata)
    expect(project.canvas.background).toBe(
      "linear-gradient(135deg, #10b981 0%, #06b6d4 50%, #3b82f6 100%)",
    )
    expect(project.canvas.padding).toBe(0)
  })
})

