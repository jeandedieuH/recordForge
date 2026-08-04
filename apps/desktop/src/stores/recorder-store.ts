import { create } from "zustand"
import type {
  AudioDevice,
  BenchmarkReport,
  CaptureSource,
  DiagnosticsReport,
  EncoderInfo,
  RecordingConfig,
  RecordingMarker,
  RecordingProfile,
  RecordingStatus,
  RecoveryScanResult,
  VideoDevice,
} from "@recordforge/contracts"
import {
  deleteRecoverySession,
  detectHardwareEncoders,
  getDiagnosticsReport,
  getRecordingStatus,
  insertMarker,
  listAudioDevices,
  listBuiltinProfiles,
  listCaptureSources,
  listVideoDevices,
  pauseRecording,
  recoverSession,
  resumeRecording,
  runBenchmark,
  scanRecoverySessions,
  prepareRecording,
  stopRecording,
} from "../lib/recorder"
import { toErrorMessage } from "../lib/errors"
import { prepareRecordingMedia } from "../lib/media"
import { getSetting, isTauri } from "../lib/settings"

// Transport action currently in flight. Used for granular per-button pending
// feedback (e.g. "Stopping..." on Stop while FFmpeg flushes) instead of a single
// global `isLoading` that blocks every transport button at once.
export type TransportAction = "start" | "pause" | "resume" | "stop"

async function queueMediaPreparation(recordingId: string): Promise<boolean> {
  try {
    await prepareRecordingMedia(recordingId)
    return true
  } catch {
    // A saved original remains usable when the optional derivative job cannot start.
    return false
  }
}

interface RecorderStore {
  sources: CaptureSource[]
  audioDevices: AudioDevice[]
  // True once the first audio-device enumeration has settled (success or fail),
  // so the UI can distinguish "still loading" from "loaded but empty".
  audioDevicesLoaded: boolean
  videoDevices: VideoDevice[]
  videoDevicesLoaded: boolean
  profiles: RecordingProfile[]
  status: RecordingStatus | null
  encoders: EncoderInfo[]
  recovery: RecoveryScanResult[]
  benchmark: BenchmarkReport | null
  diagnostics: DiagnosticsReport | null
  markers: RecordingMarker[]
  selectedSource: CaptureSource | null
  selectedProfileId: RecordingConfig["profile"]
  selectedMicrophoneId: string
  selectedSystemAudioId: string
  selectedWebcamId: string
  isLoading: boolean
  // Which transport action is currently in flight, for per-button feedback.
  pendingAction: TransportAction | null
  error: string | null
  // Brief confirmation shown after a recording is saved to the library.
  saveMessage: string | null
  // The durable library ID created by the latest successful stop.
  completedRecordingId: string | null

  setSelectedSource: (source: CaptureSource | null) => void
  setSelectedProfileId: (profile: RecordingConfig["profile"]) => void
  setSelectedMicrophoneId: (id: string) => void
  setSelectedSystemAudioId: (id: string) => void
  setSelectedWebcamId: (id: string) => void
  clearError: () => void
  clearSaveMessage: () => void
  clearCompletedRecording: () => void
  // Directly replace the recorder status. Used by the `recorder-status` Tauri
  // event listener so global-shortcut and tray actions update the UI instantly
  // without an extra `recording_status` IPC round-trip.
  setStatus: (status: RecordingStatus) => void
  setCompletedRecordingId: (recordingId: string) => void
  queuePreparation: (recordingId: string) => Promise<boolean>

  loadSources: () => Promise<void>
  loadAudioDevices: () => Promise<void>
  loadVideoDevices: () => Promise<void>
  loadProfiles: () => Promise<void>
  loadEncoders: () => Promise<void>
  loadRecovery: () => Promise<void>
  loadDiagnostics: () => Promise<void>
  refreshStatus: () => Promise<void>
  runBenchmark: () => Promise<void>

  start: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  addMarker: (label: string) => Promise<void>
  recover: (sessionId: string) => Promise<void>
  deleteRecovery: (sessionId: string) => Promise<void>
}

export const useRecorderStore = create<RecorderStore>((set, get) => ({
  sources: [],
  audioDevices: [],
  audioDevicesLoaded: false,
  videoDevices: [],
  videoDevicesLoaded: false,
  profiles: [],
  status: null,
  encoders: [],
  recovery: [],
  benchmark: null,
  diagnostics: null,
  markers: [],
  selectedSource: null,
  selectedProfileId: "low-impact",
  selectedMicrophoneId: "",
  selectedSystemAudioId: "",
  selectedWebcamId: "",
  isLoading: false,
  pendingAction: null,
  error: null,
  saveMessage: null,
  completedRecordingId: null,

  setSelectedSource: (source) => set({ selectedSource: source }),
  setSelectedProfileId: (profile) => set({ selectedProfileId: profile }),
  setSelectedMicrophoneId: (id) => set({ selectedMicrophoneId: id }),
  setSelectedSystemAudioId: (id) => set({ selectedSystemAudioId: id }),
  setSelectedWebcamId: (id) => set({ selectedWebcamId: id }),
  clearError: () => set({ error: null }),
  clearSaveMessage: () => set({ saveMessage: null }),
  clearCompletedRecording: () => set({ completedRecordingId: null }),
  setStatus: (status) => set({ status, error: null }),
  setCompletedRecordingId: (recordingId) => set({ completedRecordingId: recordingId }),
  queuePreparation: async (recordingId) => {
    const started = await queueMediaPreparation(recordingId)
    if (!started) {
      set({ saveMessage: "The original source is ready; preview preparation could not be queued." })
    }
    return started
  },

  loadSources: async () => {
    try {
      const sources = await listCaptureSources()
      let selected = get().selectedSource
      if (!selected || !sources.some((s) => s.id === selected?.id)) {
        selected = sources.find((s) => s.kind === "display") || sources[0] || null
      }
      set({ sources, selectedSource: selected, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  loadAudioDevices: async () => {
    try {
      const devices = await listAudioDevices()
      set({ audioDevices: devices, audioDevicesLoaded: true, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error), audioDevicesLoaded: true })
    }
  },

  loadVideoDevices: async () => {
    try {
      const devices = await listVideoDevices()
      set({ videoDevices: devices, videoDevicesLoaded: true, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error), videoDevicesLoaded: true })
    }
  },

  loadProfiles: async () => {
    try {
      const profiles = await listBuiltinProfiles()
      set({ profiles, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  loadEncoders: async () => {
    try {
      const encoders = await detectHardwareEncoders()
      set({ encoders, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  loadRecovery: async () => {
    try {
      const recovery = await scanRecoverySessions()
      set({ recovery, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  loadDiagnostics: async () => {
    try {
      const diagnostics = await getDiagnosticsReport()
      set({ diagnostics, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  refreshStatus: async () => {
    try {
      const status = await getRecordingStatus()
      set({ status, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  runBenchmark: async () => {
    set({ isLoading: true, error: null })
    try {
      const benchmark = await runBenchmark()
      set({ benchmark, isLoading: false, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false })
    }
  },

  start: async () => {
    const state = get()
    let source = state.selectedSource
    if (!source && state.sources.length > 0) {
      const fallback = state.sources.find((s) => s.kind === "display") || state.sources[0]
      if (fallback) {
        source = fallback
        set({ selectedSource: fallback })
      }
    }

    if (!source) {
      set({ error: "Select a capture source before recording" })
      return
    }

    set({
      isLoading: true,
      pendingAction: "start",
      error: null,
      markers: [],
      saveMessage: null,
      completedRecordingId: null,
    })
    try {
      const config: RecordingConfig = {
        source,
        profile: state.selectedProfileId,
        captureMicrophone: !!state.selectedMicrophoneId,
        captureSystemAudio: !!state.selectedSystemAudioId,
        captureWebcam: !!state.selectedWebcamId,
        microphoneDeviceId: state.selectedMicrophoneId || undefined,
        systemAudioDeviceId: state.selectedSystemAudioId || undefined,
        webcamDeviceId: state.selectedWebcamId || undefined,
      }

      const configuredCountdown = isTauri()
        ? await getSetting("countdownSeconds").catch(() => null)
        : null
      const countdownSeconds = configuredCountdown === "5" ? 5 : configuredCountdown === "0" ? 0 : 3
      await prepareRecording(config, countdownSeconds)
      const status = await getRecordingStatus()
      set({ status, isLoading: false, pendingAction: null })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false, pendingAction: null })
    }
  },

  pause: async () => {
    set({ isLoading: true, pendingAction: "pause", error: null })
    try {
      const status = await pauseRecording()
      set({ status, isLoading: false, pendingAction: null })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false, pendingAction: null })
    }
  },

  resume: async () => {
    set({ isLoading: true, pendingAction: "resume", error: null })
    try {
      const status = await resumeRecording()
      set({ status, isLoading: false, pendingAction: null })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false, pendingAction: null })
    }
  },

  stop: async () => {
    // Stop can take up to ~10s while FFmpeg flushes; surface that wait on the
    // Stop button itself rather than freezing the whole transport row.
    set({ isLoading: true, pendingAction: "stop", error: null })
    try {
      const sessionId = get().status?.sessionId
      const stats = await stopRecording()
      const status = await getRecordingStatus()

      // Refresh the library before publishing completion so the shell can open
      // the exact recording created by this session instead of guessing by date.
      const { useLibraryStore } = await import("../features/library/use-library")
      await useLibraryStore.getState().load()
      const recordings = useLibraryStore.getState().recordings
      const completedRecordingId = sessionId
        ? (recordings.find((recording) => recording.sessionId === sessionId)?.id ?? null)
        : null

      const seconds = Math.round((stats.durationMs ?? 0) / 1000)
      const sizeMb = ((stats.outputSizeBytes ?? 0) / (1024 * 1024)).toFixed(1)
      set({
        status,
        isLoading: false,
        pendingAction: null,
        completedRecordingId,
        saveMessage: completedRecordingId
          ? `Recording saved (${seconds}s, ${sizeMb} MB). Opening the editor…`
          : `Recording saved (${seconds}s, ${sizeMb} MB). Open it from the Library.`,
      })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false, pendingAction: null })
    }
  },

  addMarker: async (label) => {
    try {
      const marker = await insertMarker(label)
      set({ markers: [...get().markers, marker] })
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  recover: async (sessionId) => {
    set({ isLoading: true, error: null })
    try {
      const recording = await recoverSession(sessionId)
      const preparationStarted = await get().queuePreparation(recording.id)
      await get().loadRecovery()
      set({
        isLoading: false,
        saveMessage: preparationStarted
          ? "Recording recovered. Preview preparation is running in the background."
          : "Recording recovered. The original source is ready; preview preparation could not be queued.",
      })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false })
      throw error
    }
  },

  deleteRecovery: async (sessionId) => {
    set({ isLoading: true, error: null })
    try {
      await deleteRecoverySession(sessionId)
      await get().loadRecovery()
      set({ isLoading: false })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false })
      throw error
    }
  },
}))
