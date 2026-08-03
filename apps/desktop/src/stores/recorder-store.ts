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
  startRecording,
  stopRecording,
} from "../lib/recorder"
import { toErrorMessage } from "../lib/errors"

// Transport action currently in flight. Used for granular per-button pending
// feedback (e.g. "Stopping..." on Stop while FFmpeg flushes) instead of a single
// global `isLoading` that blocks every transport button at once.
export type TransportAction = "start" | "pause" | "resume" | "stop"

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
  // Brief confirmation shown after a recording is saved to the library, so the
  // user knows stop succeeded even though the UI just returns to "Ready".
  saveMessage: string | null

  setSelectedSource: (source: CaptureSource | null) => void
  setSelectedProfileId: (profile: RecordingConfig["profile"]) => void
  setSelectedMicrophoneId: (id: string) => void
  setSelectedSystemAudioId: (id: string) => void
  setSelectedWebcamId: (id: string) => void
  clearError: () => void
  clearSaveMessage: () => void
  // Directly replace the recorder status. Used by the `recorder-status` Tauri
  // event listener so global-shortcut and tray actions update the UI instantly
  // without an extra `recording_status` IPC round-trip.
  setStatus: (status: RecordingStatus) => void

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

  setSelectedSource: (source) => set({ selectedSource: source }),
  setSelectedProfileId: (profile) => set({ selectedProfileId: profile }),
  setSelectedMicrophoneId: (id) => set({ selectedMicrophoneId: id }),
  setSelectedSystemAudioId: (id) => set({ selectedSystemAudioId: id }),
  setSelectedWebcamId: (id) => set({ selectedWebcamId: id }),
  clearError: () => set({ error: null }),
  clearSaveMessage: () => set({ saveMessage: null }),
  setStatus: (status) => set({ status, error: null }),

  loadSources: async () => {
    try {
      const sources = await listCaptureSources()
      set({ sources, error: null })
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
    if (!state.selectedSource) {
      set({ error: "Select a capture source before recording" })
      return
    }

    set({ isLoading: true, pendingAction: "start", error: null, markers: [], saveMessage: null })
    try {
      const config: RecordingConfig = {
        source: state.selectedSource,
        profile: state.selectedProfileId,
        captureMicrophone: !!state.selectedMicrophoneId,
        captureSystemAudio: !!state.selectedSystemAudioId,
        captureWebcam: !!state.selectedWebcamId,
        microphoneDeviceId: state.selectedMicrophoneId || undefined,
        systemAudioDeviceId: state.selectedSystemAudioId || undefined,
        webcamDeviceId: state.selectedWebcamId || undefined,
      }

      await startRecording(config)
      // The Rust command also emits a `recorder-status` event, but the main
      // window initiated this action so we fetch the authoritative status.
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
      const stats = await stopRecording()
      const status = await getRecordingStatus()
      set({ status, isLoading: false, pendingAction: null })

      // Refresh the library so the new recording appears immediately. The
      // library view only loads on mount, so without this the user would stop
      // a recording and see "nothing happen" even though it was saved.
      const { useLibraryStore } = await import("../features/library/use-library")
      await useLibraryStore.getState().load()

      // Show a brief confirmation with duration so the user knows it worked.
      const seconds = Math.round((stats.durationMs ?? 0) / 1000)
      const sizeMb = ((stats.outputSizeBytes ?? 0) / (1024 * 1024)).toFixed(1)
      set({
        saveMessage: `Recording saved (${seconds}s, ${sizeMb} MB). View it in the Library tab.`,
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
      await recoverSession(sessionId)
      await get().loadRecovery()
      set({ isLoading: false })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false })
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
    }
  },
}))
