import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CursorTelemetryFile,
  LibraryRecording,
  MediaMetadata,
  recordForgeProject,
} from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/contracts"
import type { CursorEngine } from "@recordforge/cursor-core"
import { createEngine } from "@recordforge/editor-core"
import { createTimelineFromRecording } from "@recordforge/domain"
import { useTimelineStore } from "./timeline-store"

// Hoisted spies shared by the module mocks below.
const mocks = vi.hoisted(() => ({
  listRecordings: vi.fn(),
  getMediaMetadata: vi.fn(),
  listMediaJobs: vi.fn(),
  getMediaJob: vi.fn(),
  prepareRecordingMedia: vi.fn(),
  onMediaJobUpdate: vi.fn(),
  cancelMediaJob: vi.fn(),
  requestPreviewProxy: vi.fn(),
  getCursorTelemetry: vi.fn(),
  getSetting: vi.fn(),
  isTauri: vi.fn(),
  getRecordingSmartZoom: vi.fn(),
  loadProject: vi.fn(),
  createProject: vi.fn(),
  saveProject: vi.fn(),
  snapshotProject: vi.fn(),
  getProjectAssetPaths: vi.fn(),
  relinkAsset: vi.fn(),
  resolveAssetPath: vi.fn(),
  exportTimeline: vi.fn(),
  retryExport: vi.fn(),
  revealExport: vi.fn(),
  notifyExportFinished: vi.fn(),
  createCursorEngine: vi.fn(),
  createWasmCursorEngine: vi.fn(),
}))

vi.mock("@recordforge/cursor-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@recordforge/cursor-core")>()),
  createCursorEngine: mocks.createCursorEngine,
  createWasmCursorEngine: mocks.createWasmCursorEngine,
}))
vi.mock("../lib/library", () => ({ listRecordings: mocks.listRecordings }))
vi.mock("../lib/media", () => ({
  getMediaMetadata: mocks.getMediaMetadata,
  listMediaJobs: mocks.listMediaJobs,
  getMediaJob: mocks.getMediaJob,
  prepareRecordingMedia: mocks.prepareRecordingMedia,
  onMediaJobUpdate: mocks.onMediaJobUpdate,
  cancelMediaJob: mocks.cancelMediaJob,
  requestPreviewProxy: mocks.requestPreviewProxy,
}))
vi.mock("../lib/cursor", () => ({ getCursorTelemetry: mocks.getCursorTelemetry }))
vi.mock("../lib/settings", () => ({
  getSetting: mocks.getSetting,
  isTauri: mocks.isTauri,
}))
vi.mock("../lib/recorder", () => ({ getRecordingSmartZoom: mocks.getRecordingSmartZoom }))
vi.mock("../lib/project", () => ({
  loadProject: mocks.loadProject,
  createProject: mocks.createProject,
  saveProject: mocks.saveProject,
  snapshotProject: mocks.snapshotProject,
}))
vi.mock("../lib/assets", () => ({
  getProjectAssetPaths: mocks.getProjectAssetPaths,
  relinkAsset: mocks.relinkAsset,
  resolveAssetPath: mocks.resolveAssetPath,
}))
vi.mock("../lib/timeline", () => ({
  exportTimeline: mocks.exportTimeline,
  retryExport: mocks.retryExport,
  revealExport: mocks.revealExport,
}))
vi.mock("../lib/export-notifications", () => ({
  notifyExportFinished: mocks.notifyExportFinished,
}))

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function fakeEngine(
  telemetry: CursorTelemetryFile,
): CursorEngine & { dispose: ReturnType<typeof vi.fn> } {
  return {
    evaluate: vi.fn(),
    evaluateMotionPlan: vi.fn(),
    dispose: vi.fn(),
    telemetry,
  } as CursorEngine & { dispose: ReturnType<typeof vi.fn> }
}

function fakeRecording(id: string): LibraryRecording {
  return {
    id,
    sessionId: `session-${id}`,
    name: `Recording ${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    durationMs: 60_000,
    sizeBytes: 1_000,
    width: 1920,
    height: 1080,
    fps: 30,
    status: "completed",
    tags: [],
    source: {
      kind: "display",
      id: "display-1",
      name: "Primary",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    },
    profileName: "1080p",
    outputPath: `videos/${id}.mp4`,
    webcamPath: null,
    workDir: `sessions/${id}`,
    thumbnailPath: null,
    markers: [],
  } as LibraryRecording
}

function fakeTelemetry(recordingId: string): CursorTelemetryFile {
  return {
    schemaVersion: 2,
    assetId: `cursor-events:${recordingId}`,
    recordingId,
    sourceWidth: 1920,
    sourceHeight: 1080,
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    coordinateTransform: { a00: 1, a01: 0, a10: 0, a11: 1, b0: 0, b1: 0 },
    shapes: [],
    timebase: { unit: "ms", ticksPerSecond: 1000 },
    sampleRateHz: 60,
    clickWindowMs: 350,
    health: "healthy",
    eventCount: 0,
    index: [],
    eventFile: "cursor_events.bin",
    events: [],
  } as CursorTelemetryFile
}

function fakeProject(recordingId: string): recordForgeProject {
  return {
    id: `proj-${recordingId}`,
    name: `Project ${recordingId}`,
    recordingId,
    format: "recordforge.project",
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
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
    // A zoom track is already present so projectToTimeline does not trigger
    // the cursor-track migration autosave during these tests.
    tracks: [
      {
        id: "zoom",
        kind: "zoom",
        name: "Zoom",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [],
      },
    ],
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
      keystrokeOverlay: { enabled: false },
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
  } as recordForgeProject
}

const telemetryByRecording = new Map<string, CursorTelemetryFile>([
  ["rec-1", fakeTelemetry("rec-1")],
  ["rec-2", fakeTelemetry("rec-2")],
])
const projectByRecording = new Map<string, recordForgeProject>([
  ["rec-1", fakeProject("rec-1")],
  ["rec-2", fakeProject("rec-2")],
])
const wasmDeferreds = new Map<CursorTelemetryFile, Deferred<CursorEngine>>()

describe("timeline-store cursor engine lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wasmDeferreds.clear()

    mocks.listRecordings.mockResolvedValue([fakeRecording("rec-1"), fakeRecording("rec-2")])
    mocks.getMediaMetadata.mockResolvedValue(null)
    mocks.listMediaJobs.mockResolvedValue([])
    mocks.getMediaJob.mockResolvedValue(null)
    mocks.prepareRecordingMedia.mockResolvedValue({
      id: "prepare-1",
      kind: "prepare",
      status: "completed",
      outputs: {
        prepareVersion: 7,
        audioTracks: [{ audioPath: "audio.wav", waveformPath: "waveform.json" }],
        videoTracks: [],
      },
    })
    mocks.onMediaJobUpdate.mockResolvedValue(() => {})
    mocks.getCursorTelemetry.mockImplementation((recordingId: string) =>
      Promise.resolve(telemetryByRecording.get(recordingId) ?? null),
    )
    mocks.getSetting.mockResolvedValue(null)
    mocks.isTauri.mockReturnValue(true)
    mocks.getRecordingSmartZoom.mockResolvedValue(null)
    mocks.loadProject.mockImplementation((recordingId: string) =>
      Promise.resolve({ project: projectByRecording.get(recordingId), missingAssets: [] }),
    )
    mocks.getProjectAssetPaths.mockResolvedValue({})
    mocks.resolveAssetPath.mockReturnValue(null)
    mocks.createCursorEngine.mockImplementation((telemetry: CursorTelemetryFile) =>
      fakeEngine(telemetry),
    )
    // The WASM upgrade stays pending until the test resolves it, reproducing
    // the slow-init window where a second project load can interleave.
    mocks.createWasmCursorEngine.mockImplementation((telemetry: CursorTelemetryFile) => {
      const pending = deferred<CursorEngine>()
      wasmDeferreds.set(telemetry, pending)
      return pending.promise
    })

    useTimelineStore.setState({
      cursorTelemetry: null,
      cursorEngine: null,
      isListening: false,
      unlisten: null,
      autosaveTimeout: null,
    })
  })

  it("does not install a WASM engine that resolves after a newer project load", async () => {
    const telemetryA = telemetryByRecording.get("rec-1")!
    const telemetryB = telemetryByRecording.get("rec-2")!

    await useTimelineStore.getState().load("rec-1")
    const tsEngineA = useTimelineStore.getState().cursorEngine
    expect(tsEngineA?.telemetry).toBe(telemetryA)
    expect(mocks.createWasmCursorEngine).toHaveBeenCalledWith(telemetryA)

    // The second load replaces the telemetry while the first WASM build is
    // still in flight; it also disposes the first TypeScript engine.
    await useTimelineStore.getState().load("rec-2")
    const tsEngineB = useTimelineStore.getState().cursorEngine
    expect(tsEngineB?.telemetry).toBe(telemetryB)
    expect(tsEngineA?.dispose).toHaveBeenCalledTimes(1)

    // The stale WASM engine must be disposed rather than installed.
    const staleWasm = fakeEngine(telemetryA)
    wasmDeferreds.get(telemetryA)!.resolve(staleWasm)
    await Promise.resolve()
    await Promise.resolve()

    expect(staleWasm.dispose).toHaveBeenCalledTimes(1)
    expect(useTimelineStore.getState().cursorEngine).toBe(tsEngineB)

    // The current load's WASM engine installs and disposes the TS fallback.
    const wasmB = fakeEngine(telemetryB)
    wasmDeferreds.get(telemetryB)!.resolve(wasmB)
    await Promise.resolve()
    await Promise.resolve()

    expect(tsEngineB?.dispose).toHaveBeenCalledTimes(1)
    expect(useTimelineStore.getState().cursorEngine).toBe(wasmB)
  })

  it("disposes the cursor engine when the session resets", () => {
    const engine = fakeEngine(telemetryByRecording.get("rec-1")!)
    useTimelineStore.setState({ cursorEngine: engine, autosaveTimeout: null })

    useTimelineStore.getState().resetSession()

    expect(engine.dispose).toHaveBeenCalledTimes(1)
    expect(useTimelineStore.getState().cursorEngine).toBeNull()
  })
})

function fakeMetadata(recording: LibraryRecording): MediaMetadata {
  return {
    recordingId: recording.id,
    path: recording.outputPath ?? "",
    durationMs: recording.durationMs,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
    streams: [
      {
        index: 0,
        kind: "video",
        codec: "h264",
        width: 1920,
        height: 1080,
        fps: 30,
        durationMs: recording.durationMs,
      },
      {
        index: 1,
        kind: "audio",
        codec: "aac",
        sampleRate: 48000,
        channels: 2,
        channelLayout: "stereo",
        durationMs: recording.durationMs,
      },
    ],
    format: { name: "mov,mp4,m4a,3gp,3g2,mj2", durationMs: recording.durationMs },
    updatedAt: new Date().toISOString(),
  }
}

describe("timeline-store batch export", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.saveProject.mockImplementation(async (project: recordForgeProject) => project)
    mocks.exportTimeline.mockImplementation(async (options: { outputPath: string }) => ({
      id: `job-${options.outputPath}`,
      kind: "export",
      status: "pending",
    }))
  })

  it("submits one export job per selected format, each with its own canvas and output path", async () => {
    const recording = fakeRecording("rec-1")
    const project = fakeProject("rec-1")
    project.exportSettings.formats = ["16:9", "9:16", "1:1"]
    const timeline = createTimelineFromRecording(
      recording,
      fakeMetadata(recording),
      project.name,
      project.id,
    )

    useTimelineStore.setState({
      project,
      recording,
      engine: createEngine(timeline),
      missingAssets: [],
      activeExportJob: null,
      cursorTelemetry: null,
      cursorEngine: null,
      error: null,
      savePromise: null,
    })

    await useTimelineStore.getState().export("D:/out/demo.mp4")

    expect(mocks.exportTimeline).toHaveBeenCalledTimes(3)
    const outputs = mocks.exportTimeline.mock.calls.map(([options]) => options.outputPath)
    expect(outputs).toEqual([
      "D:/out/demo.mp4",
      "D:/out/demo-vertical.mp4",
      "D:/out/demo-square.mp4",
    ])
    const canvases = mocks.exportTimeline.mock.calls.map(
      ([options]) =>
        [
          options.plan.canvas?.width,
          options.plan.canvas?.height,
          options.plan.canvas?.aspectRatio,
        ] as const,
    )
    expect(canvases).toEqual([
      [1920, 1080, "16:9"],
      [1080, 1920, "9:16"],
      [1080, 1080, "1:1"],
    ])
    expect(useTimelineStore.getState().error).toBeNull()
    expect(useTimelineStore.getState().activeExportJob?.id).toBe("job-D:/out/demo.mp4")
  })

  it("collapses to the canvas ratio for animation containers even with a persisted selection", async () => {
    const recording = fakeRecording("rec-1")
    const project = fakeProject("rec-1")
    project.exportSettings.container = "gif"
    project.exportSettings.codec = "gif"
    project.exportSettings.formats = ["16:9", "9:16"]
    const timeline = createTimelineFromRecording(
      recording,
      fakeMetadata(recording),
      project.name,
      project.id,
    )

    useTimelineStore.setState({
      project,
      recording,
      engine: createEngine(timeline),
      missingAssets: [],
      activeExportJob: null,
      cursorTelemetry: null,
      cursorEngine: null,
      error: null,
      savePromise: null,
    })

    await useTimelineStore.getState().export("D:/out/demo.gif")

    expect(mocks.exportTimeline).toHaveBeenCalledTimes(1)
    expect(mocks.exportTimeline.mock.calls[0][0].outputPath).toBe("D:/out/demo.gif")
    expect(mocks.exportTimeline.mock.calls[0][0].plan.canvas?.aspectRatio).toBe("16:9")
  })
})
