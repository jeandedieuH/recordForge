import { create } from "zustand"
import type { ExportOptions, LibraryRecording, TrimOptions } from "@recordforge/contracts"
import {
  addRecordingTag,
  deleteRecording,
  exportRecording,
  listRecordings,
  removeRecordingTag,
  revealRecording,
  trimRecording,
} from "../../lib/library"
import { toErrorMessage } from "../../lib/errors"

export type LibrarySort = "newest" | "oldest" | "duration" | "size"

interface LibraryStore {
  recordings: LibraryRecording[]
  isLoading: boolean
  error: string | null
  search: string
  sort: LibrarySort
  tagFilter: string

  setSearch: (search: string) => void
  setSort: (sort: LibrarySort) => void
  setTagFilter: (tag: string) => void
  clearError: () => void

  load: () => Promise<void>
  delete: (recordingId: string) => Promise<void>
  reveal: (recordingId: string) => Promise<void>
  trim: (options: TrimOptions) => Promise<void>
  export: (options: ExportOptions) => Promise<void>
  addTag: (recordingId: string, tag: string) => Promise<void>
  removeTag: (recordingId: string, tag: string) => Promise<void>
}

export const useLibraryStore = create<LibraryStore>((set) => ({
  recordings: [],
  isLoading: false,
  error: null,
  search: "",
  sort: "newest",
  tagFilter: "",

  setSearch: (search) => set({ search }),
  setSort: (sort) => set({ sort }),
  setTagFilter: (tag) => set({ tagFilter: tag }),
  clearError: () => set({ error: null }),

  load: async () => {
    set({ isLoading: true, error: null })
    try {
      const recordings = await listRecordings()
      console.log("[library] loaded recordings:", recordings.length, recordings)
      set({ recordings, isLoading: false, error: null })
    } catch (error) {
      console.error("[library] failed to load recordings:", error)
      set({ error: toErrorMessage(error), isLoading: false })
    }
  },

  delete: async (recordingId) => {
    set({ isLoading: true, error: null })
    try {
      await deleteRecording(recordingId)
      const recordings = await listRecordings()
      set({ recordings, isLoading: false, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false })
    }
  },

  reveal: async (recordingId) => {
    try {
      await revealRecording(recordingId)
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  trim: async (options) => {
    set({ isLoading: true, error: null })
    try {
      await trimRecording(options)
      const recordings = await listRecordings()
      set({ recordings, isLoading: false, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false })
    }
  },

  export: async (options) => {
    set({ isLoading: true, error: null })
    try {
      await exportRecording(options)
      set({ isLoading: false, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false })
    }
  },

  addTag: async (recordingId, tag) => {
    try {
      await addRecordingTag(recordingId, tag)
      const recordings = await listRecordings()
      set({ recordings })
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  removeTag: async (recordingId, tag) => {
    try {
      await removeRecordingTag(recordingId, tag)
      const recordings = await listRecordings()
      set({ recordings })
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },
}))
