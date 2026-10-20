import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryRecording, MediaJob, recordForgeProject } from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/contracts"
import { useTimelineStore } from "./timeline-store"
import { useJobsStore } from "./jobs-store"

// Processed-preview + batch-export ownership: deferred IPC lets the test
// interleave session switches, edits, and injected job events at the exact
// seams the races occur.
const mocks = vi.hoisted(() => ({
  listMediaJobs: vi.fn(),
  getMediaMetadata: vi.fn(),
  getMediaJob: vi.fn(),
  prepareRecordingMedia: vi.fn(),
  onMediaJobUpdate: vi.fn(),
  cancelMediaJob: vi.fn(),
  requestPreviewProxy: vi.fn(),
  getKeystrokeEvents: vi.fn(),
  getCursorTelemetry: vi.fn(),
  getSetting: vi.fn(),
  isTauri: vi.fn(),
  getRecordingSmartZoom: vi.fn(),
  listRecordings: vi.fn(),
  loadProject: vi.fn(),
  createProject: vi.fn(),
  saveProject: vi.fn(),
  snapshotProject: vi.fn(),
  getProjectAssetPaths: vi.fn(),
  relinkAsset: vi.fn(),
  resolveAssetPath: vi.fn(),
  exportTimeline: vi.fn(),
  previewTimeline: vi.fn(),
  retryExport: vi.fn(),
  revealExport: vi.fn(),
  notifyExportFinished: vi.fn(),
}))

vi.mock("../lib/media", () => ({
  getMediaMetadata: mocks.getMediaMetadata,
  listMediaJobs: mocks.listMediaJobs,
  getMediaJob: mocks.getMediaJob,
  prepareRecordingMedia: mocks.prepareRecordingMedia,
  onMediaJobUpdate: mocks.onMediaJobUpdate,
  cancelMediaJob: mocks.cancelMediaJob,
  requestPreviewProxy: mocks.requestPreviewProxy,
  getKeystrokeEvents: mocks.getKeystrokeEvents,
}))
vi.mock("../lib/cursor", () => ({ getCursorTelemetry: mocks.getCursorTelemetry }))
vi.mock("../lib/settings", () => ({
  getSetting: mocks.getSetting,
  isTauri: mocks.isTauri,
}))
vi.mock("../lib/recorder", () => ({ getRecordingSmartZoom: mocks.getRecordingSmartZoom }))
vi.mock("../lib/library", () => ({ listRecordings: mocks.listRecordings }))
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
  previewTimeline: mocks.previewTimeline,
  retryExport: mocks.retryExport,
  revealExport: mocks.revealExport,
}))
vi.mock("../lib/export-notifications", () => ({
  notifyExportFinished: mocks.notifyExportFinished,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
    assets: [
      // A real screen asset + clip — buildRenderPlan errors without screen
      // media, which would make every batch test pass vacuously.
      {
        id: "asset-screen",
        role: "screen",
        path: `videos/${recordingId}.mp4`,
        width: 1920,
        height: 1080,
        status: "available",
        derivativeVersion: 7,
        durationMs: 60_000,
        hasAudio: true,
      },
    ],
    tracks: [
      {
        id: "screen",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "clip-screen",
            kind: "screen",
            assetId: "asset-screen",
            startMs: 0,
            durationMs: 60_000,
            sourceInMs: 0,
            sourceOutMs: 60_000,
            speed: 1,
          },
        ],
      },
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
      keystrokeOverlay: {
        enabled: false,
        durationMs: 1400,
        position: "bottom-center",
        scalePercent: 100,
      },
      reframeMode: "fit",
      formats: [],
      instantShare: { enabled: false, target: "hosted", expiresInDays: 30 },
    },
  } as recordForgeProject
}

function fakeJob(id: string, overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id,
    recordingId: "rec-1",
    kind: "export",
    status: "pending",
    progress: 0,
    stage: "pending",
    message: null,
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    completedAt: null,
    outputs: {
      prepareVersion: 0,
      derivatives: {},
      audioTracks: [],
      videoTracks: [],
    },
    preview: false,
    options: {},
    attempts: 0,
    ...overrides,
  } as MediaJob
}

const projectByRecording = new Map<string, recordForgeProject>([
  ["rec-1", fakeProject("rec-1")],
  ["rec-2", fakeProject("rec-2")],
])
const recordingById = new Map<string, LibraryRecording>([
  ["rec-1", fakeRecording("rec-1")],
  ["rec-2", fakeRecording("rec-2")],
])

async function loadSession(recordingId: string) {
  await useTimelineStore.getState().load(recordingId)
}

describe("timeline-store preview + batch races", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listRecordings.mockImplementation(() => Promise.resolve([...recordingById.values()]))
    mocks.getMediaMetadata.mockResolvedValue(null)
    mocks.listMediaJobs.mockResolvedValue([])
    mocks.getMediaJob.mockResolvedValue(null)
    mocks.prepareRecordingMedia.mockResolvedValue({
      id: "prepare-1",
      kind: "prepare",
      status: "completed",
      outputs: { prepareVersion: 7, audioTracks: [], videoTracks: [] },
    })
    mocks.onMediaJobUpdate.mockResolvedValue(() => {})
    mocks.getKeystrokeEvents.mockResolvedValue({ events: [], supported: true })
    mocks.getCursorTelemetry.mockResolvedValue(null)
    mocks.getSetting.mockResolvedValue(null)
    mocks.isTauri.mockReturnValue(true)
    mocks.getRecordingSmartZoom.mockResolvedValue(null)
    mocks.loadProject.mockImplementation((recordingId: string) =>
      Promise.resolve({ project: projectByRecording.get(recordingId), missingAssets: [] }),
    )
    mocks.saveProject.mockImplementation((project: recordForgeProject) => Promise.resolve(project))
    mocks.getProjectAssetPaths.mockResolvedValue({})
    mocks.resolveAssetPath.mockReturnValue(null)

    useTimelineStore.setState({
      cursorTelemetry: null,
      cursorEngine: null,
      isListening: false,
      unlisten: null,
      autosaveTimeout: null,
    })
    useJobsStore.setState({ jobs: [], isListening: false, unlisten: null })
  })

  it("double request only submits one native preview job", async () => {
    await loadSession("rec-1")
    const pending = deferred<MediaJob>()
    mocks.previewTimeline.mockReturnValue(pending.promise)

    const first = useTimelineStore.getState().requestProcessedPreview()
    const second = useTimelineStore.getState().requestProcessedPreview()
    await second

    // The admission runs save→plan→IPC asynchronously; wait for it to land.
    await vi.waitFor(() => expect(mocks.previewTimeline).toHaveBeenCalledTimes(1))
    pending.resolve(fakeJob("pv-1", { preview: true }))
    await first
    expect(useTimelineStore.getState().processedPreviewJob?.id).toBe("pv-1")
    expect(useTimelineStore.getState().isPreviewSubmitting).toBe(false)
  })

  it("missing assets and save failure are submission errors, not silent no-ops", async () => {
    await loadSession("rec-1")
    useTimelineStore.setState({ missingAssets: [{ assetId: "a", path: "x" } as never] })
    await useTimelineStore.getState().requestProcessedPreview()
    expect(mocks.previewTimeline).not.toHaveBeenCalled()
    expect(useTimelineStore.getState().previewSubmissionError).toContain("missing")
    useTimelineStore.setState({ missingAssets: [], previewSubmissionError: null })

    mocks.saveProject.mockRejectedValueOnce(new Error("disk full"))
    await useTimelineStore.getState().requestProcessedPreview()
    expect(mocks.previewTimeline).not.toHaveBeenCalled()
    expect(useTimelineStore.getState().previewSubmissionError).toBeTruthy()
  })

  it("preview admission during a session switch cancels the job instead of stamping it", async () => {
    await loadSession("rec-1")
    const pending = deferred<MediaJob>()
    mocks.previewTimeline.mockReturnValue(pending.promise)
    const request = useTimelineStore.getState().requestProcessedPreview()

    // Wait until the native admission RPC is actually in flight.
    await vi.waitFor(() => expect(mocks.previewTimeline).toHaveBeenCalledTimes(1))
    // Switch to another recording while admission is deferred.
    await loadSession("rec-2")
    pending.resolve(fakeJob("pv-1", { preview: true }))
    await request

    expect(mocks.cancelMediaJob).toHaveBeenCalledWith("pv-1")
    expect(useTimelineStore.getState().processedPreviewJob).toBeNull()
  })

  it("cancel during deferred admission cancels the eventually admitted job", async () => {
    await loadSession("rec-1")
    const pending = deferred<MediaJob>()
    mocks.previewTimeline.mockReturnValue(pending.promise)
    const request = useTimelineStore.getState().requestProcessedPreview()

    await vi.waitFor(() => expect(mocks.previewTimeline).toHaveBeenCalledTimes(1))
    await useTimelineStore.getState().cancelProcessedPreview()
    pending.resolve(fakeJob("pv-1", { preview: true }))
    await request
    await Promise.resolve()

    expect(mocks.cancelMediaJob).toHaveBeenCalledWith("pv-1")
  })

  it("a completed event received before admission is not regressed to pending", async () => {
    await loadSession("rec-1")
    const pending = deferred<MediaJob>()
    mocks.previewTimeline.mockReturnValue(pending.promise)
    const request = useTimelineStore.getState().requestProcessedPreview()

    await vi.waitFor(() => expect(mocks.previewTimeline).toHaveBeenCalledTimes(1))
    // Native emits a completed event while the admission RPC is still out.
    const completed = fakeJob("pv-1", {
      preview: true,
      status: "completed",
      outputs: {
        prepareVersion: 0,
        derivatives: {},
        audioTracks: [],
        videoTracks: [],
        outputPath: "generated-preview/pv-1.mp4",
      } as MediaJob["outputs"],
    })
    useJobsStore.getState().upsertJob(completed)
    pending.resolve(fakeJob("pv-1", { preview: true }))
    await request

    const owned = useTimelineStore.getState().processedPreviewJob
    expect(owned?.status).toBe("completed")
    expect(owned?.outputs.outputPath).toBe("generated-preview/pv-1.mp4")
  })

  it("an older preview job's events can't replace a newer owned build", async () => {
    await loadSession("rec-1")
    useTimelineStore.setState({
      processedPreviewJob: fakeJob("pv-2", { preview: true, status: "running" }),
    })
    await useTimelineStore.getState().startListening()

    const emit = mocks.onMediaJobUpdate.mock.calls[0]?.[0] as ((job: MediaJob) => void) | undefined
    emit?.(fakeJob("pv-1", { preview: true, status: "completed" }))
    // Owned job follows ITS events; a different preview id is ignored.
    expect(useTimelineStore.getState().processedPreviewJob?.id).toBe("pv-2")
    emit?.(fakeJob("pv-2", { preview: true, status: "completed" }))
    expect(useTimelineStore.getState().processedPreviewJob?.status).toBe("completed")
    useTimelineStore.getState().stopListening()
  })

  it("preview events never touch activeExportJob or notify", async () => {
    await loadSession("rec-1")
    const primary = fakeJob("ex-1", { status: "running" })
    useTimelineStore.setState({ activeExportJob: primary })
    await useTimelineStore.getState().startListening()
    const emit = mocks.onMediaJobUpdate.mock.calls[0]?.[0] as ((job: MediaJob) => void) | undefined

    emit?.(fakeJob("pv-1", { preview: true, status: "running" }))
    expect(useTimelineStore.getState().activeExportJob?.id).toBe("ex-1")
    // An alternate export's events can't replace the pinned primary either.
    emit?.(fakeJob("ex-2", { status: "completed" }))
    expect(useTimelineStore.getState().activeExportJob?.id).toBe("ex-1")
    expect(mocks.notifyExportFinished).not.toHaveBeenCalled()
    useTimelineStore.getState().stopListening()
  })

  it("batch export preflights all variants before the first IPC", async () => {
    await loadSession("rec-1")
    mocks.exportTimeline.mockImplementation((input: { outputPath: string }) =>
      Promise.resolve(fakeJob(`job-${input.outputPath}`)),
    )

    // An unbuildable variant (selected-range preset with no range) must
    // abort the whole batch with zero IPC calls — preflight is all-at-once.
    useTimelineStore.setState((state) => ({
      project: state.project && {
        ...state.project,
        exportSettings: { ...state.project.exportSettings, preset: "selected-range" },
      },
    }))
    await useTimelineStore.getState().export("/out/demo.mp4", { formats: ["16:9", "9:16"] })
    expect(mocks.exportTimeline).not.toHaveBeenCalled()
    expect(useTimelineStore.getState().error).toBeTruthy()

    // Restore a buildable preset for the clean batch below.
    useTimelineStore.setState((state) => ({
      project: state.project && {
        ...state.project,
        exportSettings: { ...state.project.exportSettings, preset: "balanced" },
      },
    }))

    // A clean batch admits primary first, then alternates with suffixes.
    mocks.exportTimeline.mockClear()
    await useTimelineStore.getState().export("/out/demo.mp4", { formats: ["16:9", "9:16", "1:1"] })
    expect(mocks.exportTimeline).toHaveBeenCalledTimes(3)
    const paths = mocks.exportTimeline.mock.calls.map((call) => call[0].outputPath)
    expect(paths[0]).toBe("/out/demo.mp4")
    expect(paths[1]).toContain("vertical")
    expect(useTimelineStore.getState().activeExportJob?.id).toBe("job-/out/demo.mp4")
  })

  it("an aspect-locked preset falls back to balanced on incompatible alternates", async () => {
    await loadSession("rec-1")
    useTimelineStore.setState((state) => ({
      project: state.project && {
        ...state.project,
        exportSettings: { ...state.project.exportSettings, preset: "vertical" },
      },
    }))
    mocks.exportTimeline.mockImplementation((input: { outputPath: string }) =>
      Promise.resolve(fakeJob(`job-${input.outputPath}`)),
    )
    // Current canvas is 16:9 — but preset "vertical" with a 9:16 ALTERNATE
    // keeps its lock; other alternates normalize to balanced.
    const timeline = useTimelineStore.getState().engine!.history.present
    useTimelineStore.setState((state) => ({
      engine: state.engine && {
        ...state.engine,
        history: {
          ...state.engine.history,
          present: {
            ...timeline,
            canvas: { ...timeline.canvas, aspectRatio: "9:16" },
          },
        },
      },
    }))
    await useTimelineStore.getState().export("/out/demo.mp4", { formats: ["9:16", "16:9"] })
    const settingsCalls = mocks.exportTimeline.mock.calls.map((call) => call[0].settings.preset)
    expect(settingsCalls).toEqual(["vertical", "balanced"])
  })

  it("session change mid-batch stops later admissions; admitted jobs stay", async () => {
    await loadSession("rec-1")
    const admission = deferred<MediaJob>()
    let calls = 0
    mocks.exportTimeline.mockImplementation(() => {
      calls += 1
      return calls === 1 ? admission.promise : Promise.resolve(fakeJob(`job-${calls}`))
    })

    const request = useTimelineStore
      .getState()
      .export("/out/demo.mp4", { formats: ["16:9", "9:16"] })

    await vi.waitFor(() => expect(mocks.exportTimeline).toHaveBeenCalledTimes(1))
    admission.resolve(fakeJob("primary"))
    // Switch sessions BEFORE the resolved admission continues: load() bumps
    // the session generation synchronously, so the loop's next check sees it.
    const switching = loadSession("rec-2")
    await request
    await switching

    expect(mocks.exportTimeline).toHaveBeenCalledTimes(1)
    // The late batch must not write an error onto the new session.
    expect(useTimelineStore.getState().error).toBeNull()
  })

  it("live edit between admissions does not mix revisions", async () => {
    await loadSession("rec-1")
    const admission = deferred<MediaJob>()
    let calls = 0
    mocks.exportTimeline.mockImplementation(() => {
      calls += 1
      return calls === 1 ? admission.promise : Promise.resolve(fakeJob(`job-${calls}`))
    })
    const request = useTimelineStore
      .getState()
      .export("/out/demo.mp4", { formats: ["16:9", "9:16"] })

    await vi.waitFor(() => expect(mocks.exportTimeline).toHaveBeenCalledTimes(1))
    admission.resolve(fakeJob("primary"))
    await Promise.resolve()
    // Simulate a live edit: swap the committed present between admissions.
    const timeline = useTimelineStore.getState().engine!.history.present
    useTimelineStore.setState((state) => ({
      engine: state.engine && {
        ...state.engine,
        history: {
          ...state.engine.history,
          present: { ...timeline, tracks: [] },
        },
      },
      projectRevision: state.projectRevision + 1,
    }))
    await request

    expect(mocks.exportTimeline).toHaveBeenCalledTimes(2)
    const [first, second] = mocks.exportTimeline.mock.calls.map((call) => call[0].plan)
    // Both plans were built from the same frozen snapshot.
    expect(second.canvas?.aspectRatio).toBe("9:16")
    expect(first.segments.length).toBe(second.segments.length)
  })

  it("new-project load auto-enables badge replay even when capture is unsupported", async () => {
    // A camera-free platform (e.g. Linux import) can't CAPTURE, but saved
    // events still preview/export — `supported` must not gate replay.
    mocks.loadProject.mockResolvedValueOnce(null)
    mocks.createProject.mockImplementationOnce((project: recordForgeProject) =>
      Promise.resolve(project),
    )
    mocks.getKeystrokeEvents.mockResolvedValueOnce({
      events: [{ tMs: 500, label: "Ctrl+C" }],
      supported: false,
    })
    await loadSession("rec-1")
    await vi.waitFor(() => expect(useTimelineStore.getState().keystrokeEventsStatus).toBe("loaded"))
    await vi.waitFor(() =>
      expect(useTimelineStore.getState().project?.exportSettings.keystrokeOverlay.enabled).toBe(
        true,
      ),
    )
  })

  it("an explicit badge toggle during event load blocks the auto-enable", async () => {
    mocks.loadProject.mockResolvedValueOnce(null)
    mocks.createProject.mockImplementationOnce((project: recordForgeProject) =>
      Promise.resolve(project),
    )
    const gate = deferred<{ events: { tMs: number; label: string }[]; supported: boolean }>()
    mocks.getKeystrokeEvents.mockReturnValueOnce(gate.promise)
    await loadSession("rec-1")

    // The events IPC is still out — the user flips badges on then back off.
    useTimelineStore.getState().setKeystrokeOverlay(true)
    useTimelineStore.getState().setKeystrokeOverlay(false)

    gate.resolve({ events: [{ tMs: 500, label: "Ctrl+C" }], supported: true })
    await vi.waitFor(() => expect(useTimelineStore.getState().keystrokeEventsStatus).toBe("loaded"))
    await Promise.resolve()
    await Promise.resolve()
    expect(useTimelineStore.getState().project?.exportSettings.keystrokeOverlay.enabled).toBe(false)
  })
})
