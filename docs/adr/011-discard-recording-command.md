# ADR 011: Discard Recording Command

## Status

Accepted

## Context

`stop_recording` always finalizes and saves the recording to the library. Users also need a way to throw away a recording in progress (started by accident, wrong source, sensitive content captured) without waiting for finalization and then deleting the library entry. Discard is destructive, so the command surface must be audited like a capability change (per ADR 006).

## Decision

Add a single Tauri command, `discard_recording`, exposed to all windows that already hold recorder transport permissions.

Security properties:

- **No arguments.** The command cannot be aimed at any path, session ID, or recording ID from React. It operates exclusively on the recorder's single in-memory active session.
- **Scoped deletion.** It removes only that session's working directory, which the recorder itself created under the app-managed sessions root (`$APPDATA/sessions/<uuid>`). No user-selected paths are involved.
- **No new capabilities.** It is an application command, not a plugin permission; no capability file changes and no filesystem permissions are added.
- **UI confirmation required.** Every surface routes the action through a confirmation step before the command runs. The floating toolbar swaps to an inline confirmation strip ("Discard this recording?" → Cancel / Delete everything, Esc cancels) — a modal is not usable in that window because the toolbar webview is only 88px tall and clips fixed-position overlays. The tray menu's "Discard Recording…" entry never executes anything itself: Rust restores the main window and emits `request-discard-confirmation`, and the main window's `AlertDialog` owns the final decision before invoking the command. Discard is deliberately absent from global shortcuts.
- **Fail-open recorder.** If directory deletion fails (e.g. a file is locked by antivirus), the recorder is still cleared so the app cannot wedge; the error surfaces to the user and the orphaned directory remains deletable through the existing recovery UI.
- **No recovery trace.** Discard never writes a `Completed`/`Failed` manifest state, so the deleted session cannot reappear in the recovery scan.

Behavior: stop screen/audio/webcam/cursor workers (results logged, not surfaced as errors), drop the session from the recorder, delete the working directory, hide floating/boundary/countdown windows, restore the main window, and broadcast the idle status.

## Consequences

- Users get an immediate, confirmable "undo" for an unwanted recording.
- Marker and shortcut paths are unaffected; discard is reachable only from the floating toolbar's confirmation strip and the tray → main-window dialog path.
- A partially failed discard leaves an orphan directory that the recovery scan lists as non-recoverable metadata only (the manifest remains in a non-completed state until deleted).

## Alternatives Considered

- **Stop then auto-delete the library entry:** slower (full concat + probe), leaves a window where sensitive media exists on disk, and pollutes the library with transient rows.
- **Trash/soft-delete instead of permanent deletion:** defers the privacy benefit and adds state; V1 trash semantics stay limited to library items.
