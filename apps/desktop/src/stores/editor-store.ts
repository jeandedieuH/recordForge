import { create } from "zustand"
import type { recordForgeProject } from "@recordforge/contracts"

export type SaveStatus = "idle" | "saving" | "saved" | "error"

interface EditorStore {
  project: recordForgeProject | null
  recordingId: string | null
  saveStatus: SaveStatus
  saveError: string | null
  isDirty: boolean
  missingAssets: string[]

  open: (recordingId: string, project?: recordForgeProject | null) => void
  close: () => void
  setProject: (project: recordForgeProject) => void
  setSaveStatus: (status: SaveStatus, error?: string | null) => void
  setDirty: (dirty: boolean) => void
  setMissingAssets: (assetIds: string[]) => void
}

export const useEditorStore = create<EditorStore>((set) => ({
  project: null,
  recordingId: null,
  saveStatus: "idle",
  saveError: null,
  isDirty: false,
  missingAssets: [],

  open: (recordingId, project) =>
    set({
      recordingId,
      project,
      saveStatus: "saved",
      saveError: null,
      isDirty: false,
      missingAssets: [],
    }),

  close: () =>
    set({
      project: null,
      recordingId: null,
      saveStatus: "idle",
      saveError: null,
      isDirty: false,
      missingAssets: [],
    }),

  setProject: (project) =>
    set({
      project,
      isDirty: false,
      saveStatus: "saved",
      saveError: null,
    }),

  setSaveStatus: (status, error = null) =>
    set({
      saveStatus: status,
      saveError: error,
    }),

  setDirty: (dirty) => set({ isDirty: dirty }),

  setMissingAssets: (assetIds) => set({ missingAssets: assetIds }),
}))
