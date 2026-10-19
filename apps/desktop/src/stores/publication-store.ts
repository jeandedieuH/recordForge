import { create } from "zustand"
import type { PublicationJob, PublicationProvider, PublicationStatus } from "@recordforge/contracts"
import { publicationJobIsActive } from "@recordforge/contracts"
import { cancelPublicationJob, listPublicationJobs } from "../lib/share"
import { onPublicationJobUpdate } from "../lib/publish"

interface PublicationStore {
  jobs: PublicationJob[]
  isListening: boolean

  upsertJob: (job: PublicationJob) => void
  /** Latest cached snapshot for a job id. */
  jobById: (jobId: string) => PublicationJob | undefined
  /** Newest job for one export — provider-filtered when given so a hosted
   * share for the same file never masquerades as the YouTube publication. */
  jobForExport: (exportJobId: string, provider?: PublicationProvider) => PublicationJob | undefined
  /** The provider's active operation, when one is running. */
  activeForProvider: (provider: string) => PublicationJob | undefined

  startListening: () => Promise<void>
  stopListening: () => void
  refresh: () => Promise<void>
  cancel: (jobId: string) => Promise<void>
}

// Fan-out listeners (toasts, delivery cards) subscribe here instead of
// opening extra Tauri listeners.
const jobListeners = new Set<(job: PublicationJob) => void>()

export function subscribePublicationJobs(listener: (job: PublicationJob) => void): () => void {
  jobListeners.add(listener)
  return () => jobListeners.delete(listener)
}

let listenPromise: Promise<void> | null = null
let listeningDesired = false

// Monotonic lifecycle ranks — a stale snapshot may never move a job
// backwards (e.g. a `refresh` list racing a terminal event, or a replayed
// event). Terminal states share one rank: one worker owns each job row, so
// equal-rank terminal updates are legitimate final writes, not regressions.
const STATUS_RANK: Record<PublicationStatus, number> = {
  checking: 0,
  uploading: 1,
  finalizing: 2,
  attachingCaptions: 3,
  cancelling: 4,
  completed: 5,
  failed: 5,
  cancelled: 5,
  uncertain: 5,
}

function acceptUpdate(next: PublicationJob, previous: PublicationJob | undefined): boolean {
  return !previous || STATUS_RANK[next.status] >= STATUS_RANK[previous.status]
}

export const usePublicationStore = create<PublicationStore>((set, get) => ({
  jobs: [],
  isListening: false,

  upsertJob: (job) => {
    let accepted = false
    set((state) => {
      const index = state.jobs.findIndex((j) => j.id === job.id)
      const previous = index >= 0 ? state.jobs[index] : undefined
      if (!acceptUpdate(job, previous)) return state
      accepted = true
      if (index >= 0) {
        const next = [...state.jobs]
        next[index] = job
        return { jobs: next }
      }
      return { jobs: [job, ...state.jobs] }
    })
    // Only the accepted snapshot fans out — a dropped stale event must not
    // reach toasts/cards as if it were current.
    if (accepted) jobListeners.forEach((listener) => listener(job))
  },

  jobById: (jobId) => get().jobs.find((j) => j.id === jobId),

  jobForExport: (exportJobId, provider) =>
    get().jobs.find((j) => j.exportJobId === exportJobId && (!provider || j.provider === provider)),

  activeForProvider: (provider) =>
    get().jobs.find((j) => j.provider === provider && publicationJobIsActive(j)),

  startListening: async () => {
    if (get().isListening) return
    listeningDesired = true
    if (listenPromise) return listenPromise
    const promise = (async () => {
      try {
        const unlisten = await onPublicationJobUpdate((job) => {
          get().upsertJob(job)
        })
        if (!listeningDesired) {
          unlisten()
          return
        }
        set({ isListening: true })
        // Stash the teardown for stopListening.
        currentUnlisten = unlisten
      } finally {
        listenPromise = null
      }
    })()
    listenPromise = promise
    await promise
  },

  stopListening: () => {
    listeningDesired = false
    if (currentUnlisten) {
      currentUnlisten()
      currentUnlisten = null
    }
    set({ isListening: false })
  },

  refresh: async () => {
    const incoming = await listPublicationJobs()
    // Merge, don't replace — a job that advanced via an event between the
    // request and this response keeps its newer state.
    set((state) => {
      const byId = new Map(state.jobs.map((j) => [j.id, j]))
      const merged = incoming.map((job) => {
        const previous = byId.get(job.id)
        byId.delete(job.id)
        return previous && STATUS_RANK[previous.status] > STATUS_RANK[job.status] ? previous : job
      })
      return { jobs: [...merged, ...byId.values()] }
    })
  },

  cancel: async (jobId) => {
    const job = await cancelPublicationJob(jobId)
    get().upsertJob(job)
  },
}))

let currentUnlisten: (() => void) | null = null
