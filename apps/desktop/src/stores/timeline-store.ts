import { create } from "zustand"
import type {
  LibraryRecording,
  MediaJob,
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
  type TimelineCommand,
  type TimelineSelection,
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
import { listRecordings } from "../lib/library"
import { toErrorMessage } from "../lib/errors"
import {
  getMediaJob,
  getMediaMetadata,
  listMediaJobs,
  onMediaJobUpdate,
  prepareRecordingMedia,
} from "../lib/media"
import { exportTimeline } from "../lib/timeline"
import { useEditorStore } from "./editor-store"

interface TimelineStore {
  engine: CommandEngine | null
  view: TimelineViewState
  recording: LibraryRecording | null
  metadata: MediaMetadata | null
  project: recordForgeProject | null
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

  execute: (command: TimelineCommand) => void
  undo: () => void
  redo: () => void

  play: () => void
  pause: () => void
  togglePlay: () => void
  seek: (ms: number) => void
  setZoom: (zoom: number) => void
  setScroll: (ms: number) => void
  setActiveExportJob: (job: MediaJob | null) => void
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
  "ripple-delete-clip",
  "delete-track",
  "trim-clip",
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

export const useTimelineStore = create<TimelineStore>((set, get) => ({
  engine: null,
  view: {
    zoom: 50,
    scrollMs: 0,
    playheadMs: 0,
    isPlaying: false,
    durationMs: 0,
    selection: null,
  },
  recording: null,
  metadata: null,
  project: null,
  activeJob: null,
  isLoading: false,
  error: null,
  activeExportJob: null,
  missingAssets: [],
  isListening: false,
  unlisten: null,
  autosaveTimeout: null,

  load: async (recordingId) => {
    set({ isLoading: true, error: null })
    try {
      const recordings = await listRecordings()
      const recording = recordings.find((r) => r.id === recordingId)
      if (!recording) {
        throw new Error(`Recording ${recordingId} not found`)
      }

      const [metadata, jobs] = await Promise.all([
        getMediaMetadata(recordingId),
        listMediaJobs(recordingId),
      ])

      const meta = metadata ?? fallbackMetadata(recording)
      const prepareJobs = jobs.filter((job) => job.kind === "prepare")
      const latest = prepareJobs[0] ?? null
      let activeJob = latest ? await getMediaJob(latest.id) : null
      if (
        meta.hasAudio &&
        (!activeJob ||
          (activeJob.status === "completed" &&
            (activeJob.outputs.prepareVersion < 2 || activeJob.outputs.audioTracks.length === 0)))
      ) {
        // Older prepare jobs only generated one combined waveform and did not
        // expose independent audio assets to the editor.
        activeJob = await prepareRecordingMedia(recordingId)
      }

      // Phase 1: load an existing durable project or create one from the recording.
      const loaded = await loadProject(recordingId)

      let project: recordForgeProject
      let missingAssets: string[] = []

      if (loaded) {
        project = loaded.project
        missingAssets = loaded.missingAssets
      } else {
        project = createProjectFromRecording(recording, meta, recording.name)
        project = await createProject(project)
      }

      const timeline = projectToTimeline(project)
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
        activeJob,
        activeExportJob: null,
        missingAssets,
        view: { zoom: 50, scrollMs: 0, playheadMs: 0, isPlaying: false, durationMs: duration, selection: null },
        isLoading: false,
        error: null,
      })
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

  execute: (command) => {
    const { engine, project } = get()
    if (!engine || !project) return

    if (isDestructiveCommand(command)) {
      const recording = get().recording
      if (recording) {
        // Fire-and-forget snapshot; failures are not surfaced to the user.
        void snapshotProject(recording.id).catch(() => {})
      }
    }

    const result = executeCommand(engine, command)
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
      error: null,
      view: {
        ...view,
        durationMs: duration,
        playheadMs: Math.min(view.playheadMs, duration),
      },
    })
    get().scheduleAutosave()
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

  setZoom: (zoom) => {
    const { view } = get()
    const clamped = Math.max(1, Math.min(zoom, 500))
    set({ view: { ...view, zoom: clamped } })
  },

  setScroll: (ms) => {
    const { view } = get()
    set({ view: { ...view, scrollMs: Math.max(0, ms) } })
  },

  setActiveExportJob: (job) => {
    set({ activeExportJob: job })
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
      recording,
      outputPath,
    })
    if (!plan.ok) {
      set({ error: plan.error.message })
      return
    }
    try {
      const job = await exportTimeline({
        recordingId: recording.id,
        outputPath,
        plan: plan.value,
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
