import { create } from "zustand"
import type { ProjectSummary } from "@recordforge/contracts"
import {
  deleteProject,
  duplicateProject,
  listProjects,
  renameProject,
} from "../../lib/project"
import { revealRecording } from "../../lib/library"
import { toErrorMessage } from "../../lib/errors"

export type ProjectSort = "updated" | "newest" | "name" | "duration"

interface ProjectsStore {
  projects: ProjectSummary[]
  isLoading: boolean
  error: string | null
  search: string
  sort: ProjectSort

  setSearch: (search: string) => void
  setSort: (sort: ProjectSort) => void
  clearError: () => void

  load: () => Promise<void>
  rename: (recordingId: string, newName: string) => Promise<void>
  duplicate: (recordingId: string, newName?: string) => Promise<void>
  delete: (recordingId: string) => Promise<void>
  reveal: (recordingId: string) => Promise<void>
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  isLoading: false,
  error: null,
  search: "",
  sort: "updated",

  setSearch: (search) => set({ search }),
  setSort: (sort) => set({ sort }),
  clearError: () => set({ error: null }),

  load: async () => {
    set({ isLoading: true, error: null })
    try {
      const projects = await listProjects()
      set({ projects, isLoading: false, error: null })
    } catch (error) {
      set({ error: toErrorMessage(error), isLoading: false })
    }
  },

  rename: async (recordingId, newName) => {
    try {
      await renameProject(recordingId, newName)
      await get().load()
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  duplicate: async (recordingId, newName) => {
    try {
      await duplicateProject(recordingId, newName)
      await get().load()
    } catch (error) {
      set({ error: toErrorMessage(error) })
    }
  },

  delete: async (recordingId) => {
    set({ isLoading: true, error: null })
    try {
      await deleteProject(recordingId)
      const projects = await listProjects()
      set({ projects, isLoading: false, error: null })
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
}))
