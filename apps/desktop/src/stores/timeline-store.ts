import { create } from "zustand"
import type {
  ExportPreset,
  ExportRange,
  LibraryRecording,
  MediaJob,
  CursorTelemetryFile,
  MediaMetadata,
  recordForgeProject,
  TimelineViewState,
} from "@recordforge/contracts"
import {
  createEngine,
  createProjectFromRecording,
  executeCommand,
  getTotalDuration,
  projectToTimeline,
  redoCommand,
  timelineToProject,
  type CommandEngine,
  type ExecuteOptions,
  type TimelineCommand,
  type TimelineSelection,
  type RenderCaptionMode,
  undoCommand,
} from "@recordforge/editor-core"
import { buildRenderPlan } from "@recordforge/media-core"
import {
  createProject,
  loadProject,
  relinkProjectAsset,
  saveProject,
  snapshotProject,
} from "../lib/project"
import { getCursorTelemetry } from "../lib/cursor"
import { listRecordings } from "../lib/library"
import { toErrorMessage } from "../lib/errors"
import { isTauri } from "../lib/settings"
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
  cursorTelemetryStatus: "loading" | "available" | "unavailable"
  activeJob: MediaJob | null
  isLoading: boolean
  error: string | null
  activeExportJob: MediaJob | null
  missingAssets: string[]
  // True while the media-job-update listener is active; prevents duplicate
  // subscriptions and races between mount and unmount.
  isListening: boolean
  unlisten: (() => void) | null
  // Pending autosave timer; cleared when a save runs or the editor closes.
  autosaveTimeout: number | null

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
  toggleTrackCollapsed: (trackId: string) => void
  setTrackHeight: (trackId: string, height: number) => void
  setActiveExportJob: (job: MediaJob | null) => void
  setCaptionMode: (mode: RenderCaptionMode) => void
  setExportPreset: (preset: ExportPreset) => void
  setExportCodec: (codec: "h264" | "hevc") => void
  setExportRange: (range: ExportRange | undefined) => void
  cancelExport: () => Promise<void>
  retryExport: () => Promise<void>
  revealExport: () => Promise<void>
  setSelection: (selection: TimelineSelection | null) => void

  save: () => Promise<void>
  scheduleAutosave: () => void
  relinkAsset: (assetId: string, newPath: string) => Promise<void>

  export: (outputPath: string) => Promise<void>
  clearError: () => void
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
    zoom: 50,
    scrollMs: 0,
    playheadMs: 0,
    isPlaying: false,
    playbackRate: 1,
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
  cursorTelemetryStatus: "unavailable",
  activeJob: null,
  isLoading: false,
  error: null,
  activeExportJob: null,
  missingAssets: [],
  isListening: false,
  unlisten: null,
  autosaveTimeout: null,

  load: async (recordingId) => {
    set({
      isLoading: true,
      error: null,
      engine: null,
      recording: null,
      metadata: null,
      project: null,
      cursorTelemetry: null,
      cursorTelemetryStatus: "loading",
      activeJob: null,
      activeExportJob: null,
      missingAssets: [],
    })
    try {
      const recordings = await listRecordings()
      const recording = recordings.find((r) => r.id === recordingId)
      if (!recording) {
        throw new Error(`Recording ${recordingId} not found`)
      }

      const [metadata, jobs, initialCursorTelemetry] = await Promise.all([
        getMediaMetadata(recordingId),
        listMediaJobs(recordingId),
        isTauri() ? getCursorTelemetry(recordingId).catch(() => null) : Promise.resolve(null),
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

      if (loaded) {
        project = loaded.project
        missingAssets = loaded.missingAssets
      } else {
        project = createProjectFromRecording(recording, meta, recording.name)
        project = await createProject(project)
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

      // Keep the editor store in sync for UI surfaces (save status, missing assets).
      useEditorStore.getState().open(recordingId, project)
      useEditorStore.getState().setMissingAssets(missingAssets)

      set({
        engine,
        recording,
        metadata: meta,
        project,
        cursorTelemetry: initialCursorTelemetry,
        cursorTelemetryStatus: initialCursorTelemetry ? "available" : "unavailable",
        activeJob,
        activeExportJob: null,
        missingAssets,
        view: {
          zoom: 50,
          scrollMs: 0,
          playheadMs: 0,
          isPlaying: false,
          playbackRate: 1,
          durationMs: duration,
          selection: null,
          snapEnabled: true,
          snapThresholdMs: 120,
          collapsedTrackIds: [],
          trackHeights: {},
        },
        isLoading: false,
        error: null,
      })
      if (didMigrateCursorTrack) {
        useEditorStore.getState().setDirty(true)
        get().scheduleAutosave()
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

    if (isDestructiveCommand(command)) {
      const recording = get().recording
      if (recording) {
        // Fire-and-forget snapshot; failures are not surfaced to the user.
        void snapshotProject(recording.id).catch(() => {})
      }
    }

    const result = executeCommand(engine, command, options)
    if (!result.ok) {
      set({ error: result.error.message })
      return false
    }
    const nextTimeline = result.value.history.present
    const nextProject = timelineToProject(nextTimeline, project)
    const duration = getTotalDuration(nextTimeline)
    const view = get().view
    set({
      engine: result.value,
      project: nextProject,
      error: null,
      view: {
        ...view,
        durationMs: duration,
        playheadMs: Math.min(view.playheadMs, duration),
      },
    })
    useEditorStore.getState().setDirty(true)
    get().scheduleAutosave()
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
    set({
      engine: result.value,
      project: nextProject,
      view: { ...view, durationMs: duration, playheadMs: Math.min(view.playheadMs, duration) },
      error: null,
    })
    useEditorStore.getState().setDirty(true)
    get().scheduleAutosave()
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
    set({
      engine: result.value,
      project: nextProject,
      view: { ...view, durationMs: duration, playheadMs: Math.min(view.playheadMs, duration) },
      error: null,
    })
    useEditorStore.getState().setDirty(true)
    get().scheduleAutosave()
  },

  scheduleAutosave: () => {
    const { autosaveTimeout } = get()
    if (autosaveTimeout) {
      window.clearTimeout(autosaveTimeout)
    }

    useEditorStore.getState().setSaveStatus("idle")

    const timeout = window.setTimeout(() => {
      void get().save()
    }, AUTOSAVE_DELAY_MS)

    set({ autosaveTimeout: timeout })
  },

  save: async () => {
    const { project, autosaveTimeout } = get()
    if (!project) return

    if (autosaveTimeout) {
      window.clearTimeout(autosaveTimeout)
      set({ autosaveTimeout: null })
    }

    useEditorStore.getState().setSaveStatus("saving")
    try {
      const saved = await saveProject(project)
      set({ project: saved })
      useEditorStore.getState().setProject(saved)
      useEditorStore.getState().setDirty(false)
      useEditorStore.getState().setSaveStatus("saved")
    } catch (err) {
      useEditorStore.getState().setSaveStatus("error", toErrorMessage(err))
      set({ error: toErrorMessage(err) })
    }
  },

  relinkAsset: async (assetId, newPath) => {
    const { recording, project } = get()
    if (!recording || !project) return
    try {
      const updated = await relinkProjectAsset(recording.id, assetId, newPath)
      const missing = updated.assets.filter((a) => a.status === "missing").map((a) => a.id)
      set({ project: updated, missingAssets: missing })
      useEditorStore.getState().setProject(updated)
      useEditorStore.getState().setMissingAssets(missing)
      // Persist the relinked project immediately so a missing-asset state is
      // never lost on close.
      void get().save()
    } catch (err) {
      set({ error: toErrorMessage(err) })
    }
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
    const clamped = Math.max(1, Math.min(zoom, 500))
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
    set({ project: nextProject })
    useEditorStore.getState().setProject(nextProject)
    useEditorStore.getState().setDirty(true)
    get().scheduleAutosave()
  },

  setExportPreset: (preset) => {
    const project = get().project
    if (!project || project.exportSettings.preset === preset) return
    const nextProject = {
      ...project,
      exportSettings: { ...project.exportSettings, preset },
      updatedAt: new Date().toISOString(),
    }
    set({ project: nextProject })
    useEditorStore.getState().setProject(nextProject)
    useEditorStore.getState().setDirty(true)
    get().scheduleAutosave()
  },

  setExportCodec: (codec) => {
    const project = get().project
    if (!project || project.exportSettings.codec === codec) return
    const nextProject = {
      ...project,
      exportSettings: { ...project.exportSettings, codec },
      updatedAt: new Date().toISOString(),
    }
    set({ project: nextProject })
    useEditorStore.getState().setProject(nextProject)
    useEditorStore.getState().setDirty(true)
    get().scheduleAutosave()
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
    set({ project: nextProject })
    useEditorStore.getState().setProject(nextProject)
    useEditorStore.getState().setDirty(true)
    get().scheduleAutosave()
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

    const plan = buildRenderPlan({
      state: engine.history.present,
      projectId: project.id,
      settings: project.exportSettings,
      captionMode: project.exportSettings.captionMode,
    })
    if (!plan.ok) {
      set({ error: plan.error.message })
      return
    }
    try {
      const job = await exportTimeline({
        projectId: project.id,
        outputPath,
        plan: plan.value,
        settings: project.exportSettings,
      })
      set({ activeExportJob: job })
    } catch (err) {
      set({ error: toErrorMessage(err) })
    }
  },

  clearError: () => {
    set({ error: null })
  },
}))
