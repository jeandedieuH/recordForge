import { create } from "zustand"
import type {
  LibraryRecording,
  MediaJob,
  MediaMetadata,
  TimelineViewState,
} from "@recordforge/contracts"
import {
  createEngine,
  createTimelineFromRecording,
  executeCommand,
  getTotalDuration,
  redoCommand,
  type CommandEngine,
  type TimelineCommand,
  undoCommand,
} from "@recordforge/editor-core"
import { buildRenderPlan } from "@recordforge/media-core"
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

interface TimelineStore {
  engine: CommandEngine | null
  view: TimelineViewState
  recording: LibraryRecording | null
  metadata: MediaMetadata | null
  activeJob: MediaJob | null
  isLoading: boolean
  error: string | null
  activeExportJob: MediaJob | null
  // True while the media-job-update listener is active; prevents duplicate
  // subscriptions and races between mount and unmount.
  isListening: boolean
  unlisten: (() => void) | null

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

  export: (outputPath: string) => Promise<void>
  clearError: () => void
}

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

export const useTimelineStore = create<TimelineStore>((set, get) => ({
  engine: null,
  view: {
    zoom: 50,
    scrollMs: 0,
    playheadMs: 0,
    isPlaying: false,
    durationMs: 0,
  },
  recording: null,
  metadata: null,
  activeJob: null,
  isLoading: false,
  error: null,
  activeExportJob: null,
  isListening: false,
  unlisten: null,

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

      const timeline = createTimelineFromRecording(recording, meta, recording.name)
      const engine = createEngine(timeline)
      const duration = getTotalDuration(timeline)

      set({
        engine,
        recording,
        metadata: meta,
        activeJob,
        activeExportJob: null,
        view: { zoom: 50, scrollMs: 0, playheadMs: 0, isPlaying: false, durationMs: duration },
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
    const { engine } = get()
    if (!engine) return
    const result = executeCommand(engine, command)
    if (!result.ok) {
      set({ error: result.error.message })
      return
    }
    const duration = getTotalDuration(result.value.history.present)
    const view = get().view
    set({
      engine: result.value,
      error: null,
      view: {
        ...view,
        durationMs: duration,
        playheadMs: Math.min(view.playheadMs, duration),
      },
    })
  },

  undo: () => {
    const { engine } = get()
    if (!engine) return
    const result = undoCommand(engine)
    if (!result.ok) {
      set({ error: result.error.message })
      return
    }
    const duration = getTotalDuration(result.value.history.present)
    const view = get().view
    set({
      engine: result.value,
      view: { ...view, durationMs: duration, playheadMs: Math.min(view.playheadMs, duration) },
      error: null,
    })
  },

  redo: () => {
    const { engine } = get()
    if (!engine) return
    const result = redoCommand(engine)
    if (!result.ok) {
      set({ error: result.error.message })
      return
    }
    const duration = getTotalDuration(result.value.history.present)
    const view = get().view
    set({
      engine: result.value,
      view: { ...view, durationMs: duration, playheadMs: Math.min(view.playheadMs, duration) },
      error: null,
    })
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

  export: async (outputPath) => {
    const { engine, recording } = get()
    if (!engine || !recording) return
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
