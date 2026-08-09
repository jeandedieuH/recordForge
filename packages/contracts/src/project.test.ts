import { describe, expect, it } from "vitest"
import { projectSchema, projectAssetSchema, projectExportSettingsSchema } from "./project"

const minimalProject = {
  format: "recordforge.project",
  version: 1,
  id: "project-1",
  name: "My Project",
  recordingId: "rec-1",
  canvas: {
    width: 1920,
    height: 1080,
    fps: 30,
    background: "#000000",
    padding: 0,
    borderRadius: 0,
    shadow: false,
    cursorSettings: {
      preset: "modern-neon",
      scale: 1,
      fillColor: "#3b82f6",
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWidth: 2,
      strokeOpacity: 1,
      shadowEnabled: true,
      shadowColor: "#000000",
      shadowBlur: 8,
      shadowOffsetX: 2,
      shadowOffsetY: 4,
      shadowOpacity: 0.4,
      clickFeedback: "ripple",
      clickColor: "#60a5fa",
      clickSize: 36,
      smoothMovement: true,
      smoothFactor: 0.25,
      autoHideIdle: false,
      idleTimeoutMs: 2000,
      spotlightMode: false,
      spotlightRadius: 120,
      spotlightDimOpacity: 0.5,
      hideNativeCursor: true,
    },
  },
  assets: [
    {
      id: "asset-1",
      role: "screen",
      path: "output.mp4",
      status: "available",
      durationMs: 10_000,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
    },
  ],
  tracks: [
    {
      id: "track-1",
      kind: "screen",
      name: "Screen",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: "clip-1",
          kind: "screen",
          assetId: "asset-1",
          startMs: 0,
          durationMs: 10_000,
          sourceInMs: 0,
          sourceOutMs: 10_000,
          speed: 1,
        },
      ],
    },
  ],
  markers: [],
  exportSettings: {
    preset: "default-mp4",
    codec: "h264",
    container: "mp4",
  },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  checksum: "sha256:abc",
}

describe("project contract", () => {
  it("parses a valid v1 project", () => {
    const parsed = projectSchema.parse(minimalProject)
    expect(parsed.id).toBe("project-1")
    expect(parsed.recordingId).toBe("rec-1")
    expect(parsed.assets[0].role).toBe("screen")
    expect(parsed.tracks[0].clips[0].assetId).toBe("asset-1")
  })

  it("rejects a project with the wrong format", () => {
    expect(() => projectSchema.parse({ ...minimalProject, format: "other.project" })).toThrow()
  })

  it("rejects a project with an unsupported version", () => {
    expect(() => projectSchema.parse({ ...minimalProject, version: 2 })).toThrow()
  })

  it("defaults missing export settings", () => {
    const parsed = projectExportSettingsSchema.parse({})
    expect(parsed).toEqual({
      preset: "default-mp4",
      codec: "h264",
      container: "mp4",
    })
  })

  it("preserves cursor telemetry metadata in the asset registry", () => {
    const parsed = projectAssetSchema.parse({
      id: "cursor-events:rec-1",
      role: "cursor_events",
      path: "cursor_telemetry.json",
      sourceWidth: 1024,
      sourceHeight: 768,
      sampleRateHz: 60,
      schemaVersion: 1,
      captureBounds: { x: 0, y: 0, width: 1024, height: 768 },
      dpiScale: { x: 1, y: 1 },
      timebase: { unit: "ms", ticksPerSecond: 1000 },
    })
    expect(parsed.role).toBe("cursor_events")
    expect(parsed.captureBounds?.width).toBe(1024)
    expect(parsed.timebase?.ticksPerSecond).toBe(1000)
  })

  it("defaults missing asset status", () => {
    const parsed = projectAssetSchema.parse({
      id: "asset-2",
      role: "microphone",
      path: "mic.wav",
      durationMs: 10_000,
    })
    expect(parsed.status).toBe("available")
    expect(parsed.hasAudio).toBe(false)
    expect(parsed.fps).toBeUndefined()
  })
})
