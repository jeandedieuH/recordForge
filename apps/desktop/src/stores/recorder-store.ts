import { create } from "zustand"
import type {
  AudioDevice,
  BenchmarkReport,
  CaptureSource,
  DiagnosticsReport,
  EncoderInfo,
  FinalizationProgress,
  RecordingConfig,
  RecordingMarker,
  RecordingPreferences,
  RecordingProfile,
  RecordingStatus,
  RecoveryScanResult,
  VideoDevice,
} from "@recordforge/contracts"
import {
  defaultRecordingPreferences,
  reconcileCaptureSource,
  reconcileMicrophone,
  reconcileProfile,
  reconcileSystemAudio,
  reconcileWebcam,
  recordingPreferencesSchema,
} from "@recordforge/contracts"
import {
  deleteRecoverySession,
  detectHardwareEncoders,
  discardRecording,
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
import { getSetting, isTauri, setSetting } from "../lib/settings"

// Transport action currently in flight. Used for granular per-button pending
// feedback (e.g. "Stopping..." on Stop while FFmpeg flushes) instead of a single
// global `isLoading` that blocks every transport button at once.
export type TransportAction = "start" | "pause" | "resume" | "stop" | "discard"

async function queueMediaPreparation(recordingId: string): Promise<boolean> {
  try {
    await prepareRecordingMedia(recordingId)
    return true
  } catch {
    // A saved original remains usable when the optional derivative job cannot start.
    return false
  }
}

async function readStoredPreferences(): Promise<RecordingPreferences> {
  try {
    const raw = await getSetting("recordingPreferences")
    if (!raw) return defaultRecordingPreferences
    const parsed = recordingPreferencesSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : defaultRecordingPreferences
  } catch {
    return defaultRecordingPreferences
  }
}

interface RecorderStore {
  sources: CaptureSource[]
  sourcesLoaded: boolean
  audioDevices: AudioDevice[]
  // True once the first audio-device enumeration has settled (success or fail),
  // so the UI can distinguish "still loading" from "loaded but empty".
  audioDevicesLoaded: boolean
  videoDevices: VideoDevice[]
  videoDevicesLoaded: boolean
  profiles: RecordingProfile[]
  profilesLoaded: boolean
  status: RecordingStatus | null
  encoders: EncoderInfo[]
  recovery: RecoveryScanResult[]
  benchmark: BenchmarkReport | null
  diagnostics: DiagnosticsReport | null
  diagnosticsLoading: boolean
  diagnosticsLoaded: boolean
  markers: RecordingMarker[]
  selectedSource: CaptureSource | null
  selectedSourceType: "screen" | "window" | "region"
  selectedProfileId: RecordingConfig["profile"]
  selectedMicrophoneId: string
  selectedSystemAudioId: string
  selectedWebcamId: string
  preferences: RecordingPreferences
  preferencesLoaded: boolean
  isLoading: boolean
  // Which transport action is currently in flight, for per-button feedback.
  pendingAction: TransportAction | null
  error: string | null
  // Brief confirmation shown after a recording is saved to the library.
  saveMessage: string | null
  // The durable library ID created by the latest successful stop.
  completedRecordingId: string | null
  // Step-by-step progress during recording finalization.
  finalizationProgress: FinalizationProgress | null

  loadPreferences: () => Promise<RecordingPreferences>
  savePreferences: (updates: Partial<RecordingPreferences>) => Promise<void>
  setSelectedSource: (source: CaptureSource | null) => void
  setSelectedSourceType: (type: "screen" | "window" | "region") => void
  setSelectedProfileId: (profile: RecordingConfig["profile"]) => void
  setSelectedMicrophoneId: (id: string) => void
  setMicrophoneEnabled: (enabled: boolean) => void
  setSelectedSystemAudioId: (id: string) => void
  setSystemAudioEnabled: (enabled: boolean) => void
  setSelectedWebcamId: (id: string) => void
  setWebcamEnabled: (enabled: boolean) => void
  clearError: () => void
  clearSaveMessage: () => void
  clearCompletedRecording: () => void
  // Directly replace the recorder status. Used by the `recorder-status` Tauri
  // event listener so global-shortcut and tray actions update the UI instantly
  // without an extra `recording_status` IPC round-trip. Markers reset when the
  // session changes so long-lived windows (floating toolbar) don't carry a
  // stale count into the next recording.
  setStatus: (status: RecordingStatus) => void
  setFinalizationProgress: (progress: FinalizationProgress | null) => void
  // Append a marker broadcast by the Rust `recorder-marker` event. Deduplicates
  // by id because the invoking window also appends locally after its IPC call.
  appendMarker: (marker: RecordingMarker) => void
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
  discard: () => Promise<void>
  addMarker: (label: string) => Promise<void>
  recover: (sessionId: string) => Promise<void>
  deleteRecovery: (sessionId: string) => Promise<void>
}

export const useRecorderStore = create<RecorderStore>((set, get) => ({
  sources: [],
  sourcesLoaded: false,
  audioDevices: [],
  audioDevicesLoaded: false,
  videoDevices: [],
  videoDevicesLoaded: false,
  profiles: [],
  profilesLoaded: false,
  status: null,
  encoders: [],
  recovery: [],
  benchmark: null,
  diagnostics: null,
  diagnosticsLoading: false,
  diagnosticsLoaded: false,
  markers: [],
  selectedSource: null,
  selectedSourceType: "screen",
  selectedProfileId: "low-impact" as const,
  selectedMicrophoneId: "",
  selectedSystemAudioId: "",
  selectedWebcamId: "",
  preferences: defaultRecordingPreferences,
  preferencesLoaded: false,
  isLoading: false,
  pendingAction: null,
  error: null,
  saveMessage: null,
  completedRecordingId: null,
  finalizationProgress: null,

  loadPreferences: async () => {
    const prefs = await readStoredPreferences()
    set({
      preferences: prefs,
      preferencesLoaded: true,
      selectedSourceType: prefs.sourceType,
      selectedProfileId: prefs.profile,
    })
    return prefs
  },

  savePreferences: async (updates) => {
    const current = get().preferences
    const next = recordingPreferencesSchema.parse({ ...current, ...updates })
    set({
      preferences: next,
      selectedSourceType: next.sourceType,
      selectedProfileId: next.profile,
    })
    try {
      await setSetting("recordingPreferences", JSON.stringify(next))
    } catch {
      // Persistence is non-fatal
    }
  },

  setSelectedSource: (source) => {
    if (!source) {
      set({ selectedSource: null })
      return
    }
    if (source.kind === "display") {
      set({ selectedSource: source, selectedSourceType: "screen" })
      void get().savePreferences({
        sourceType: "screen",
        sourceId: source.id,
        sourceName: source.name,
      })
    } else if (source.kind === "window") {
      set({ selectedSource: source, selectedSourceType: "window" })
      void get().savePreferences({
        sourceType: "window",
        sourceId: source.id,
        sourceName: source.name,
      })
    } else if (source.kind === "region") {
      set({ selectedSource: source, selectedSourceType: "region" })
      void get().savePreferences({
        sourceType: "region",
        sourceId: source.id,
        sourceName: source.name,
        regionBounds: source.bounds,
      })
    }
  },

  setSelectedSourceType: (type) => {
    set({ selectedSourceType: type })
    void get().savePreferences({ sourceType: type })
  },

  setSelectedProfileId: (profile) => {
    set({ selectedProfileId: profile })
    void get().savePreferences({ profile })
  },

  setSelectedMicrophoneId: (id) => {
    const mics = get().audioDevices.filter((d) => d.kind === "microphone")
    const mic = mics.find((m) => m.id === id)
    if (id) {
      set({ selectedMicrophoneId: id })
      void get().savePreferences({
        microphoneEnabled: true,
        microphoneId: id,
        microphoneName: mic?.name ?? get().preferences.microphoneName,
      })
    } else {
      set({ selectedMicrophoneId: "" })
      void get().savePreferences({ microphoneEnabled: false })
    }
  },

  setMicrophoneEnabled: (enabled) => {
    if (enabled) {
      const mics = get().audioDevices.filter((d) => d.kind === "microphone")
      const reconciled = reconcileMicrophone(mics, {
        ...get().preferences,
        microphoneEnabled: true,
      })
      const mic = mics.find((m) => m.id === reconciled.id)
      set({ selectedMicrophoneId: reconciled.id })
      void get().savePreferences({
        microphoneEnabled: true,
        microphoneId: reconciled.id || get().preferences.microphoneId,
        microphoneName: mic?.name ?? get().preferences.microphoneName,
      })
    } else {
      set({ selectedMicrophoneId: "" })
      void get().savePreferences({ microphoneEnabled: false })
    }
  },

  setSelectedSystemAudioId: (id) => {
    const systemAudios = get().audioDevices.filter((d) => d.kind === "system")
    const sys = systemAudios.find((a) => a.id === id)
    if (id) {
      set({ selectedSystemAudioId: id })
      void get().savePreferences({
        systemAudioEnabled: true,
        systemAudioId: id,
        systemAudioName: sys?.name ?? get().preferences.systemAudioName,
      })
    } else {
      set({ selectedSystemAudioId: "" })
      void get().savePreferences({ systemAudioEnabled: false })
    }
  },

  setSystemAudioEnabled: (enabled) => {
    if (enabled) {
      const systemAudios = get().audioDevices.filter((d) => d.kind === "system")
      const reconciled = reconcileSystemAudio(systemAudios, {
        ...get().preferences,
        systemAudioEnabled: true,
      })
      const sys = systemAudios.find((a) => a.id === reconciled.id)
      set({ selectedSystemAudioId: reconciled.id })
      void get().savePreferences({
        systemAudioEnabled: true,
        systemAudioId: reconciled.id || get().preferences.systemAudioId,
        systemAudioName: sys?.name ?? get().preferences.systemAudioName,
      })
    } else {
      set({ selectedSystemAudioId: "" })
      void get().savePreferences({ systemAudioEnabled: false })
    }
  },

  setSelectedWebcamId: (id) => {
    const webcams = get().videoDevices.filter((d) => d.kind === "webcam")
    const cam = webcams.find((w) => w.id === id)
    if (id) {
      set({ selectedWebcamId: id })
      void get().savePreferences({
        webcamEnabled: true,
        webcamId: id,
        webcamName: cam?.name ?? get().preferences.webcamName,
      })
    } else {
      set({ selectedWebcamId: "" })
      void get().savePreferences({ webcamEnabled: false })
    }
  },

  setWebcamEnabled: (enabled) => {
    if (enabled) {
      const webcams = get().videoDevices.filter((d) => d.kind === "webcam")
      const reconciled = reconcileWebcam(webcams, {
        ...get().preferences,
        webcamEnabled: true,
      })
      const cam = webcams.find((w) => w.id === reconciled.id)
      set({ selectedWebcamId: reconciled.id })
      void get().savePreferences({
        webcamEnabled: true,
        webcamId: reconciled.id || get().preferences.webcamId,
        webcamName: cam?.name ?? get().preferences.webcamName,
      })
    } else {
      set({ selectedWebcamId: "" })
      void get().savePreferences({ webcamEnabled: false })
    }
  },

  clearError: () => set({ error: null }),
  clearSaveMessage: () => set({ saveMessage: null }),
  clearCompletedRecording: () => set({ completedRecordingId: null }),
  setStatus: (status) =>
    set((prev) => ({
      status,
      error: null,
      markers: status.sessionId !== prev.status?.sessionId ? [] : prev.markers,
      finalizationProgress: status.state !== "finalizing" ? null : prev.finalizationProgress,
    })),
  setFinalizationProgress: (finalizationProgress) => set({ finalizationProgress }),
  appendMarker: (marker) =>
    set((prev) =>
      prev.markers.some((existing) => existing.id === marker.id)
        ? prev
        : { markers: [...prev.markers, marker] },
    ),
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
      const prefs = get().preferencesLoaded ? get().preferences : await get().loadPreferences()
      const reconciled = reconcileCaptureSource(sources, prefs)
      set({
        sources,
        sourcesLoaded: true,
        selectedSource: reconciled.source,
        selectedSourceType: reconciled.sourceType,
        error: null,
      })
    } catch (error) {
      set({ error: toErrorMessage(error), sourcesLoaded: true })
    }
  },

  loadAudioDevices: async () => {
    try {
      const devices = await listAudioDevices()
      const prefs = get().preferencesLoaded ? get().preferences : await get().loadPreferences()
      const microphones = devices.filter((d) => d.kind === "microphone")
      const systemAudios = devices.filter((d) => d.kind === "system")

      const micReconciled = reconcileMicrophone(microphones, prefs)
      const sysReconciled = reconcileSystemAudio(systemAudios, prefs)

      set({
        audioDevices: devices,
        audioDevicesLoaded: true,
        selectedMicrophoneId: micReconciled.id,
        selectedSystemAudioId: sysReconciled.id,
        error: null,
      })
    } catch (error) {
      set({ error: toErrorMessage(error), audioDevicesLoaded: true })
    }
  },

  loadVideoDevices: async () => {
    try {
      const devices = await listVideoDevices()
      const prefs = get().preferencesLoaded ? get().preferences : await get().loadPreferences()
      const webcams = devices.filter((d) => d.kind === "webcam")
      const camReconciled = reconcileWebcam(webcams, prefs)

      set({
        videoDevices: devices,
        videoDevicesLoaded: true,
        selectedWebcamId: camReconciled.id,
        error: null,
      })
    } catch (error) {
      set({ error: toErrorMessage(error), videoDevicesLoaded: true })
    }
  },

  loadProfiles: async () => {
    try {
      const profiles = await listBuiltinProfiles()
      const prefs = get().preferencesLoaded ? get().preferences : await get().loadPreferences()
      const profile = reconcileProfile(profiles, prefs)
      set({ profiles, profilesLoaded: true, selectedProfileId: profile, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error), profilesLoaded: true })
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
    set({ diagnosticsLoading: true })
    try {
      const diagnostics = await getDiagnosticsReport()
      set({ diagnostics, diagnosticsLoading: false, diagnosticsLoaded: true, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error), diagnosticsLoading: false, diagnosticsLoaded: true })
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
    // Set the guard before any awaited initialization so repeated clicks cannot
    // create overlapping native recording sessions.
    if (get().pendingAction === "start") return

    set({
      isLoading: true,
      pendingAction: "start",
      error: null,
      markers: [],
      saveMessage: null,
      completedRecordingId: null,
    })

    try {
      let state = get()
      if (!state.preferencesLoaded) {
        await get().loadPreferences()
        state = get()
      }

      // The modal can be submitted before its asynchronous source enumeration
      // finishes. Wait for that result and refresh the state before building the
      // IPC payload instead of treating the first click as a missing source.
      if (!state.selectedSource && !state.sourcesLoaded) {
        await get().loadSources()
        state = get()
      }

      // Ensure audio devices are loaded and reconciled before starting capture
      if (!state.audioDevicesLoaded) {
        await get().loadAudioDevices()
        state = get()
      }

      // Ensure video devices are loaded if webcam is requested
      if (!state.videoDevicesLoaded && state.preferences.webcamEnabled) {
        await get().loadVideoDevices()
        state = get()
      }

      let source = state.selectedSource
      if (!source && state.sources.length > 0) {
        const fallback = state.sources.find((s) => s.kind === "display") || state.sources[0]
        if (fallback) {
          source = fallback
          set({ selectedSource: fallback })
        }
      }

      if (!source) {
        set({
          error: state.error ?? "Select a capture source before recording",
          isLoading: false,
          pendingAction: null,
        })
        return
      }

      let micId = state.selectedMicrophoneId
      if (state.preferences.microphoneEnabled) {
        if (!micId || micId === "default") {
          const mics = state.audioDevices.filter((d) => d.kind === "microphone")
          const rec = reconcileMicrophone(mics, state.preferences)
          micId = rec.id
          if (micId && micId !== state.selectedMicrophoneId) {
            set({ selectedMicrophoneId: micId })
          }
        }
      } else {
        micId = ""
      }

      let sysId = state.selectedSystemAudioId
      if (state.preferences.systemAudioEnabled) {
        if (!sysId || sysId === "system-loopback") {
          const sysAudios = state.audioDevices.filter((d) => d.kind === "system")
          const rec = reconcileSystemAudio(sysAudios, state.preferences)
          sysId = rec.id
          if (sysId && sysId !== state.selectedSystemAudioId) {
            set({ selectedSystemAudioId: sysId })
          }
        }
      } else {
        sysId = ""
      }

      let camId = state.selectedWebcamId
      if (state.preferences.webcamEnabled) {
        if (!camId || camId === "default") {
          const cams = state.videoDevices.filter((d) => d.kind === "webcam")
          const rec = reconcileWebcam(cams, state.preferences)
          camId = rec.id
          if (camId && camId !== state.selectedWebcamId) {
            set({ selectedWebcamId: camId })
          }
        }
      } else {
        camId = ""
      }

      const config: RecordingConfig = {
        source,
        profile: state.selectedProfileId,
        captureMicrophone: Boolean(micId),
        captureSystemAudio: Boolean(sysId),
        captureWebcam: Boolean(camId),
        microphoneDeviceId: micId || undefined,
        systemAudioDeviceId: sysId || undefined,
        webcamDeviceId: camId || undefined,
        smartZoomEnabled: state.preferences.smartZoomEnabled,
        smartZoomPreset: state.preferences.smartZoomPreset,
      }

      void get().savePreferences({
        sourceType: source.kind === "display" ? "screen" : source.kind,
        sourceId: source.id,
        sourceName: source.name,
        regionBounds: source.kind === "region" ? source.bounds : get().preferences.regionBounds,
        profile: state.selectedProfileId,
        microphoneEnabled: Boolean(micId),
        microphoneId: micId || get().preferences.microphoneId,
        systemAudioEnabled: Boolean(sysId),
        systemAudioId: sysId || get().preferences.systemAudioId,
        webcamEnabled: Boolean(camId),
        webcamId: camId || get().preferences.webcamId,
      })

      const configuredCountdown = isTauri()
        ? await getSetting("countdownSeconds").catch(() => null)
        : null
      const countdownSeconds = configuredCountdown === "5" ? 5 : configuredCountdown === "0" ? 0 : 3
      await prepareRecording(config, countdownSeconds)
      const status = await getRecordingStatus()
      set({ status, isLoading: false, pendingAction: null, error: null })
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
        finalizationProgress: null,
        saveMessage: completedRecordingId
          ? `Recording saved (${seconds}s, ${sizeMb} MB). Opening the editor…`
          : `Recording saved (${seconds}s, ${sizeMb} MB). Open it from the Library.`,
      })
    } catch (error) {
      set({
        error: toErrorMessage(error),
        isLoading: false,
        pendingAction: null,
        finalizationProgress: null,
      })
    }
  },

  addMarker: async (label) => {
    try {
      await insertMarker(label)
      // The Rust `recorder-marker` event appends this marker in every window
      // (including this one, deduplicated by id); no local append is needed.
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  discard: async () => {
    // Discard deletes the session outright; surface the wait on the trigger
    // while FFmpeg workers are torn down and files are removed.
    set({ isLoading: true, pendingAction: "discard", error: null })
    try {
      await discardRecording()
      const status = await getRecordingStatus()
      set({
        status,
        isLoading: false,
        pendingAction: null,
        markers: [],
        completedRecordingId: null,
        finalizationProgress: null,
        saveMessage: "Recording discarded. Nothing was saved.",
      })
    } catch (error) {
      set({
        error: toErrorMessage(error),
        isLoading: false,
        pendingAction: null,
        finalizationProgress: null,
      })
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
