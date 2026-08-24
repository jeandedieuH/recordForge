import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RecordingStatus } from "@recordforge/contracts"
import { useRecorderStore } from "./recorder-store"
import * as recorderApi from "../lib/recorder"

const storageMap = new Map<string, string>()
const mockLocalStorage = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storageMap.set(key, value)
  },
  removeItem: (key: string) => {
    storageMap.delete(key)
  },
  clear: () => {
    storageMap.clear()
  },
}
// @ts-expect-error polyfill for test environment
globalThis.localStorage = mockLocalStorage

describe("recorder-store preferences & fallback", () => {
  beforeEach(() => {
    storageMap.clear()
    vi.restoreAllMocks()
    useRecorderStore.setState({
      sources: [],
      sourcesLoaded: false,
      audioDevices: [],
      audioDevicesLoaded: false,
      videoDevices: [],
      videoDevicesLoaded: false,
      profiles: [],
      profilesLoaded: false,
      diagnosticsLoaded: false,
      status: null,
      isLoading: false,
      pendingAction: null,
      selectedSource: null,
      selectedSourceType: "screen",
      selectedProfileId: "low-impact",
      selectedMicrophoneId: "",
      selectedSystemAudioId: "",
      selectedWebcamId: "",
      preferences: {
        sourceType: "screen",
        sourceId: null,
        sourceName: null,
        regionBounds: null,
        profile: "low-impact",
        smartZoomEnabled: false,
        smartZoomPreset: "product-demo",
        microphoneEnabled: false,
        microphoneId: null,
        microphoneName: null,
        systemAudioEnabled: false,
        systemAudioId: null,
        systemAudioName: null,
        webcamEnabled: false,
        webcamId: null,
        webcamName: null,
      },
      preferencesLoaded: false,
      error: null,
    })
  })

  it("persists and reloads preferences across sessions", async () => {
    const store = useRecorderStore.getState()
    await store.savePreferences({
      profile: "balanced",
      smartZoomEnabled: true,
      smartZoomPreset: "cinematic",
      microphoneEnabled: true,
      microphoneId: "mic-1",
      microphoneName: "Custom Mic",
      systemAudioEnabled: true,
      systemAudioId: "sys-1",
      webcamEnabled: true,
      webcamId: "cam-1",
      sourceType: "region",
      regionBounds: { x: 10, y: 20, width: 800, height: 600 },
    })

    const stored = await useRecorderStore.getState().loadPreferences()
    expect(stored.profile).toBe("balanced")
    expect(stored.smartZoomEnabled).toBe(true)
    expect(stored.smartZoomPreset).toBe("cinematic")
    expect(stored.microphoneEnabled).toBe(true)
    expect(stored.microphoneId).toBe("mic-1")
    expect(stored.sourceType).toBe("region")
    expect(stored.regionBounds).toEqual({ x: 10, y: 20, width: 800, height: 600 })
  })

  it("passes persisted smart zoom settings into the recording session", async () => {
    const source = {
      kind: "display" as const,
      id: "display-0",
      name: "Display 1",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    }
    const status: RecordingStatus = {
      sessionId: "session-smart-zoom",
      state: "countdown",
      startedAt: null,
      stoppedAt: null,
      durationMs: 0,
      recordedMs: 0,
      sourceKind: "display",
      sourceName: "Display 1",
      microphoneActive: false,
      systemAudioActive: false,
      webcamActive: false,
      error: null,
    }
    const prepare = vi
      .spyOn(recorderApi, "prepareRecording")
      .mockResolvedValue("session-smart-zoom")
    vi.spyOn(recorderApi, "getRecordingStatus").mockResolvedValue(status)

    useRecorderStore.setState({
      sources: [source],
      selectedSource: source,
      preferencesLoaded: true,
      preferences: {
        ...useRecorderStore.getState().preferences,
        smartZoomEnabled: true,
        smartZoomPreset: "cinematic",
      },
    })

    await useRecorderStore.getState().start()

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        smartZoomEnabled: true,
        smartZoomPreset: "cinematic",
      }),
      3,
    )
  })

  it("waits for capture sources before starting on the first click", async () => {
    const source = {
      kind: "display" as const,
      id: "display-0",
      name: "Display 1",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    }
    const status: RecordingStatus = {
      sessionId: "session-first-click",
      state: "countdown",
      startedAt: null,
      stoppedAt: null,
      durationMs: 0,
      recordedMs: 0,
      sourceKind: "display",
      sourceName: "Display 1",
      microphoneActive: false,
      systemAudioActive: false,
      webcamActive: false,
      error: null,
    }
    vi.spyOn(recorderApi, "listCaptureSources").mockResolvedValue([source])
    const prepare = vi
      .spyOn(recorderApi, "prepareRecording")
      .mockResolvedValue("session-first-click")
    vi.spyOn(recorderApi, "getRecordingStatus").mockResolvedValue(status)

    useRecorderStore.setState({
      sources: [],
      sourcesLoaded: false,
      selectedSource: null,
      preferencesLoaded: true,
    })

    await useRecorderStore.getState().start()

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ source }), 3)
    expect(useRecorderStore.getState().status).toEqual(status)
    expect(useRecorderStore.getState().error).toBeNull()
  })

  it("automatically falls back to first available microphone when preferred mic is disconnected", async () => {
    // Simulate previously saved preferences with a disconnected mic
    storageMap.set(
      "recordforge:recordingPreferences",
      JSON.stringify({
        sourceType: "screen",
        sourceId: null,
        sourceName: null,
        regionBounds: null,
        profile: "low-impact",
        microphoneEnabled: true,
        microphoneId: "mic-disconnected-usb",
        microphoneName: "Old USB Mic",
        systemAudioEnabled: false,
        systemAudioId: null,
        systemAudioName: null,
        webcamEnabled: false,
        webcamId: null,
        webcamName: null,
      }),
    )

    const mockMics = [
      { id: "mic-built-in", name: "Realtek Audio", kind: "microphone" as const, isDefault: true },
    ]
    vi.spyOn(recorderApi, "listAudioDevices").mockResolvedValue(mockMics)

    await useRecorderStore.getState().loadAudioDevices()

    const state = useRecorderStore.getState()
    expect(state.selectedMicrophoneId).toBe("mic-built-in")
    expect(state.preferences.microphoneEnabled).toBe(true)
  })

  it("handles toggling microphone on/off with device memory", async () => {
    useRecorderStore.setState({
      audioDevices: [
        { id: "mic-1", name: "Built-in", kind: "microphone", isDefault: false },
        { id: "mic-2", name: "Studio Mic", kind: "microphone", isDefault: true },
      ],
      audioDevicesLoaded: true,
    })

    // User selects mic-1
    useRecorderStore.getState().setSelectedMicrophoneId("mic-1")
    expect(useRecorderStore.getState().selectedMicrophoneId).toBe("mic-1")
    expect(useRecorderStore.getState().preferences.microphoneEnabled).toBe(true)
    expect(useRecorderStore.getState().preferences.microphoneId).toBe("mic-1")

    // User toggles mic off
    useRecorderStore.getState().setMicrophoneEnabled(false)
    expect(useRecorderStore.getState().selectedMicrophoneId).toBe("")
    expect(useRecorderStore.getState().preferences.microphoneEnabled).toBe(false)
    // Preferred mic-1 is retained in preferences
    expect(useRecorderStore.getState().preferences.microphoneId).toBe("mic-1")

    // User toggles mic back on -> restores mic-1
    useRecorderStore.getState().setMicrophoneEnabled(true)
    expect(useRecorderStore.getState().selectedMicrophoneId).toBe("mic-1")
    expect(useRecorderStore.getState().preferences.microphoneEnabled).toBe(true)
  })

  it("tracks sourcesLoaded, profilesLoaded, and diagnosticsLoading / diagnosticsLoaded flags", async () => {
    vi.spyOn(recorderApi, "listCaptureSources").mockResolvedValue([
      {
        kind: "display",
        id: "display-0",
        name: "Display 1",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ])
    vi.spyOn(recorderApi, "listBuiltinProfiles").mockResolvedValue([
      {
        id: "balanced",
        label: "Balanced",
        width: 1920,
        height: 1080,
        fps: 30,
        encoderPriority: ["libx264"],
        audioCodec: "aac",
        audioBitrateKbps: 128,
      },
    ])
    vi.spyOn(recorderApi, "getDiagnosticsReport").mockResolvedValue({
      platform: { os: "Windows 11", ffmpegVersion: "8.1" },
      encoders: [],
      audioDevices: [],
      videoDevices: [],
    })

    expect(useRecorderStore.getState().sourcesLoaded).toBe(false)
    expect(useRecorderStore.getState().profilesLoaded).toBe(false)
    expect(useRecorderStore.getState().diagnosticsLoaded).toBe(false)

    await useRecorderStore.getState().loadSources()
    expect(useRecorderStore.getState().sourcesLoaded).toBe(true)
    expect(useRecorderStore.getState().sources.length).toBe(1)

    await useRecorderStore.getState().loadProfiles()
    expect(useRecorderStore.getState().profilesLoaded).toBe(true)
    expect(useRecorderStore.getState().profiles.length).toBe(1)

    await useRecorderStore.getState().loadDiagnostics()
    expect(useRecorderStore.getState().diagnosticsLoading).toBe(false)
    expect(useRecorderStore.getState().diagnosticsLoaded).toBe(true)
    expect(useRecorderStore.getState().diagnostics?.platform.os).toBe("Windows 11")
  })
})
