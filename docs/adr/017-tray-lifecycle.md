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
