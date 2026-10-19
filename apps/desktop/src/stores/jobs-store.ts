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
  /** True when the snapshot was merged into the cache — false for a stale
   * same-id event that lost to a newer version already stored. */
  upsertJob: (job: MediaJob) => boolean
  removeJob: (jobId: string) => void
  // Fan-out for the single native event subscription — consumers (timeline
  // store) register here instead of opening a second Tauri listener.
  subscribeJobEvents: (listener: (job: MediaJob) => void) => () => void
  // Latest cached snapshot for a job id — admission RPCs return pending
  // snapshots that may arrive after running/completed events.
  jobById: (jobId: string) => MediaJob | undefined

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

// Same-id events are merged by VERSION, not a forward-only status order —
// a durable retry legitimately goes failed/cancelled → pending. The tuple is
// (attempts, updatedAt at full RFC3339 precision, status rank): a retry's
// pending snapshot carries a newer updatedAt before `start_job` bumps
// attempts, so it wins; a stale admission RPC or a previous attempt's
// terminal event loses.
const JOB_STATUS_RANK: Record<string, number> = {
  pending: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
}

const RFC3339_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/

// RFC3339 → integer epoch nanoseconds. Date.parse truncates to milliseconds,
// so the fractional digits are normalized to 0..9 digits and added back —
// SQLite emits distinct sub-ms updated_at values on rapid retry sequences.
export function updatedAtToNs(iso: string): bigint {
  const match = RFC3339_RE.exec(iso)
  if (!match) return 0n
  const ms = Date.parse(`${match[1]}${match[3]}`)
  if (!Number.isFinite(ms)) return 0n
  const frac = (match[2] ?? "").slice(0, 9).padEnd(9, "0")
  const fracNs = match[2] ? BigInt(frac) : 0n
  return BigInt(Math.trunc(ms / 1000)) * 1_000_000_000n + fracNs
}

// Lexicographic (attempts, updatedAtNs, statusRank) — >= allows equal-version
// snapshots to replace (idempotent replays of the same persisted row).
export function jobSnapshotIsNewerOrEqual(incoming: MediaJob, current: MediaJob): boolean {
  const attemptsA = incoming.attempts ?? 0
  const attemptsB = current.attempts ?? 0
  if (attemptsA !== attemptsB) return attemptsA > attemptsB
  const updatedA = updatedAtToNs(incoming.updatedAt)
  const updatedB = updatedAtToNs(current.updatedAt)
  if (updatedA !== updatedB) return updatedA > updatedB
  return (JOB_STATUS_RANK[incoming.status] ?? 0) >= (JOB_STATUS_RANK[current.status] ?? 0)
}

const jobEventListeners = new Set<(job: MediaJob) => void>()

// startListening is single-flight against the NATIVE subscription. Desired
// state is tracked separately from the pending registration so a
// setup→cleanup→setup (StrictMode) sequence ends with exactly one installed
// listener: a pending registration re-checks `listeningDesired` when it
// resolves, and a start that arrives while a torn-down registration is still
// pending reuses it only when desired stays true.
let listenPromise: Promise<void> | null = null
let listeningDesired = false

export const useJobsStore = create<JobsStore>((set, get) => ({
  jobs: [],
  isListening: false,
  unlisten: null,

  setJobs: (jobs) => set({ jobs }),

  upsertJob: (job) => {
    let accepted = false
    set((state) => {
      const existing = state.jobs.findIndex((j) => j.id === job.id)
      if (existing >= 0) {
        const current = state.jobs[existing]
        if (!jobSnapshotIsNewerOrEqual(job, current)) {
          return { jobs: state.jobs }
        }
        const next = [...state.jobs]
        next[existing] = job
        accepted = true
        return { jobs: next }
      }
      accepted = true
      return { jobs: [job, ...state.jobs] }
    })
    return accepted
  },

  removeJob: (jobId) => {
    set((state) => ({ jobs: state.jobs.filter((j) => j.id !== jobId) }))
  },

  subscribeJobEvents: (listener) => {
    jobEventListeners.add(listener)
    return () => jobEventListeners.delete(listener)
  },

  jobById: (jobId) => get().jobs.find((j) => j.id === jobId),

  startListening: async () => {
    if (get().isListening) return
    // Reuse a still-pending registration — its resolution consults the
    // desired flag, so a StrictMode restart during registration ends with
    // the single listener this registration installs.
    listeningDesired = true
    if (listenPromise) return listenPromise
    const promise = (async () => {
      try {
        const unlisten = await onMediaJobUpdate((job) => {
          // Only the accepted snapshot fans out — an ignored stale event
          // must not reach consumers as if it were current.
          if (get().upsertJob(job)) {
            jobEventListeners.forEach((listener) => listener(job))
          }
        })
        if (!listeningDesired || get().isListening) {
          // Stopped (or another path already registered) while the native
          // listen was in flight — tear this one down instead of leaking.
          unlisten()
          return
        }
        set({ isListening: true, unlisten })
      } finally {
        listenPromise = null
      }
    })()
    listenPromise = promise
    await promise
  },

  stopListening: () => {
    // Marks any in-flight registration for teardown when it resolves.
    listeningDesired = false
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
      includeProxy: false,
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
