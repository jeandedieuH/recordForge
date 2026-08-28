import { create } from "zustand"
import {
  cursorSettingsSchema,
  defaultSmartZoomSettings,
  recordingPreferencesSchema,
  type ExportEncoderPreference,
  type ExportPreset,
  type ExportRange,
  type LibraryRecording,
  type MediaJob,
  type CursorTelemetryFile,
  type MediaMetadata,
  type recordForgeProject,
  type TimelineViewState,
} from "@recordforge/contracts"
import {
  createEngine,
  createProjectFromRecording,
  executeCommand,
  findClip,
  findMarker,
  getTotalDuration,
  initializeSmartZoom,
  projectToTimeline,
  redoCommand,
  timelineToProject,
  type AppError,
  type CommandEngine,
  type ExecuteOptions,
  type TimelineCommand,
  type TimelineSelection,
  type RenderCaptionMode,
  type RenderChapterMode,
  type TimelineState,
  undoCommand,
} from "@recordforge/editor-core"
import { buildRenderPlan } from "@recordforge/media-core"
import {
  getProjectAssetPaths,
  relinkAsset as relinkAssetRequest,
  resolveAssetPath,
} from "../lib/assets"
import { createProject, loadProject, saveProject, snapshotProject } from "../lib/project"
import { getCursorTelemetry } from "../lib/cursor"
import { getRecordingSmartZoom } from "../lib/recorder"
import {
  createCursorEngine,
  createWasmCursorEngine,
  type CursorEngine,
} from "@recordforge/cursor-core"
import { listRecordings } from "../lib/library"
import { toErrorMessage } from "../lib/errors"
import { getSetting, isTauri } from "../lib/settings"
import {
  cancelMediaJob,
  getMediaJob,
  getMediaMetadata,
  listMediaJobs,
  onMediaJobUpdate,
  prepareRecordingMedia,
} from "../lib/media"
import { exportTimeline, retryExport as retryExportRequest, revealExport } from "../lib/timeline"
import { useEditorStore } from "./editor-store"

interface TimelineStore {
  engine: CommandEngine | null
  view: TimelineViewState
  recording: LibraryRecording | null
  metadata: MediaMetadata | null
  project: recordForgeProject | null
  cursorTelemetry: CursorTelemetryFile | null
  cursorEngine: CursorEngine | null
  cursorTelemetryStatus: "loading" | "available" | "unavailable"
  activeJob: MediaJob | null
  isLoading: boolean
  error: string | null
  activeExportJob: MediaJob | null
  missingAssets: string[]
  // Resolved absolute paths are kept outside the durable project schema so
  // React can use Tauri's asset protocol without rewriting project-relative paths.
  assetPaths: Record<string, string>
  // Phase 2: transient draft state shown while a pointer gesture is active.
  // Committed state remains in engine.history.present.
  draftTimeline: TimelineState | null
  draftError: AppError | null
  // True while the media-job-update listener is active; prevents duplicate
  // subscriptions and races between mount and unmount.
  isListening: boolean
  unlisten: (() => void) | null
  // Pending autosave timer; cleared when a save runs or the editor closes.
  autosaveTimeout: ReturnType<typeof setTimeout> | null
  // Phase 1: revision-aware save coordinator. projectRevision is a logical
  // counter that increments on every in-memory project mutation. savingRevision
  // is the revision currently being written. pendingSaveRevision is the latest
  // revision that still needs to be persisted. savePromise is the in-flight
  // save() call so concurrent flushers can wait instead of double-writing.
  projectRevision: number
  savingRevision: number | null
  pendingSaveRevision: number | null
  savePromise: Promise<void> | null
  // True when a destructive command has been committed and the next save must
  // first snapshot the on-disk project before overwriting it.
  snapshotPending: boolean

  load: (recordingId: string) => Promise<void>
  startListening: () => Promise<void>
  stopListening: () => void

  execute: (command: TimelineCommand, options?: ExecuteOptions) => boolean
  undo: () => void
  redo: () => void

  play: () => void
  pause: () => void
  togglePlay: () => void
  seek: (ms: number) => void
  setPlaybackRate: (rate: number) => void
  setZoom: (zoom: number) => void
  setScroll: (ms: number) => void
  setSnapEnabled: (enabled: boolean) => void
  setSnapThreshold: (thresholdMs: number) => void
  setPreviewQuality: (mode: "quality" | "performance" | "power") => void
  toggleTrackCollapsed: (trackId: string) => void
  setTrackHeight: (trackId: string, height: number) => void
  setActiveExportJob: (job: MediaJob | null) => void
  setCaptionMode: (mode: RenderCaptionMode) => void
  setChapterMode: (mode: RenderChapterMode) => void
  setExportContainer: (container: "mp4" | "gif" | "webp") => void
  setExportPreset: (preset: ExportPreset) => void
  setExportCodec: (codec: "h264" | "hevc" | "gif" | "webp") => void
  setExportEncoder: (encoder: ExportEncoderPreference) => void
  setExportRange: (range: ExportRange | undefined) => void
  cancelExport: () => Promise<void>
  retryExport: () => Promise<void>
  revealExport: () => Promise<void>
  setSelection: (selection: TimelineSelection | null) => void

  // Phase 2: set or clear the transient draft timeline and any validation error.
  setDraftTimeline: (draft: TimelineState | null, error?: AppError | null) => void
  clearDraft: () => void

  save: () => Promise<void>
  scheduleAutosave: () => void
  relinkAsset: (assetId: string, newPath: string) => Promise<void>
  refreshAssetPaths: () => Promise<void>
  syncProject: (project: recordForgeProject) => void

  // Phase 1: mark a new project revision, update dirty state, and schedule save.
  markProjectChanged: (
    nextProject: recordForgeProject,
    options?: { needsSnapshot?: boolean },
  ) => void
  // Phase 1: finish an in-flight save and reconcile the in-memory revision.
  commitSaveResult: (saved: recordForgeProject, sentRevision: number) => void
  // Phase 1: handle a failed save while preserving dirty/recovery state.
  handleSaveError: (err: unknown, sentRevision: number) => void
  // Phase 1: flush and tear down a session when the user leaves the editor.
  closeSession: () => Promise<boolean>
  // Phase 1: reset the session without saving (used by unmount cleanup).
  resetSession: () => void

  export: (outputPath: string) => Promise<void>
  clearError: () => void
  // Phase 2: surface a validation or commit error without mutating project state.
  setError: (message: string) => void
}

const AUTOSAVE_DELAY_MS = 2000
const SNAPSHOT_COMMANDS = new Set([
  "delete-clip",
  "delete-clips",
  "delete-marker",
  "delete-range",
  "ripple-delete-clip",
  "ripple-delete-clips",
  "ripple-delete-range",
  "delete-track",
  "delete-cursor-range",
  "delete-zoom-segment",
  "regenerate-zoom-suggestions",
  "trim-clip",
  "import-caption-cues",
  "add-mask-clip",
])

function fallbackMetadata(recording: LibraryRecording): MediaMetadata {
  return {
    recordingId: recording.id,
    path: recording.outputPath ?? "",
    durationMs: recording.durationMs,
    width: recording.width,
    height: recording.height,
    fps: recording.fps,
    hasAudio: true,
    streams: [],
    updatedAt: new Date().toISOString(),
  }
}

function isDestructiveCommand(command: TimelineCommand): boolean {
  return SNAPSHOT_COMMANDS.has(command.kind)
}

// Phase 2: after a command mutates the timeline, drop the selection if its
// primary object no longer exists so the UI never holds a ghost selection.
function reconcileSelection(
  selection: TimelineSelection | null,
  timeline: TimelineState,
): TimelineSelection | null {
  if (!selection) return null
  if (selection.kind === "clip") {
    const found = findClip(timeline, selection.primaryClipId)
    if (!found) return null
    const validIds = selection.clipIds.filter((id) => findClip(timeline, id))
    if (validIds.length === 0) return { ...selection, clipIds: [selection.primaryClipId] }
    return { ...selection, clipIds: validIds }
  }
  if (selection.kind === "marker") {
    return findMarker(timeline, selection.markerId) ? selection : null
  }
  if (selection.kind === "zoom") {
    return timeline.zoomSegments?.find((s) => s.id === selection.segmentId) ? selection : null
  }
  // Range selections are intentional and do not require reconciliation.
  return selection
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void
  let reject: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve: resolve!, reject: reject! }
}

function isReusablePrepareJob(job: MediaJob): boolean {
  if (job.kind !== "prepare" || job.status !== "completed") return false
  if (job.outputs.prepareVersion < 4 || !job.outputs.proxyPath) return false
  return job.outputs.audioTracks.every((track) =>
    Boolean(track.audioPath && track.waveformPath && track.waveformImagePath),
  )
}

function selectPreparationJob(jobs: MediaJob[]): MediaJob | null {
  const prepareJobs = jobs.filter((job) => job.kind === "prepare")
  return (
    prepareJobs.find((job) => job.status === "pending" || job.status === "running") ??
    prepareJobs.find(isReusablePrepareJob) ??
    prepareJobs[0] ??
    null
  )
}

export const useTimelineStore = create<TimelineStore>((set, get) => ({
  engine: null,
  view: {
    zoom: 0,
    scrollMs: 0,
    playheadMs: 0,
    isPlaying: false,
    playbackRate: 1,
    previewQuality: "quality",
    durationMs: 0,
    selection: null,
    snapEnabled: true,
    snapThresholdMs: 120,
    collapsedTrackIds: [],
    trackHeights: {},
  },
  recording: null,
  metadata: null,
  project: null,
  cursorTelemetry: null,
  cursorEngine: null,
  cursorTelemetryStatus: "unavailable",
  activeJob: null,
  isLoading: false,
  error: null,
  activeExportJob: null,
  missingAssets: [],
  assetPaths: {},
  draftTimeline: null,
  draftError: null,
  isListening: false,
  unlisten: null,
  autosaveTimeout: null,
  projectRevision: 0,
  savingRevision: null,
  pendingSaveRevision: null,
  savePromise: null,
  snapshotPending: false,

  load: async (recordingId) => {
    set({
      isLoading: true,
      error: null,
      engine: null,
      recording: null,
      metadata: null,
      project: null,
      cursorTelemetry: null,
      cursorEngine: null,
      cursorTelemetryStatus: "loading",
      activeJob: null,
      activeExportJob: null,
      missingAssets: [],
      assetPaths: {},
      draftTimeline: null,
      draftError: null,
      projectRevision: 0,
      savingRevision: null,
      pendingSaveRevision: null,
      savePromise: null,
      snapshotPending: false,
      autosaveTimeout: null,
    })
    try {
      const recordings = await listRecordings()
      const recording = recordings.find((r) => r.id === recordingId)
      if (!recording) {
        throw new Error(`Recording ${recordingId} not found`)
      }

      const [
        metadata,
        jobs,
        initialCursorTelemetry,
        defaultCursorRaw,
        recordingSmartZoom,
        recordingPreferencesRaw,
      ] = await Promise.all([
        getMediaMetadata(recordingId),
        listMediaJobs(recordingId),
        isTauri() ? getCursorTelemetry(recordingId).catch(() => null) : Promise.resolve(null),
        isTauri() ? getSetting("defaultCursorSettings").catch(() => null) : Promise.resolve(null),
        isTauri() ? getRecordingSmartZoom(recordingId).catch(() => null) : Promise.resolve(null),
        getSetting("recordingPreferences").catch(() => null),
      ])

      const meta = metadata ?? fallbackMetadata(recording)
      const selectedPreparationJob = selectPreparationJob(jobs)
      let activeJob = selectedPreparationJob ? await getMediaJob(selectedPreparationJob.id) : null
      const hasUsableProxy = Boolean(activeJob?.outputs.proxyPath)
      const hasUsableAudioDerivatives =
        !meta.hasAudio ||
        Boolean(
          activeJob &&
          activeJob.outputs.prepareVersion >= 2 &&
          activeJob.outputs.audioTracks.length > 0,
        )
      // Prepare v4 understands standalone webcam assets and retains the
      // legacy secondary-video extraction path for older recordings.
      const hasUsableVideoDerivatives = Boolean(
        activeJob &&
        activeJob.outputs.prepareVersion >= 4 &&
        (!recording.webcamPath || activeJob.outputs.videoTracks.length > 0),
      )
      if (
        !activeJob ||
        (activeJob.status === "completed" &&
          (!hasUsableProxy || !hasUsableAudioDerivatives || !hasUsableVideoDerivatives))
      ) {
        // Older prepare jobs only generated one combined waveform and did not
        // expose independent audio assets to the editor.
        activeJob = await prepareRecordingMedia(recordingId, true)
      }

      // Phase 1: load an existing durable project or create one from the recording.
      const loaded = await loadProject(recordingId)

      let project: recordForgeProject
      let missingAssets: string[] = []
      let didMigrateCursorTrack = false
      const storedPreferences = recordingPreferencesRaw
        ? (() => {
            try {
              const parsed = recordingPreferencesSchema.safeParse(
                JSON.parse(recordingPreferencesRaw),
              )
              return parsed.success ? parsed.data : null
            } catch {
              return null
            }
          })()
        : null
      const capturedSmartZoom =
        recordingSmartZoom ??
        (storedPreferences
          ? {
              enabled: storedPreferences.smartZoomEnabled,
              preset: storedPreferences.smartZoomPreset,
            }
          : {
              enabled: false,
              preset: defaultSmartZoomSettings.preset,
            })

      if (loaded) {
        project = loaded.project
        missingAssets = loaded.missingAssets
      } else {
        project = createProjectFromRecording(recording, meta, recording.name)
        if (defaultCursorRaw) {
          try {
            const parsed = cursorSettingsSchema.safeParse(JSON.parse(defaultCursorRaw))
            if (parsed.success) {
              project.canvas.cursorSettings = parsed.data
            }
          } catch {
            // Keep defaults if parse fails
          }
        }
        const initializedTimeline = initializeSmartZoom(
          projectToTimeline(project),
          initialCursorTelemetry,
          capturedSmartZoom,
        )
        project = timelineToProject(initializedTimeline, project)
        project = await createProject(project)
      }

      let assetPaths: Record<string, string> = {}
      if (isTauri()) {
        assetPaths = await getProjectAssetPaths(recordingId).catch(() => ({}))
      }
      if (recording?.workDir) {
        for (const asset of project.assets) {
          if (!assetPaths[asset.id]) {
            const resolved = resolveAssetPath(asset.path, recording.workDir)
            if (resolved) assetPaths[asset.id] = resolved
          }
        }
      }

      const timeline = projectToTimeline(project)
      // Persist the cursor track migration in the next autosave instead of
      // keeping it only as a runtime fallback for legacy project files.
      if (timeline.tracks.length !== project.tracks.length) {
        project = timelineToProject(timeline, project)
        didMigrateCursorTrack = true
      }
      const engine = createEngine(timeline)
      const duration = getTotalDuration(timeline)
      const cursorEngine = initialCursorTelemetry
        ? createCursorEngine(initialCursorTelemetry)
        : null

      // Keep the editor store in sync for UI surfaces (save status, missing assets).
      useEditorStore.getState().open(recordingId, project)
      useEditorStore.getState().setMissingAssets(missingAssets)

      set({
        engine,
        recording,
        metadata: meta,
        project,
        cursorTelemetry: initialCursorTelemetry,
        cursorEngine,
        cursorTelemetryStatus: initialCursorTelemetry ? "available" : "unavailable",
        activeJob,
        activeExportJob: null,
        missingAssets,
        assetPaths,
        view: {
          zoom: 50,
          scrollMs: 0,
          playheadMs: 0,
          isPlaying: false,
          playbackRate: 1,
          previewQuality: "quality",
          durationMs: duration,
          selection: null,
          snapEnabled: true,
          snapThresholdMs: 120,
          collapsedTrackIds: [],
          trackHeights: {},
        },
        isLoading: false,
        error: null,
        projectRevision: 0,
        savingRevision: null,
        pendingSaveRevision: null,
        savePromise: null,
        snapshotPending: false,
      })
      if (didMigrateCursorTrack) {
        // A migration changed the durable project shape; bump to revision 1 and
        // schedule an autosave so the upgraded shape is not lost on close.
        get().markProjectChanged(project)
      }

      // Try to upgrade to the canonical Rust + WASM cursor engine for the preview.
      // The TypeScript engine remains in use until the WASM module loads.
      if (initialCursorTelemetry) {
        createWasmCursorEngine(initialCursorTelemetry)
          .then((wasmEngine) => {
            set({ cursorEngine: wasmEngine })
          })
          .catch((err) => {
            console.warn("Failed to load WASM cursor engine, using TypeScript fallback:", err)
          })
      }
    } catch (err) {
      set({ error: toErrorMessage(err), isLoading: false })
    }
  },

  startListening: async () => {
    if (get().isListening) return
    set({ isListening: true })

    const unlisten = await onMediaJobUpdate((job) => {
      const recording = get().recording
      if (job.recordingId !== recording?.id) return

      const updates: Partial<TimelineStore> = {}

      // Track export jobs for the editor's export progress UI.
      if (job.kind === "export") {
        updates.activeExportJob = job
      }

      // Track the active proxy/prepare job. We follow a prepare job when it is
      // already the tracked one (so status/progress updates flow), when there is
      // no active job yet (so the user sees progress), or when it has produced a
      // proxy (so the video player can load it).
      if (job.kind === "prepare") {
        const currentJob = get().activeJob
        const isCurrent = currentJob?.id === job.id
        const hasProxy = Boolean(job.outputs?.proxyPath)
        if (isCurrent || !currentJob || hasProxy) {
          updates.activeJob = job
        }
      }

      if (Object.keys(updates).length > 0) {
        set(updates)
      }
    })

    // If stopListening() ran while we were awaiting the listener, discard it
    // instead of leaking an orphaned subscription.
    if (get().isListening) {
      set({ unlisten })
    } else {
      unlisten()
    }
  },

  stopListening: () => {
    set({ isListening: false })
    const { unlisten } = get()
    if (unlisten) {
      unlisten()
    }
    set({ unlisten: null })
  },

  execute: (command, options) => {
    const { engine, project } = get()
    if (!engine || !project) return false

    const result = executeCommand(engine, command, options)
    if (!result.ok) {
      set({ error: result.error.message })
      return false
    }
    const nextTimeline = result.value.history.present
    const nextProject = timelineToProject(nextTimeline, project)
    const duration = getTotalDuration(nextTimeline)
    const view = get().view
    const nextSelection = reconcileSelection(view.selection, nextTimeline)
    set({
      engine: result.value,
      error: null,
      draftTimeline: null,
      draftError: null,
      view: {
        ...view,
        durationMs: duration,
        playheadMs: Math.min(view.playheadMs, duration),
        selection: nextSelection,
      },
    })
    // Phase 1: destructive commands require a snapshot of the on-disk project
    // before the next save overwrites it.
    get().markProjectChanged(nextProject, {
      needsSnapshot: isDestructiveCommand(command),
    })
    return true
  },

  undo: () => {
    const { engine, project } = get()
    if (!engine || !project) return
    const result = undoCommand(engine)
    if (!result.ok) {
      set({ error: result.error.message })
      return
    }
    const nextTimeline = result.value.history.present
    const nextProject = timelineToProject(nextTimeline, project)
    const duration = getTotalDuration(nextTimeline)
    const view = get().view
    const nextSelection = reconcileSelection(view.selection, nextTimeline)
    set({
      engine: result.value,
      view: {
        ...view,
        durationMs: duration,
        playheadMs: Math.min(view.playheadMs, duration),
        selection: nextSelection,
      },
      error: null,
      draftTimeline: null,
      draftError: null,
    })
    get().markProjectChanged(nextProject)
  },

  redo: () => {
    const { engine, project } = get()
    if (!engine || !project) return
    const result = redoCommand(engine)
    if (!result.ok) {
      set({ error: result.error.message })
      return
    }
    const nextTimeline = result.value.history.present
    const nextProject = timelineToProject(nextTimeline, project)
    const duration = getTotalDuration(nextTimeline)
    const view = get().view
    const nextSelection = reconcileSelection(view.selection, nextTimeline)
    set({
      engine: result.value,
      view: {
        ...view,
        durationMs: duration,
        playheadMs: Math.min(view.playheadMs, duration),
        selection: nextSelection,
      },
      error: null,
      draftTimeline: null,
      draftError: null,
    })
    get().markProjectChanged(nextProject)
  },

  scheduleAutosave: () => {
    const { autosaveTimeout, savePromise, projectRevision } = get()
    if (autosaveTimeout) {
      clearTimeout(autosaveTimeout)
    }

    // Phase 1: if a save is already in flight, do not start a second timeout.
    // Instead, mark the latest revision as pending so the active save can chain.
    if (savePromise) {
      set({ pendingSaveRevision: projectRevision, autosaveTimeout: null })
      return
    }

    useEditorStore.getState().setSaveStatus("idle")

    const timeout = setTimeout(() => {
      void get().save()
    }, AUTOSAVE_DELAY_MS)

    set({ autosaveTimeout: timeout, pendingSaveRevision: projectRevision })
  },

  save: () => {
    const state = get()
    if (!state.project) return Promise.resolve()

    // Phase 1: serialize saves. If another save is already in flight, mark the
    // latest revision and wait for the in-flight save before deciding whether
    // another one is needed.
    if (state.savePromise) {
      if (state.projectRevision > (state.savingRevision ?? -1)) {
        set({ pendingSaveRevision: state.projectRevision })
      }
      return state.savePromise.then(() => {
        if (get().pendingSaveRevision) {
          return get().save()
        }
        return undefined
      })
    }

    if (state.autosaveTimeout) {
      clearTimeout(state.autosaveTimeout)
    }

    // Phase 1: create and store the save promise before any awaited work. This
    // lets edits that race the save set a pending revision instead of starting
    // a second write, and lets close/export guards wait on this promise.
    const deferred = createDeferred<void>()
    set({ savePromise: deferred.promise })

    const run = async () => {
      const { project, projectRevision, snapshotPending, recording } = get()
      if (!project) return

      set({
        savingRevision: projectRevision,
        pendingSaveRevision: null,
        autosaveTimeout: null,
      })
      useEditorStore.getState().setSaveStatus("saving")
      try {
        // Phase 1: destructive commands get a snapshot before the new version
        // overwrites the project file, sequencing the backup with the commit.
        if (snapshotPending && recording) {
          try {
            await snapshotProject(recording.id)
          } catch {
            // A failed snapshot should not block saving the current edit, but
            // it should not clear the pending flag either.
          }
          set({ snapshotPending: false })
        }
        const saved = await saveProject(project)
        get().commitSaveResult(saved, projectRevision)
      } catch (err) {
        // The error is already recorded in the store. Resolve the promise so
        // callers can read saveStatus; autosave/timeout callers are not left with
        // an unhandled rejection.
        get().handleSaveError(err, projectRevision)
      } finally {
        set({ savePromise: null })
      }

      // Phase 1: if edits arrived during the save and the save did not error,
      // immediately start the next save so pending edits are not left behind.
      const { pendingSaveRevision } = get()
      const { saveStatus } = useEditorStore.getState()
      if (pendingSaveRevision && saveStatus !== "error") {
        return get().save()
      }
      // If the save errored but there are pending edits, schedule a retry so the
      // user is not left with unsaved changes.
      if (pendingSaveRevision && saveStatus === "error") {
        get().scheduleAutosave()
      }
      return undefined
    }

    void run().then(deferred.resolve, deferred.reject)
    return deferred.promise
  },

  relinkAsset: async (assetId, newPath) => {
    const { recording } = get()
    if (!recording) return
    try {
      await relinkAssetRequest({
        recordingId: recording.id,
        assetId,
        newPath,
      })
      if (newPath) {
        const nextAssetPaths = { ...get().assetPaths, [assetId]: newPath }
        set({ assetPaths: nextAssetPaths })
      }
      const loaded = await loadProject(recording.id)
      if (!loaded) throw new Error("Project could not be reloaded after relinking")
      get().syncProject(loaded.project)
      await get().refreshAssetPaths()
    } catch (err) {
      set({ error: toErrorMessage(err) })
    }
  },

  refreshAssetPaths: async () => {
    const recording = get().recording
    if (!recording || !isTauri()) return
    try {
      const assetPaths = await getProjectAssetPaths(recording.id)
      set({ assetPaths })
    } catch (err) {
      set({ error: toErrorMessage(err) })
    }
  },

  syncProject: (nextProject) => {
    const currentProject = get().project
    const recording = get().recording
    const mergedProject =
      currentProject?.id === nextProject.id
        ? {
            ...currentProject,
            assets: nextProject.assets,
            checksum: nextProject.checksum,
            updatedAt: nextProject.updatedAt,
          }
        : nextProject
    const missingAssets = mergedProject.assets
      .filter((asset) => asset.status === "missing")
      .map((asset) => asset.id)
    const wasDirty = useEditorStore.getState().isDirty

    let assetPaths = get().assetPaths
    if (recording?.workDir) {
      let updated = false
      const nextAssetPaths = { ...assetPaths }
      for (const asset of mergedProject.assets) {
        if (!nextAssetPaths[asset.id]) {
          const resolved = resolveAssetPath(asset.path, recording.workDir)
          if (resolved) {
            nextAssetPaths[asset.id] = resolved
            updated = true
          }
        }
      }
      if (updated) {
        assetPaths = nextAssetPaths
      }
    }

    set({ project: mergedProject, missingAssets, assetPaths })
    useEditorStore.getState().setMissingAssets(missingAssets)
    if (wasDirty) {
      // Asset-job completion can arrive while timeline edits are unsaved. Keep
      // those edits authoritative and let the normal revision-aware save merge
      // the refreshed asset metadata into the next project write.
      get().markProjectChanged(mergedProject)
      return
    }
    useEditorStore.getState().setProject(mergedProject)
  },

  play: () => {
    set({ view: { ...get().view, isPlaying: true } })
  },

  pause: () => {
    set({ view: { ...get().view, isPlaying: false } })
  },

  togglePlay: () => {
    const { view } = get()
    set({ view: { ...view, isPlaying: !view.isPlaying } })
  },

  seek: (ms) => {
    const { view, engine } = get()
    const duration = engine ? getTotalDuration(engine.history.present) : view.durationMs
    const clamped = Math.max(0, Math.min(ms, duration))
    set({ view: { ...view, playheadMs: clamped } })
  },

  setPlaybackRate: (rate) => {
    const { view } = get()
    const clamped = Math.max(0.25, Math.min(rate, 4))
    set({ view: { ...view, playbackRate: clamped } })
  },

  setZoom: (zoom) => {
    const { view } = get()
    const clamped = Math.max(0, Math.min(zoom, 100))
    set({ view: { ...view, zoom: clamped } })
  },

  setScroll: (ms) => {
    const { view } = get()
    set({ view: { ...view, scrollMs: Math.max(0, ms) } })
  },

  setSnapEnabled: (enabled) => {
    const { view } = get()
    set({ view: { ...view, snapEnabled: enabled } })
  },

  setSnapThreshold: (thresholdMs) => {
    const { view } = get()
    set({
      view: {
        ...view,
        snapThresholdMs: Math.max(1, Math.min(Math.round(thresholdMs), 5_000)),
      },
    })
  },

  setPreviewQuality: (mode) => {
    const { view } = get()
    if (view.previewQuality === mode) return
    set({ view: { ...view, previewQuality: mode } })
  },

  toggleTrackCollapsed: (trackId) => {
    const { view } = get()
    const collapsed = new Set(view.collapsedTrackIds)
    if (collapsed.has(trackId)) collapsed.delete(trackId)
    else collapsed.add(trackId)
    set({ view: { ...view, collapsedTrackIds: [...collapsed] } })
  },

  setTrackHeight: (trackId, height) => {
    const { view } = get()
    set({
      view: {
        ...view,
        trackHeights: {
          ...view.trackHeights,
          [trackId]: Math.max(28, Math.min(Math.round(height), 240)),
        },
      },
    })
  },

  setActiveExportJob: (job) => {
    set({ activeExportJob: job })
  },

  setCaptionMode: (mode) => {
    const project = get().project
    if (!project || project.exportSettings.captionMode === mode) return
    const nextProject = {
      ...project,
      exportSettings: { ...project.exportSettings, captionMode: mode },
      updatedAt: new Date().toISOString(),
    }
    get().markProjectChanged(nextProject)
  },

  setChapterMode: (mode) => {
    const project = get().project
    if (!project || project.exportSettings.chapterMode === mode) return
    const nextProject = {
      ...project,
      exportSettings: { ...project.exportSettings, chapterMode: mode },
      updatedAt: new Date().toISOString(),
    }
    get().markProjectChanged(nextProject)
  },

  setExportContainer: (container) => {
    const project = get().project
    if (!project || project.exportSettings.container === container) return
    const isGif = container === "gif"
    const isWebp = container === "webp"
    const isAnimation = isGif || isWebp
    const preset: ExportPreset = isGif
      ? "gif-balanced"
      : isWebp
        ? "webp-balanced"
        : project.exportSettings.preset.startsWith("gif-") ||
            project.exportSettings.preset.startsWith("webp-")
          ? "balanced"
          : project.exportSettings.preset
    const codec: "h264" | "hevc" | "gif" | "webp" = isGif
      ? "gif"
      : isWebp
        ? "webp"
        : project.exportSettings.codec === "gif" || project.exportSettings.codec === "webp"
          ? "h264"
          : project.exportSettings.codec
    const chapterMode =
      isAnimation &&
      (project.exportSettings.chapterMode === "embed" ||
        project.exportSettings.chapterMode === "both")
        ? "none"
        : project.exportSettings.chapterMode
    const nextProject = {
      ...project,
      exportSettings: {
        ...project.exportSettings,
        container,
        preset,
        codec,
        chapterMode,
      },
      updatedAt: new Date().toISOString(),
    }
    get().markProjectChanged(nextProject)
  },

  setExportPreset: (preset) => {
    const project = get().project
    if (!project || project.exportSettings.preset === preset) return
    const isGif =
      preset.startsWith("gif-") ||
      (project.exportSettings.container === "gif" && preset === "selected-range")
    const isWebp =
      preset.startsWith("webp-") ||
      (project.exportSettings.container === "webp" && preset === "selected-range")
    const isAnimation = isGif || isWebp
    const container: "mp4" | "gif" | "webp" = isGif
      ? "gif"
      : isWebp
        ? "webp"
        : project.exportSettings.container === "gif" || project.exportSettings.container === "webp"
          ? "mp4"
          : project.exportSettings.container
    const codec: "h264" | "hevc" | "gif" | "webp" = isGif
      ? "gif"
      : isWebp
        ? "webp"
        : project.exportSettings.codec === "gif" || project.exportSettings.codec === "webp"
          ? "h264"
          : project.exportSettings.codec
    const chapterMode =
      isAnimation &&
      (project.exportSettings.chapterMode === "embed" ||
        project.exportSettings.chapterMode === "both")
        ? "none"
        : project.exportSettings.chapterMode
    const nextProject = {
      ...project,
      exportSettings: {
        ...project.exportSettings,
        preset,
        container,
        codec,
        chapterMode,
      },
      updatedAt: new Date().toISOString(),
    }
    get().markProjectChanged(nextProject)
  },

  setExportCodec: (codec) => {
    const project = get().project
    if (!project || project.exportSettings.codec === codec) return
    const nextProject = {
      ...project,
      exportSettings: { ...project.exportSettings, codec },
      updatedAt: new Date().toISOString(),
    }
    get().markProjectChanged(nextProject)
  },

  setExportEncoder: (encoder) => {
    const project = get().project
    if (!project || project.exportSettings.encoder === encoder) return
    const nextProject = {
      ...project,
      exportSettings: { ...project.exportSettings, encoder },
      updatedAt: new Date().toISOString(),
    }
    get().markProjectChanged(nextProject)
  },

  setExportRange: (range) => {
    const project = get().project
    const current = project?.exportSettings.range
    if (!project || (current?.startMs === range?.startMs && current?.endMs === range?.endMs)) return
    const nextProject = {
      ...project,
      exportSettings: { ...project.exportSettings, range },
      updatedAt: new Date().toISOString(),
    }
    get().markProjectChanged(nextProject)
  },

  cancelExport: async () => {
    const job = get().activeExportJob
    if (!job || !["pending", "running"].includes(job.status)) return
    try {
      await cancelMediaJob(job.id)
    } catch (err) {
      set({ error: toErrorMessage(err) })
    }
  },

  retryExport: async () => {
    const job = get().activeExportJob
    if (!job || !["failed", "cancelled"].includes(job.status)) return
    try {
      const retried = await retryExportRequest(job.id)
      set({ activeExportJob: retried, error: null })
    } catch (err) {
      set({ error: toErrorMessage(err) })
    }
  },

  revealExport: async () => {
    const job = get().activeExportJob
    if (!job || job.status !== "completed") return
    try {
      await revealExport(job.id)
    } catch (err) {
      set({ error: toErrorMessage(err) })
    }
  },

  setSelection: (selection) => {
    const { view } = get()
    set({ view: { ...view, selection } })
  },

  setDraftTimeline: (draft, error) => {
    set({ draftTimeline: draft, draftError: error ?? null, error: null })
  },

  clearDraft: () => {
    set({ draftTimeline: null, draftError: null })
  },

  export: async (outputPath) => {
    const { engine, recording, project } = get()
    if (!engine || !recording || !project) return

    if (get().missingAssets.length > 0) {
      set({
        error:
          "Cannot export while assets are missing. Relink or restore the missing assets first.",
      })
      return
    }

    // Phase 1: freeze a durable project revision before building the render plan.
    // Any unsaved edits are flushed first so the export uses the persisted state.
    try {
      await get().save()
      if (useEditorStore.getState().saveStatus === "error") {
        set({
          error:
            "Cannot export while the project cannot be saved. Fix the save error and try again.",
        })
        return
      }
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return
    }

    const currentProject = get().project
    if (!currentProject) return

    const isGif =
      currentProject.exportSettings.container === "gif" ||
      currentProject.exportSettings.preset.startsWith("gif-")
    const isWebp =
      currentProject.exportSettings.container === "webp" ||
      currentProject.exportSettings.preset.startsWith("webp-")
    const isAnimation = isGif || isWebp
    const sanitizedChapterMode = isAnimation
      ? currentProject.exportSettings.chapterMode === "both" ||
        currentProject.exportSettings.chapterMode === "sidecar"
        ? "sidecar"
        : "none"
      : currentProject.exportSettings.chapterMode
    const effectiveExportSettings = {
      ...currentProject.exportSettings,
      container: isGif
        ? ("gif" as const)
        : isWebp
          ? ("webp" as const)
          : currentProject.exportSettings.container,
      codec: isGif
        ? ("gif" as const)
        : isWebp
          ? ("webp" as const)
          : currentProject.exportSettings.codec,
      chapterMode: sanitizedChapterMode,
    }

    const plan = buildRenderPlan({
      state: engine.history.present,
      projectId: currentProject.id,
      settings: effectiveExportSettings,
      captionMode: effectiveExportSettings.captionMode,
      chapterMode: effectiveExportSettings.chapterMode,
      assets: currentProject.assets,
      cursorTelemetry: get().cursorTelemetry,
      cursorEngine: get().cursorEngine,
    })
    if (!plan.ok) {
      set({ error: plan.error.message })
      return
    }
    try {
      const job = await exportTimeline({
        projectId: currentProject.id,
        outputPath,
        plan: plan.value,
        settings: effectiveExportSettings,
      })
      set({ activeExportJob: job })
    } catch (err) {
      set({ error: toErrorMessage(err) })
    }
  },

  // Phase 1: bump the project revision, keep the editor store in sync, and
  // queue a save. If a snapshot is required (destructive command), flag it so
  // the next save snapshots the on-disk project first.
  markProjectChanged: (nextProject, options) => {
    const { projectRevision, savePromise } = get()
    const nextRevision = projectRevision + 1
    set({
      project: nextProject,
      projectRevision: nextRevision,
      snapshotPending: options?.needsSnapshot ? true : get().snapshotPending,
    })
    useEditorStore.getState().setDirty(true)
    // Keep the save status as "saving" when an edit races an in-flight save,
    // otherwise the UI would show idle while a save is still running.
    if (!savePromise) {
      useEditorStore.getState().setSaveStatus("idle")
    }
    get().scheduleAutosave()
  },

  // Phase 1: reconcile the result of a completed save. If the in-memory project
  // has advanced past the revision that was sent, do not overwrite it with the
  // stale returned copy; a new save will be chained by save().
  commitSaveResult: (saved, sentRevision) => {
    const { projectRevision, pendingSaveRevision } = get()
    if (projectRevision === sentRevision) {
      set({ project: saved, savingRevision: null })
      useEditorStore.getState().setProject(saved)
      useEditorStore.getState().setDirty(false)
      useEditorStore.getState().setSaveStatus("saved")
    } else if (projectRevision > sentRevision) {
      // Newer edits exist. The in-memory project is authoritative; do not roll
      // it back to the stale saved copy. Keep dirty and wait for the chained
      // save to catch up.
      set({ savingRevision: null })
      useEditorStore.getState().setSaveStatus("idle")
      // Re-arm pending so save() sees there is still work to do.
      if (pendingSaveRevision === null || pendingSaveRevision <= sentRevision) {
        set({ pendingSaveRevision: projectRevision })
      }
    }
  },

  // Phase 1: a save failed. Do not overwrite the in-memory project or clear
  // dirty state, so the user can retry or continue editing without losing work.
  handleSaveError: (err, _sentRevision) => {
    set({ savingRevision: null })
    useEditorStore.getState().setSaveStatus("error", toErrorMessage(err))
    set({ error: toErrorMessage(err) })
  },

  // Phase 1: flush any pending save and tear down the session. Returns true
  // when it is safe to leave the editor, and false if a save failed so the
  // caller can keep the session open.
  closeSession: async () => {
    const { autosaveTimeout, savePromise } = get()
    if (autosaveTimeout) {
      window.clearTimeout(autosaveTimeout)
    }

    if (useEditorStore.getState().isDirty || savePromise) {
      try {
        await get().save()
      } catch {
        // Error is already in the store; do not reset the session.
        return false
      }
      if (useEditorStore.getState().saveStatus === "error") {
        return false
      }
    }

    get().resetSession()
    return true
  },

  // Phase 1: reset all session-scoped state without saving. Used when the
  // session component unmounts after the session has already been closed.
  resetSession: () => {
    const { autosaveTimeout } = get()
    if (autosaveTimeout) {
      window.clearTimeout(autosaveTimeout)
    }
    get().stopListening()
    set({
      engine: null,
      view: {
        zoom: 50,
        scrollMs: 0,
        playheadMs: 0,
        isPlaying: false,
        playbackRate: 1,
        previewQuality: "quality",
        durationMs: 0,
        selection: null,
        snapEnabled: true,
        snapThresholdMs: 120,
        collapsedTrackIds: [],
        trackHeights: {},
      },
      recording: null,
      metadata: null,
      project: null,
      cursorTelemetry: null,
      cursorEngine: null,
      cursorTelemetryStatus: "unavailable",
      activeJob: null,
      activeExportJob: null,
      missingAssets: [],
      assetPaths: {},
      isLoading: false,
      error: null,
      isListening: false,
      unlisten: null,
      autosaveTimeout: null,
      projectRevision: 0,
      savingRevision: null,
      pendingSaveRevision: null,
      savePromise: null,
      snapshotPending: false,
    })
    useEditorStore.getState().close()
  },

  clearError: () => {
    set({ error: null })
  },

  setError: (message) => {
    set({ error: message, draftTimeline: null, draftError: null })
  },
}))
