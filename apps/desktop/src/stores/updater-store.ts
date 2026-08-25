import { create } from "zustand"
import type { UpdateDownloadEvent, UpdateMetadata, UpdateReadiness } from "@recordforge/contracts"
import { toErrorMessage } from "../lib/errors"
import {
  beginUpdateInstall,
  cancelUpdateInstall,
  checkForUpdate as fetchUpdate,
  downloadUpdate,
  getUpdateReadiness,
  hasDownloadedUpdate,
  installDownloadedUpdate,
} from "../lib/updater"

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "preparing"
  | "downloading"
  | "blocked"
  | "installing"
  | "error"

export interface UpdaterStore {
  status: UpdaterStatus
  update: UpdateMetadata | null
  readiness: UpdateReadiness | null
  errorMessage: string | null
  downloadedBytes: number
  contentLength: number | null
  isDownloaded: boolean
  notifiedVersion: string | null
  checkForUpdate: () => Promise<UpdateMetadata | null>
  installUpdate: (onBeforeInstall?: () => Promise<void>) => Promise<void>
  markUpdateNotified: (version: string) => void
}

const INITIAL_STATE = {
  status: "idle" as UpdaterStatus,
  update: null,
  readiness: null,
  errorMessage: null,
  downloadedBytes: 0,
  contentLength: null,
  isDownloaded: false,
  notifiedVersion: null,
}

let checkPromise: Promise<UpdateMetadata | null> | null = null
let installPromise: Promise<void> | null = null

export const useUpdaterStore = create<UpdaterStore>((set, get) => ({
  ...INITIAL_STATE,

  checkForUpdate: () => {
    const current = get()
    if (
      current.isDownloaded ||
      ["downloading", "preparing", "installing"].includes(current.status)
    ) {
      return Promise.resolve(current.update)
    }
    if (checkPromise) return checkPromise

    const run = (async () => {
      set({ status: "checking", errorMessage: null, readiness: null })
      try {
        const update = await fetchUpdate()
        set({
          status: update ? "available" : "up-to-date",
          update,
          errorMessage: null,
          readiness: null,
          downloadedBytes: 0,
          contentLength: null,
          isDownloaded: hasDownloadedUpdate(),
        })
        return update
      } catch (error) {
        set({ status: "error", errorMessage: toErrorMessage(error) })
        return null
      } finally {
        checkPromise = null
      }
    })()

    checkPromise = run
    return run
  },

  installUpdate: (onBeforeInstall) => {
    if (installPromise) return installPromise

    const run = (async () => {
      const update = get().update
      if (!update) {
        set({ status: "error", errorMessage: "No update is available." })
        return
      }

      try {
        set({ status: "preparing", errorMessage: null, readiness: null })
        await onBeforeInstall?.()

        const initialReadiness = await getUpdateReadiness()
        set({ readiness: initialReadiness })
        if (!initialReadiness.canInstall) {
          set({ status: "blocked" })
          return
        }

        if (!get().isDownloaded) {
          set({ status: "downloading", downloadedBytes: 0, contentLength: null })
          await downloadUpdate((event) => applyDownloadEvent(set, event))
          set({ isDownloaded: true, status: "preparing" })
        }

        const readiness = await beginUpdateInstall()
        set({ readiness })
        if (!readiness.canInstall) {
          set({ status: "blocked" })
          return
        }

        set({ status: "installing" })
        await installDownloadedUpdate()
        set({
          status: "up-to-date",
          update: null,
          readiness: null,
          isDownloaded: false,
          downloadedBytes: 0,
          contentLength: null,
        })
      } catch (error) {
        await cancelUpdateInstall().catch(() => undefined)
        set({ status: "error", errorMessage: toErrorMessage(error) })
      } finally {
        installPromise = null
      }
    })()

    installPromise = run
    return run
  },

  markUpdateNotified: (version) => set({ notifiedVersion: version }),
}))

function applyDownloadEvent(
  set: (partial: Partial<UpdaterStore>) => void,
  event: UpdateDownloadEvent,
): void {
  if (event.event === "Started") {
    set({
      downloadedBytes: 0,
      contentLength: event.data.contentLength ?? null,
    })
    return
  }

  if (event.event === "Progress") {
    const current = useUpdaterStore.getState().downloadedBytes
    set({ downloadedBytes: current + event.data.chunkLength })
  }
}
