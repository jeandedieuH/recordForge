import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryRecording, recordForgeProject } from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/contracts"
import { useTimelineStore } from "./timeline-store"
import { useJobsStore } from "./jobs-store"
import { useEditorStore } from "./editor-store"

// Save-chain ownership: deferred saveProject IPC lets the test interleave
// edits, session switches and queued callers at the exact points the drain,
// generation guards and stale-close protections operate. The store calls
// window.clearTimeout on the real webview path — node has no `window`.
globalThis.window = globalThis as unknown as Window & typeof globalThis
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function settledFlag(promise: Promise<unknown>) {
  const flag = { settled: false }
  void promise.then(
    () => {
      flag.settled = true
    },
    () => {
      flag.settled = true
    },
  )
  return flag
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
      audioMastering: { denoise: false, noiseReductionDb: 12, loudnessTarget: null },
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
      keystrokeOverlay: {
        enabled: false,
        durationMs: 1400,
        position: "bottom-center",
        scalePercent: 100,
      },
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

const projectByRecording = new Map<string, recordForgeProject>([
  ["rec-1", fakeProject("rec-1")],
  ["rec-2", fakeProject("rec-2")],
])
const recordingById = new Map<string, LibraryRecording>([
  ["rec-1", fakeRecording("rec-1")],
  ["rec-2", fakeRecording("rec-2")],
])

describe("timeline-store save chain ownership", () => {
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
    mocks.snapshotProject.mockResolvedValue(undefined)
    mocks.getProjectAssetPaths.mockResolvedValue({})
    mocks.resolveAssetPath.mockReturnValue(null)

    useTimelineStore.getState().resetSession()
    useJobsStore.setState({ jobs: [], isListening: false, unlisten: null })
    useEditorStore.setState({ isDirty: false, saveStatus: "idle" })
  })

  it("drains a revision that lands mid-save before the caller resolves", async () => {
    await useTimelineStore.getState().load("rec-1")
    const baseProject = useTimelineStore.getState().project!

    // rev1 save in flight.
    const firstWrite = deferred<recordForgeProject>()
    mocks.saveProject.mockReturnValueOnce(firstWrite.promise)
    const savePromise = useTimelineStore.getState().save()
    const firstSettled = settledFlag(savePromise)
    await vi.waitFor(() => expect(mocks.saveProject).toHaveBeenCalledTimes(1))
    expect(mocks.saveProject.mock.calls[0][0]).toBe(baseProject)

    // An edit lands while rev1 is still writing — autosave marks it pending
    // on the in-flight promise instead of scheduling a parallel write.
    const editedProject = { ...baseProject, name: "Edited mid-save" }
    useTimelineStore.getState().markProjectChanged(editedProject)
    expect(useTimelineStore.getState().pendingSaveRevision).toBe(2)

    const secondWrite = deferred<recordForgeProject>()
    mocks.saveProject.mockReturnValueOnce(secondWrite.promise)

    firstWrite.resolve(baseProject)
    await vi.waitFor(() => expect(mocks.saveProject).toHaveBeenCalledTimes(2))
    // The chained write persists the NEWER revision, and the original caller
    // is still pending — it must not resolve while an edited revision is
    // unsaved.
    expect(mocks.saveProject.mock.calls[1][0]).toBe(editedProject)
    expect(firstSettled.settled).toBe(false)

    secondWrite.resolve(editedProject)
    await savePromise
    expect(useEditorStore.getState().saveStatus).toBe("saved")
    expect(useEditorStore.getState().isDirty).toBe(false)
    expect(useTimelineStore.getState().savePromise).toBeNull()
  })

  it("a same-session save error keeps dirty state and schedules the retry", async () => {
    await useTimelineStore.getState().load("rec-1")
    const baseProject = useTimelineStore.getState().project!
    const failingWrite = deferred<recordForgeProject>()
    mocks.saveProject.mockReturnValueOnce(failingWrite.promise)

    const savePromise = useTimelineStore.getState().save()
    await vi.waitFor(() => expect(mocks.saveProject).toHaveBeenCalledTimes(1))

    // An edit lands while the (doomed) write is in flight — its pending
    // revision is what the error path must preserve and retry.
    const editedProject = { ...baseProject, name: "edit during failing save" }
    useTimelineStore.getState().markProjectChanged(editedProject)

    failingWrite.reject(new Error("disk full"))
    await savePromise

    // Dirty and the newer revision survive the failed write; the scheduled
    // autosave retry resets the status back to idle.
    expect(useEditorStore.getState().isDirty).toBe(true)
    expect(useTimelineStore.getState().project).toBe(editedProject)
    expect(useTimelineStore.getState().savePromise).toBeNull()
    // The retry is scheduled — pending work is not silently dropped.
    expect(useTimelineStore.getState().autosaveTimeout).not.toBeNull()
  })

  it("a queued save caller from an old session never starts a save on the new one", async () => {
    await useTimelineStore.getState().load("rec-1")
    const firstWrite = deferred<recordForgeProject>()
    mocks.saveProject.mockReturnValueOnce(firstWrite.promise)
    void useTimelineStore.getState().save()
    await vi.waitFor(() => expect(mocks.saveProject).toHaveBeenCalledTimes(1))

    // A second caller queues behind the in-flight save on session A.
    const queued = useTimelineStore.getState().save()

    // Session B loads; its generation resets the promise slot.
    await useTimelineStore.getState().load("rec-2")

    firstWrite.resolve(projectByRecording.get("rec-1")!)
    await queued

    // The queued caller belonged to session A — it must not save B's project.
    expect(mocks.saveProject).toHaveBeenCalledTimes(1)
    expect(useTimelineStore.getState().recording?.id).toBe("rec-2")
    // No save is in flight for B — the stale wait resolved without arming one.
    expect(useTimelineStore.getState().savePromise).toBeNull()
  })

  it("a stale closeSession neither resets nor blesses the new session", async () => {
    await useTimelineStore.getState().load("rec-1")
    const project = useTimelineStore.getState().project!
    useTimelineStore.getState().markProjectChanged({ ...project, name: "dirty edit" })

    const write = deferred<recordForgeProject>()
    mocks.saveProject.mockReturnValueOnce(write.promise)
    const closeResult = useTimelineStore.getState().closeSession()
    await vi.waitFor(() => expect(mocks.saveProject).toHaveBeenCalledTimes(1))

    // A new project loads while the flush is still pending.
    await useTimelineStore.getState().load("rec-2")

    write.resolve(projectByRecording.get("rec-1")!)
    expect(await closeResult).toBe(false)
    expect(useTimelineStore.getState().recording?.id).toBe("rec-2")
    expect(useTimelineStore.getState().project?.id).toBe("proj-rec-2")
  })

  it("closeSession waits out a dirty save before resetting", async () => {
    await useTimelineStore.getState().load("rec-1")
    const project = useTimelineStore.getState().project!
    useTimelineStore.getState().markProjectChanged({ ...project, name: "dirty edit" })

    const write = deferred<recordForgeProject>()
    mocks.saveProject.mockReturnValueOnce(write.promise)
    const closeResult = useTimelineStore.getState().closeSession()
    const closeSettled = settledFlag(closeResult)
    await vi.waitFor(() => expect(mocks.saveProject).toHaveBeenCalledTimes(1))
    expect(closeSettled.settled).toBe(false)

    write.resolve(projectByRecording.get("rec-1")!)
    expect(await closeResult).toBe(true)
    expect(useTimelineStore.getState().project).toBeNull()
  })
})
