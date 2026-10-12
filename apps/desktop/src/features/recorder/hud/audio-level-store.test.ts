import { beforeEach, describe, expect, it } from "vitest"
import { useAudioLevelStore } from "./audio-level-store"

describe("audio-level-store", () => {
  beforeEach(() => useAudioLevelStore.getState().reset())

  it("stores raw channel peaks with a timestamp", () => {
    useAudioLevelStore.getState().update({ microphone: 0.4, systemAudio: null })
    const s = useAudioLevelStore.getState()
    expect(s.microphone).toBe(0.4)
    expect(s.systemAudio).toBeNull()
    expect(s.updatedAt).toBeGreaterThan(0)
  })

  it("resets on session stop", () => {
    useAudioLevelStore.getState().update({ microphone: 0.4, systemAudio: 0.2 })
    useAudioLevelStore.getState().reset()
    const s = useAudioLevelStore.getState()
    expect(s.microphone).toBeNull()
    expect(s.systemAudio).toBeNull()
    expect(s.updatedAt).toBe(0)
  })
})
