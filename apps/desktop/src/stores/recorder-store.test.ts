import { beforeEach, describe, expect, it, vi } from "vitest"
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
      audioDevices: [],
      audioDevicesLoaded: false,
      videoDevices: [],
      videoDevicesLoaded: false,
      profiles: [],
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
    expect(stored.microphoneEnabled).toBe(true)
    expect(stored.microphoneId).toBe("mic-1")
    expect(stored.sourceType).toBe("region")
    expect(stored.regionBounds).toEqual({ x: 10, y: 20, width: 800, height: 600 })
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
})
