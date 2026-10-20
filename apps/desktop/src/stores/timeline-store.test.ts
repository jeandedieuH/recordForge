import { describe, expect, it } from "vitest"
import { useTimelineStore } from "./timeline-store"
import type { recordForgeProject } from "@recordforge/contracts"
import { defaultCursorSettings, defaultKeystrokeOverlaySettings } from "@recordforge/contracts"

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
      audioMastering: { denoise: false, loudnessTarget: null },
      brandWatermark: {
        enabled: false,
        logoPath: null,
        position: "bottom-right",
        scalePercent: 8,
        opacity: 0.85,
      },
      brandCards: {
        enabled: false,
        introMs: 0,
        outroMs: 0,
        title: null,
        subtitle: null,
        background: "#0f172a",
        textColor: "#f8fafc",
        fontPath: null,
      },
      keystrokeOverlay: { ...defaultKeystrokeOverlaySettings },
      reframeMode: "fit",
      webcamBackground: {
        enabled: false,
        mode: "blur" as const,
        blurSigma: 20,
        replaceColor: "#0f172a",
      },
      formats: [],
      instantShare: { enabled: false, target: "hosted", expiresInDays: 30 },
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
          audioMastering: { denoise: false, loudnessTarget: null },
          brandWatermark: {
            enabled: false,
            logoPath: null,
            position: "bottom-right",
            scalePercent: 8,
            opacity: 0.85,
          },
          brandCards: {
            enabled: false,
            introMs: 0,
            outroMs: 0,
            title: null,
            subtitle: null,
            background: "#0f172a",
            textColor: "#f8fafc",
            fontPath: null,
          },
          keystrokeOverlay: { ...defaultKeystrokeOverlaySettings },
          reframeMode: "fit",
          webcamBackground: {
            enabled: false,
            mode: "blur" as const,
            blurSigma: 20,
            replaceColor: "#0f172a",
          },
          formats: [],
          instantShare: { enabled: false, target: "hosted", expiresInDays: 30 },
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
          audioMastering: { denoise: false, loudnessTarget: null },
          brandWatermark: {
            enabled: false,
            logoPath: null,
            position: "bottom-right",
            scalePercent: 8,
            opacity: 0.85,
          },
          brandCards: {
            enabled: false,
            introMs: 0,
            outroMs: 0,
            title: null,
            subtitle: null,
            background: "#0f172a",
            textColor: "#f8fafc",
            fontPath: null,
          },
          keystrokeOverlay: { ...defaultKeystrokeOverlaySettings },
          reframeMode: "fit",
          webcamBackground: {
            enabled: false,
            mode: "blur" as const,
            blurSigma: 20,
            replaceColor: "#0f172a",
          },
          formats: [],
          instantShare: { enabled: false, target: "hosted", expiresInDays: 30 },
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

  it("switches container to webp and automatically sets webp-balanced preset and webp codec", () => {
    useTimelineStore.setState({
      project: createMockProject(),
    })

    const { setExportContainer } = useTimelineStore.getState()
    setExportContainer("webp")

    const updated = useTimelineStore.getState().project
    expect(updated?.exportSettings.container).toBe("webp")
    expect(updated?.exportSettings.preset).toBe("webp-balanced")
    expect(updated?.exportSettings.codec).toBe("webp")
    expect(updated?.exportSettings.chapterMode).toBe("none")
  })

  it("switches container from webp back to mp4 and restores standard balanced preset and h264 codec", () => {
    useTimelineStore.setState({
      project: {
        ...createMockProject(),
        exportSettings: {
          preset: "webp-high-quality",
          container: "webp",
          codec: "webp",
          encoder: "auto",
          captionMode: "burn-in",
          chapterMode: "none",
          audioMastering: { denoise: false, loudnessTarget: null },
          brandWatermark: {
            enabled: false,
            logoPath: null,
            position: "bottom-right",
            scalePercent: 8,
            opacity: 0.85,
          },
          brandCards: {
            enabled: false,
            introMs: 0,
            outroMs: 0,
            title: null,
            subtitle: null,
            background: "#0f172a",
            textColor: "#f8fafc",
            fontPath: null,
          },
          keystrokeOverlay: { ...defaultKeystrokeOverlaySettings },
          reframeMode: "fit",
          webcamBackground: {
            enabled: false,
            mode: "blur" as const,
            blurSigma: 20,
            replaceColor: "#0f172a",
          },
          formats: [],
          instantShare: { enabled: false, target: "hosted", expiresInDays: 30 },
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

  it("selecting a webp preset updates container and codec to webp", () => {
    useTimelineStore.setState({
      project: createMockProject(),
    })

    const { setExportPreset } = useTimelineStore.getState()
    setExportPreset("webp-fast")

    const updated = useTimelineStore.getState().project
    expect(updated?.exportSettings.preset).toBe("webp-fast")
    expect(updated?.exportSettings.container).toBe("webp")
    expect(updated?.exportSettings.codec).toBe("webp")
  })

  it("selecting selected-range while in webp mode retains webp container", () => {
    useTimelineStore.setState({
      project: {
        ...createMockProject(),
        exportSettings: {
          preset: "webp-balanced",
          container: "webp",
          codec: "webp",
          encoder: "auto",
          captionMode: "burn-in",
          chapterMode: "none",
          audioMastering: { denoise: false, loudnessTarget: null },
          brandWatermark: {
            enabled: false,
            logoPath: null,
            position: "bottom-right",
            scalePercent: 8,
            opacity: 0.85,
          },
          brandCards: {
            enabled: false,
            introMs: 0,
            outroMs: 0,
            title: null,
            subtitle: null,
            background: "#0f172a",
            textColor: "#f8fafc",
            fontPath: null,
          },
          keystrokeOverlay: { ...defaultKeystrokeOverlaySettings },
          reframeMode: "fit",
          webcamBackground: {
            enabled: false,
            mode: "blur" as const,
            blurSigma: 20,
            replaceColor: "#0f172a",
          },
          formats: [],
          instantShare: { enabled: false, target: "hosted", expiresInDays: 30 },
        },
      },
    })

    const { setExportPreset } = useTimelineStore.getState()
    setExportPreset("selected-range")

    const updated = useTimelineStore.getState().project
    expect(updated?.exportSettings.preset).toBe("selected-range")
    expect(updated?.exportSettings.container).toBe("webp")
    expect(updated?.exportSettings.codec).toBe("webp")
  })
})

// Persistence contract: every export-setting setter must write into
// `project.exportSettings` (the durable object that save_project round-trips
// through Rust). A setter that writes session-local state regresses into
// "the toggle does not persist" — see the ProjectExportSettings fix in
// src-tauri/src/projects/mod.rs.
describe("Export settings persistence contract", () => {
  it("setExportFormats stores multi-format batch picks in the project", () => {
    useTimelineStore.setState({ project: createMockProject() })

    useTimelineStore.getState().setExportFormats(["16:9", "9:16"])

    const updated = useTimelineStore.getState().project
    expect(updated?.exportSettings.formats).toEqual(["16:9", "9:16"])
  })

  it("setExportFormats dedupes and does not churn on identical input", () => {
    const project = createMockProject()
    useTimelineStore.setState({ project })

    useTimelineStore.getState().setExportFormats(["9:16", "9:16", "1:1"])
    expect(useTimelineStore.getState().project?.exportSettings.formats).toEqual(["9:16", "1:1"])

    const revision = useTimelineStore.getState().projectRevision
    useTimelineStore.getState().setExportFormats(["9:16", "1:1"])
    expect(useTimelineStore.getState().projectRevision).toBe(revision)
  })

  it("setInstantShare stores enabled/target/expiry in the project", () => {
    useTimelineStore.setState({ project: createMockProject() })

    useTimelineStore.getState().setInstantShare({
      enabled: true,
      target: "s3-profile-1",
      expiresInDays: 90,
    })

    const updated = useTimelineStore.getState().project
    expect(updated?.exportSettings.instantShare).toEqual({
      enabled: true,
      target: "s3-profile-1",
      expiresInDays: 90,
    })
  })

  it("premium setters write into project.exportSettings for autosave", () => {
    useTimelineStore.setState({ project: createMockProject() })

    useTimelineStore.getState().setBrandWatermark({
      enabled: true,
      logoPath: "brand/logo.png",
      position: "top-left",
      scalePercent: 12,
      opacity: 0.6,
    })
    useTimelineStore.getState().setKeystrokeOverlay({ enabled: true })
    useTimelineStore.getState().setReframeMode("cursor-follow")
    useTimelineStore.getState().setWebcamBackground({
      enabled: true,
      mode: "replace",
      blurSigma: 30,
      replaceColor: "#112233",
    })

    const settings = useTimelineStore.getState().project?.exportSettings
    expect(settings?.brandWatermark.enabled).toBe(true)
    expect(settings?.brandWatermark.logoPath).toBe("brand/logo.png")
    expect(settings?.keystrokeOverlay.enabled).toBe(true)
    expect(settings?.reframeMode).toBe("cursor-follow")
    expect(settings?.webcamBackground.enabled).toBe(true)
  })
})
