import { create } from "zustand"

interface EditorStore {
  recordingId: string | null
  open: (recordingId: string) => void
  close: () => void
}

export const useEditorStore = create<EditorStore>((set) => ({
  recordingId: null,
  open: (recordingId) => set({ recordingId }),
  close: () => set({ recordingId: null }),
}))
