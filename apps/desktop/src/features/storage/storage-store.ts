import { create } from "zustand"
import { listen } from "@tauri-apps/api/event"
import type { StorageProfile, UploadJob, StartUploadJobInput } from "@recordforge/contracts"
import {
  cancelUploadJob,
  deleteStorageProfile,
  deleteUploadJob,
  listStorageProfiles,
  listUploadJobs,
  retryUploadJob,
  startUploadJob,
} from "./storage-api"

interface StorageState {
  profiles: StorageProfile[]
  jobs: UploadJob[]
  isLoadingProfiles: boolean
  isLoadingJobs: boolean
  error: string | null

  fetchProfiles: () => Promise<void>
  fetchJobs: () => Promise<void>
  deleteProfile: (id: string) => Promise<void>
  startUpload: (input: StartUploadJobInput) => Promise<UploadJob>
  cancelUpload: (jobId: string) => Promise<void>
  retryUpload: (jobId: string) => Promise<void>
  deleteJob: (jobId: string) => Promise<void>
  initListeners: () => () => void
}

export const useStorageStore = create<StorageState>((set) => ({
  profiles: [],
  jobs: [],
  isLoadingProfiles: false,
  isLoadingJobs: false,
  error: null,

  fetchProfiles: async () => {
    set({ isLoadingProfiles: true, error: null })
    try {
      const profiles = await listStorageProfiles()
      set({ profiles, isLoadingProfiles: false })
    } catch (err) {
      set({
        isLoadingProfiles: false,
        error: err instanceof Error ? err.message : "Failed to load storage profiles",
      })
    }
  },

  fetchJobs: async () => {
    set({ isLoadingJobs: true })
    try {
      const jobs = await listUploadJobs()
      set({ jobs, isLoadingJobs: false })
    } catch {
      set({ isLoadingJobs: false })
    }
  },

  deleteProfile: async (id: string) => {
    await deleteStorageProfile(id)
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id),
    }))
  },

  startUpload: async (input: StartUploadJobInput) => {
    const job = await startUploadJob(input)
    set((state) => ({
      jobs: [job, ...state.jobs.filter((j) => j.id !== job.id)],
    }))
    return job
  },

  cancelUpload: async (jobId: string) => {
    await cancelUploadJob(jobId)
    set((state) => ({
      jobs: state.jobs.map((j) => (j.id === jobId ? { ...j, state: "cancelled" } : j)),
    }))
  },

  retryUpload: async (jobId: string) => {
    const job = await retryUploadJob(jobId)
    set((state) => ({
      jobs: [job, ...state.jobs.filter((j) => j.id !== job.id)],
    }))
  },

  deleteJob: async (jobId: string) => {
    await deleteUploadJob(jobId)
    set((state) => ({
      jobs: state.jobs.filter((j) => j.id !== jobId),
    }))
  },

  initListeners: () => {
    let unlistenFn: (() => void) | null = null

    listen<UploadJob>("upload-job-update", (event) => {
      const updatedJob = event.payload
      set((state) => {
        const exists = state.jobs.some((j) => j.id === updatedJob.id)
        if (exists) {
          return {
            jobs: state.jobs.map((j) => (j.id === updatedJob.id ? updatedJob : j)),
          }
        }
        return {
          jobs: [updatedJob, ...state.jobs],
        }
      })
    }).then((unlisten) => {
      unlistenFn = unlisten
    })

    return () => {
      if (unlistenFn) {
        unlistenFn()
      }
    }
  },
}))
