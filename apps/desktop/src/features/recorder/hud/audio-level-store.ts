import { create } from "zustand"

// Raw per-channel peaks from the Rust `recorder-audio-level` event
// (peak-since-last-read at ~12 Hz). Kept in its own tiny store so the meter
// re-renders without re-rendering the whole HUD.
export interface AudioLevelState {
  microphone: number | null
  systemAudio: number | null
  // Timestamp (ms) of the last event — staleness detection for the meter.
  updatedAt: number
  update: (levels: { microphone: number | null; systemAudio: number | null }) => void
  // Reset when the session changes or stops so a stale peak never lingers.
  reset: () => void
}

export const useAudioLevelStore = create<AudioLevelState>()((set) => ({
  microphone: null,
  systemAudio: null,
  updatedAt: 0,
  update: ({ microphone, systemAudio }) => set({ microphone, systemAudio, updatedAt: Date.now() }),
  reset: () => set({ microphone: null, systemAudio: null, updatedAt: 0 }),
}))
