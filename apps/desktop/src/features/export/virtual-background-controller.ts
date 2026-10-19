import { toErrorMessage } from "../../lib/errors"

// Virtual-background status/download lifecycle — the card binds this to
// React state. Async ownership lives here so rapid clicks, stale status
// responses, and unmounted-completion are testable without the DOM.
export interface VirtualBackgroundControllerDeps {
  getStatus: () => Promise<{ modelReady: boolean }>
  download: () => Promise<void>
  onProgress: (
    listener: (progress: { downloadedBytes: number; totalBytes: number }) => void,
  ) => Promise<() => void>
  toast: (toast: {
    variant?: "default" | "error" | "warning"
    title: string
    description?: string
  }) => void
  hooks: {
    modelReady(value: boolean | null): void
    statusError(message: string | null): void
    downloadRatio(ratio: number | "indeterminate" | null): void
  }
}

export interface VirtualBackgroundController {
  /** Effect setup: re-arms mounted and runs the initial status probe. */
  mount(): void
  /** Effect cleanup: later status/download writes are discarded. */
  unmount(): void
  retryStatus(): void
  /** Synchronous in-flight guard — a rapid second call never starts a
   *  second native download even before the first await completes. */
  startDownload(): Promise<void>
}

export function createVirtualBackgroundController(
  deps: VirtualBackgroundControllerDeps,
): VirtualBackgroundController {
  let mounted = false
  let downloadInFlight = false
  // Status request generation — only the newest probe may write state, so a
  // late failure can't clobber a completed retry (or vice versa).
  let statusRequest = 0
  // The progress listener's unlisten fn once registered — cleaned up on
  // download end AND on unmount so a destroyed card can't leak the event.
  let unlistenProgress: (() => void) | null = null
  const cleanupProgress = () => {
    unlistenProgress?.()
    unlistenProgress = null
  }

  function probe() {
    const request = ++statusRequest
    deps.hooks.statusError(null)
    deps.hooks.modelReady(null)
    deps
      .getStatus()
      .then((status) => {
        if (mounted && statusRequest === request) {
          deps.hooks.modelReady(status.modelReady)
        }
      })
      .catch((error) => {
        if (mounted && statusRequest === request) {
          deps.hooks.statusError(toErrorMessage(error))
        }
      })
  }

  return {
    mount() {
      mounted = true
      probe()
    },
    unmount() {
      mounted = false
      statusRequest += 1
      cleanupProgress()
    },
    retryStatus: probe,
    async startDownload() {
      // Flips before the first await — render state can read null
      // mid-download (unknown total), so it can't be the guard.
      if (downloadInFlight) return
      downloadInFlight = true
      deps.hooks.downloadRatio(0)
      try {
        const unlisten = await deps.onProgress((progress) => {
          if (!mounted) return
          deps.hooks.downloadRatio(
            progress.totalBytes > 0
              ? progress.downloadedBytes / progress.totalBytes
              : "indeterminate",
          )
        })
        unlistenProgress = unlisten
        // The component unmounted while registration was pending — release
        // the fresh listener immediately instead of leaking it.
        if (!mounted) cleanupProgress()
        try {
          await deps.download()
          if (mounted) {
            // A status probe issued before the download may still be in
            // flight — invalidate it so its stale `false` can't overwrite
            // the freshly known `true`.
            statusRequest += 1
            deps.hooks.modelReady(true)
          }
        } finally {
          cleanupProgress()
        }
      } catch (error) {
        if (mounted) {
          deps.toast({
            variant: "error",
            title: "Model download failed",
            description: toErrorMessage(error),
          })
        }
      } finally {
        downloadInFlight = false
        if (mounted) deps.hooks.downloadRatio(null)
      }
    },
  }
}
