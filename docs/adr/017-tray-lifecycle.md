# ADR 017: Tray-Owned App Lifecycle

## Status

Accepted

## Context

RecordForge is a recorder-first app, so it has to keep running after the main
window is closed: recordings, exports, uploads, and the updater outlive the
window. The tray icon is the only surface left once the window is hidden.

Three failures followed from the previous implementation:

- Close-to-tray was opt-in and defaulted off, and the close handler fell back
  to the unrelated `startMinimized` key. With a teleprompter or floating
  toolbar open, a real close kept the process alive with no obvious way back.
- Tray creation failures were swallowed. If registration failed (for example
  when the app starts before Explorer is ready), the app could still hide its
  window on close, leaving a running process with no tray icon.
- Nothing prevented a second process from starting. A second launch added a
  second tray icon and a second holder of the executable, which is exactly what
  makes the NSIS installer report that the app is still running.

The updater must also always be able to terminate the app: the Windows
installer launches the old process, waits for its executable to be released,
and only then replaces the binary.

A separate installer-level failure was observed on machines with McAfee: the
Windows Restart Manager reports `McAfee Framework Host` as an `RmCritical`
process holding `recordforge-desktop.exe`, so `RmShutdown` returns
`ERROR_FAIL_NOACTION_REBOOT` (350) even when RecordForge is not running. Tauri's
NSIS template aborts with "Failed to kill RecordForge" and a reboot is the only
way to release the handle (tauri-apps/tauri#16277).

## Decision

- **Single instance.** `tauri-plugin-single-instance` is registered first; a
  second launch restores the existing main window and the new process exits.
- **Tray availability gates hiding.** `tray::is_available` is checked on every
  close. The window is hidden only while a tray icon exists, so a failed
  registration degrades to a normal quit rather than an invisible process. If a
  recording is live but no tray icon exists, the window minimizes to the
  taskbar instead of ending the session.
- **Close-to-tray is the default.** `minimizeToTray` unset/unreadable means
  "hide to tray"; only an explicit `false` opts out. The legacy
  `startMinimized` fallback is no longer consulted on close.
- **Active recordings never close the window.** While the recorder is outside
  idle/completed/failed, a close parks the window in the tray even when the
  setting is off, so a click cannot discard a session.
- **Real closes end the process.** When the close is not converted into a tray
  hide, `WindowEvent::Destroyed` calls `app.exit(0)` — auxiliary windows cannot
  keep the process (and its locked executable) alive.
- **Update installs bypass tray hiding.** While `UpdateGate.installing` is set,
  close requests and shutdown proceed; the installer owns the exit.
- **Tray Quit is graceful.** Quit from the tray menu closes the main window
  through the same path as the titlebar, so the editor's webview close guard can
  flush unsaved work; the close is forced to exit even with close-to-tray on.
- **Tray creation is retried once** after two seconds and falls back to the
  bundled 32×32 icon when no window icon is available.
- **First close-to-tray is announced.** The first time a close is converted
  into a tray hide, Rust shows a native OS notification ("RecordForge is still
  running") and records `trayHintShown` in settings so it never repeats. The
  notification is native rather than `window.Notification` so it also appears
  while the webview is minimized.
- **NSIS installer hook neutralizes the Restart Manager dead end.**
  `src-tauri/installer-hooks.nsh` (`bundle.windows.nsis.installerHooks`) runs
  before the template's check: it closes a current-user RecordForge, waits for
  it to exit, then renames the old executable aside so `RmRegisterResources`
  has no path to report. The template writes the new binary and the
  post-install hook deletes the backup. Interactive installs keep a
  confirmation prompt; passive/silent (updater) runs proceed directly.

## Consequences

- The tray icon is the app's lifecycle anchor: hiding a window without a tray
  icon is impossible by construction.
- Users who opt out of close-to-tray still quit on window close (including any
  auxiliary windows), which is required for the updater to work.
- Windows 11 may place a newly registered icon in the notification-area
  overflow. The icon exists whenever the app runs; pinning it is a per-user
  shell preference, not an app state.
- Windows toasts need the installed Start Menu shortcut's AppUserModelID. A
  dev build may not render the hint; the flag stays unset in that case, so the
  packaged build still shows it once.
- The installer hook is NSIS-only. The MSI package keeps Tauri's stock
  Restart Manager check and can hit the same third-party handle problem; the
  updater publishes/uses NSIS on Windows.
- If the executable cannot be renamed (for example it is held by a process in
  another user session without delete sharing), the hook leaves it in place and
  the stock check still reports the failure. The rename itself was verified to
  work while McAfee held the file.
- A failed install between the rename and the binary copy leaves
  `recordforge-desktop.exe.rf-<ticks>` behind; re-running the installer writes
  the new binary and removes its own backup, but older backups may need manual
  cleanup.
- Quit from the tray menu closes the main window rather than calling
  `app.exit` directly, so the editor can flush; if the close guard vetoes the
  close the app stays open.

## Alternatives Considered

- Keep close-to-tray opt-in: rejected — it makes the app's primary "close"
  action diverge from its recorder-first lifecycle and produced headless
  processes with auxiliary windows.
- Hide the window even when the tray is missing: rejected — that is the
  invisible-running-process bug the installer trips over.
- Track tray state in a global flag instead of querying the tray manager:
  rejected — the tray manager owns the icon object; a separate flag could drift
  from it and reintroduce the same bug.
- Wait for the upstream Tauri fix to `CheckIfAppIsRunning`: rejected for now —
  the issue is open and the failure blocks every update on affected machines.
- Fork the full NSIS template to skip the check: rejected — a 34 KB template
  copy would drift from Tauri's installer fixes; the supported
  `installerHooks` extension point keeps the workaround small.
- Publish only the MSI as the Windows updater artifact: rejected — it changes
  the install/permission model and does not remove Windows Installer's own
  file-in-use handling.
