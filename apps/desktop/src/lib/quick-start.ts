/**
 * Global-shortcut / tray start.
 *
 * The native shortcut handler only asks the UI to run this, so the shortcut and
 * the dialog's Start button share one code path and cannot diverge. (The bug
 * this replaced: the shortcut started a session from the last quick config,
 * replaying stale device selections and skipping the countdown.)
 */
export const DEVICE_RELEASE_DELAY_MS = 400

export interface QuickStartDeps {
  /** A start is already in flight — ignore the repeated shortcut/tray press. */
  isStartPending: boolean
  /** Camera mode, or a screen recording with the webcam sidecar enabled. */
  needsDeviceRelease: boolean
  /** Dismiss the setup dialog so its live preview tracks are stopped. */
  closeSetup: () => void
  /** Close any open editor session, then run the normal store start. */
  start: () => Promise<void>
  onError: (cause: unknown) => void
  /** Injected in tests; defaults to a real timer. */
  wait?: (ms: number) => Promise<void>
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export async function runQuickStart(deps: QuickStartDeps): Promise<void> {
  if (deps.isStartPending) return

  // Closing the dialog stops the camera preview; the device needs a moment
  // before FFmpeg can reopen it.
  deps.closeSetup()
  if (deps.needsDeviceRelease) {
    await (deps.wait ?? defaultWait)(DEVICE_RELEASE_DELAY_MS)
  }

  try {
    await deps.start()
  } catch (cause) {
    // Guard failures (unsaved editor changes) surface as a toast, not an
    // unhandled rejection from the shortcut path.
    deps.onError(cause)
  }
}
