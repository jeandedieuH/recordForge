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

interface RecorderStore {
  sources: CaptureSource[]
  audioDevices: AudioDevice[]
  videoDevices: VideoDevice[]
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
  error: string | null

  setSelectedSource: (source: CaptureSource | null) => void
  setSelectedProfileId: (profile: RecordingConfig["profile"]) => void
  setSelectedMicrophoneId: (id: string) => void
  setSelectedSystemAudioId: (id: string) => void
  setSelectedWebcamId: (id: string) => void
  clearError: () => void

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
  videoDevices: [],
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
  error: null,

  setSelectedSource: (source) => set({ selectedSource: source }),
  setSelectedProfileId: (profile) => set({ selectedProfileId: profile }),
  setSelectedMicrophoneId: (id) => set({ selectedMicrophoneId: id }),
  setSelectedSystemAudioId: (id) => set({ selectedSystemAudioId: id }),
  setSelectedWebcamId: (id) => set({ selectedWebcamId: id }),
  clearError: () => set({ error: null }),

  loadSources: async () => {
    try {
      const sources = await listCaptureSources()
      set({ sources, error: null })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  loadAudioDevices: async () => {
    try {
      const devices = await listAudioDevices()
      set({ audioDevices: devices, error: null })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  loadVideoDevices: async () => {
    try {
      const devices = await listVideoDevices()
      set({ videoDevices: devices, error: null })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  loadProfiles: async () => {
    try {
      const profiles = await listBuiltinProfiles()
      set({ profiles, error: null })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  loadEncoders: async () => {
    try {
      const encoders = await detectHardwareEncoders()
      set({ encoders, error: null })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  loadRecovery: async () => {
    try {
      const recovery = await scanRecoverySessions()
      set({ recovery, error: null })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  loadDiagnostics: async () => {
    try {
      const diagnostics = await getDiagnosticsReport()
      set({ diagnostics, error: null })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  refreshStatus: async () => {
    try {
      const status = await getRecordingStatus()
      set({ status, error: null })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  runBenchmark: async () => {
    set({ isLoading: true, error: null })
    try {
      const benchmark = await runBenchmark()
      set({ benchmark, isLoading: false, error: null })
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  start: async () => {
    const state = get()
    if (!state.selectedSource) {
      set({ error: "Select a capture source before recording" })
      return
    }

    set({ isLoading: true, error: null, markers: [] })
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
      const status = await getRecordingStatus()
      set({ status, isLoading: false })
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  pause: async () => {
    set({ isLoading: true, error: null })
    try {
      const status = await pauseRecording()
      set({ status, isLoading: false })
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  resume: async () => {
    set({ isLoading: true, error: null })
    try {
      const status = await resumeRecording()
      set({ status, isLoading: false })
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  stop: async () => {
    set({ isLoading: true, error: null })
    try {
      await stopRecording()
      const status = await getRecordingStatus()
      set({ status, isLoading: false })
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  addMarker: async (label) => {
    try {
      const marker = await insertMarker(label)
      set({ markers: [...get().markers, marker] })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  recover: async (sessionId) => {
    set({ isLoading: true, error: null })
    try {
      await recoverSession(sessionId)
      await get().loadRecovery()
      set({ isLoading: false })
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },

  deleteRecovery: async (sessionId) => {
    set({ isLoading: true, error: null })
    try {
      await deleteRecoverySession(sessionId)
      await get().loadRecovery()
      set({ isLoading: false })
    } catch (error) {
      set({ error: String(error), isLoading: false })
    }
  },
}))
