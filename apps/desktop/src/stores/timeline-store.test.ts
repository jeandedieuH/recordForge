import { describe, expect, it } from "vitest"
import { useTimelineStore } from "./timeline-store"
import type { recordForgeProject } from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/contracts"

function createMockProject(): recordForgeProject {
  return {
    id: "proj-1",
    name: "Demo Project",
    recordingId: "rec-1",
    format: "recordforge.project",
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    assets: [],
    tracks: [],
    markers: [],
    checksum: "sha256:mock",
    exportSettings: {
      preset: "balanced",
      container: "mp4",
      codec: "h264",
      encoder: "auto",
      captionMode: "burn-in",
      chapterMode: "embed",
    },
  }
}

describe("TimelineStore Export Settings Actions", () => {
  it("switches container to gif and automatically sets gif-balanced preset and gif codec", () => {
    useTimelineStore.setState({
      project: createMockProject(),
    })

    const { setExportContainer } = useTimelineStore.getState()
    setExportContainer("gif")

    const updated = useTimelineStore.getState().project
    expect(updated?.exportSettings.container).toBe("gif")
    expect(updated?.exportSettings.preset).toBe("gif-balanced")
    expect(updated?.exportSettings.codec).toBe("gif")
    expect(updated?.exportSettings.chapterMode).toBe("none")
  })

  it("switches container back to mp4 and restores standard balanced preset and h264 codec", () => {
    useTimelineStore.setState({
      project: {
        ...createMockProject(),
        exportSettings: {
          preset: "gif-high-quality",
          container: "gif",
          codec: "gif",
          encoder: "auto",
          captionMode: "burn-in",
          chapterMode: "none",
        },
      },
    })

    const { setExportContainer } = useTimelineStore.getState()
    setExportContainer("mp4")

    const updated = useTimelineStore.getState().project
    expect(updated?.exportSettings.container).toBe("mp4")
    expect(updated?.exportSettings.preset).toBe("balanced")
    expect(updated?.exportSettings.codec).toBe("h264")
  })

  it("selecting a gif preset updates container and codec to gif", () => {
    useTimelineStore.setState({
      project: createMockProject(),
    })

    const { setExportPreset } = useTimelineStore.getState()
    setExportPreset("gif-fast")

    const updated = useTimelineStore.getState().project
    expect(updated?.exportSettings.preset).toBe("gif-fast")
    expect(updated?.exportSettings.container).toBe("gif")
    expect(updated?.exportSettings.codec).toBe("gif")
  })

  it("selecting selected-range while in gif mode retains gif container", () => {
    useTimelineStore.setState({
      project: {
        ...createMockProject(),
        exportSettings: {
          preset: "gif-balanced",
          container: "gif",
          codec: "gif",
          encoder: "auto",
          captionMode: "burn-in",
          chapterMode: "none",
        },
      },
    })

    const { setExportPreset } = useTimelineStore.getState()
    setExportPreset("selected-range")

    const updated = useTimelineStore.getState().project
    expect(updated?.exportSettings.preset).toBe("selected-range")
    expect(updated?.exportSettings.container).toBe("gif")
    expect(updated?.exportSettings.codec).toBe("gif")
  })
})
