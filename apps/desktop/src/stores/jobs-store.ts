import { create } from "zustand"
import type { MediaJob, PrepareMediaOptions } from "@recordforge/contracts"
import {
  cancelMediaJob,
  deleteDerivatives,
  getMediaJob,
  listMediaJobs,
  onMediaJobUpdate,
  prepareMedia,
} from "../lib/media"

interface JobsStore {
  jobs: MediaJob[]
  isListening: boolean
  unlisten: (() => void) | null

  setJobs: (jobs: MediaJob[]) => void
  upsertJob: (job: MediaJob) => void
  removeJob: (jobId: string) => void

  startListening: () => Promise<void>
  stopListening: () => void

  prepare: (options: PrepareMediaOptions) => Promise<MediaJob>
  prepareWithOptions: (
    recordingId: string,
    options: { force: boolean; thumbnailIntervalSec: number },
  ) => Promise<MediaJob>
  cancel: (jobId: string) => Promise<void>
  cleanup: (recordingId: string) => Promise<void>
  loadForRecording: (recordingId: string) => Promise<void>
  getJob: (jobId: string) => Promise<MediaJob | undefined>
}

export const useJobsStore = create<JobsStore>((set, get) => ({
  jobs: [],
  isListening: false,
  unlisten: null,

  setJobs: (jobs) => set({ jobs }),

  upsertJob: (job) => {
    set((state) => {
      const existing = state.jobs.findIndex((j) => j.id === job.id)
      if (existing >= 0) {
        const next = [...state.jobs]
        next[existing] = job
        return { jobs: next }
      }
      return { jobs: [job, ...state.jobs] }
    })
  },

  removeJob: (jobId) => {
    set((state) => ({ jobs: state.jobs.filter((j) => j.id !== jobId) }))
  },

  startListening: async () => {
    if (get().isListening) return
    const unlisten = await onMediaJobUpdate((job) => {
      get().upsertJob(job)
    })
    set({ isListening: true, unlisten })
  },

  stopListening: () => {
    const { unlisten, isListening } = get()
    if (!isListening) return
    if (unlisten) {
      unlisten()
    }
    set({ isListening: false, unlisten: null })
  },

  prepare: async (options) => {
    const job = await prepareMedia(options)
    get().upsertJob(job)
    return job
  },

  prepareWithOptions: async (recordingId, options) => {
    const job = await prepareMedia({
      recordingId,
      proxyHeight: 540,
      thumbnailIntervalSec: options.thumbnailIntervalSec,
      force: options.force,
    })
    get().upsertJob(job)
    return job
  },

  cancel: async (jobId) => {
    await cancelMediaJob(jobId)
    const job = await getMediaJob(jobId)
    get().upsertJob(job)
  },

  cleanup: async (recordingId) => {
    await deleteDerivatives(recordingId)
    const jobs = await listMediaJobs(recordingId)
    set((state) => {
      const others = state.jobs.filter((j) => j.recordingId !== recordingId)
      return { jobs: [...jobs, ...others] }
    })
  },

  loadForRecording: async (recordingId) => {
    const jobs = await listMediaJobs(recordingId)
    set((state) => {
      const others = state.jobs.filter((j) => j.recordingId !== recordingId)
      return { jobs: [...jobs, ...others] }
    })
  },

  getJob: async (jobId) => {
    const local = get().jobs.find((j) => j.id === jobId)
    if (local) return local
    try {
      return await getMediaJob(jobId)
    } catch {
      return undefined
    }
  },
}))
