# ADR 009: Window Chrome — Frameless + Custom Titlebar + Mica with Opaque Fallback

## Status

Accepted

## Context

The app used the native title bar, which reads as a settings dialog rather than a studio console. The renewed plan (§4.2) specifies a frameless main window with a custom titlebar and a Mica backdrop, with a hard requirement that low-end GPUs and effect failures degrade to a fully opaque window.

## Decision

- **Main window:** `decorations: false`, `transparent: true`, default 1280×800, minimum 960×600.
- **Custom titlebar** in React (`src/app/titlebar.tsx`): drag region via `data-tauri-drag-region`, wordmark + view breadcrumb left, minimize/maximize/close right via `@tauri-apps/api/window`.
- **Mica backdrop** applied in Rust at startup (`src-tauri/src/window_effects.rs`) honoring the persisted `windowTransparency` setting (default on). `set_effects` failure is logged and leaves the opaque fallback — it is never surfaced as an error.
- **Transparency state is truth-checked:** the frontend only switches the canvas to transparent (`html[data-mica="true"]`) after Rust confirms the effect is active (`window_transparency_active` / the boolean returned by `set_window_transparency`). A failed effect can never produce a see-through window.
- **Capability additions** (security review, this ADR): `core:window:allow-minimize`, `allow-maximize`, `allow-unmaximize`, `allow-toggle-maximize`, `allow-is-maximized`, `allow-start-dragging`. All are scoped to window management of the app's own windows; no filesystem or shell access is added.
- **Settings persistence:** new `settings` SQLite table (migration v4) with `get_setting`/`set_setting` commands; keys are validated against an allowlist so the IPC surface stays narrow.

## Consequences

- Window chrome behavior (drag, maximize) is now our code and must be tested on multi-DPI setups.
- The settings table becomes the persistence layer for R4 settings IA; new keys require extending the allowlist.
- Mica visibility depends on a transparent webview; any regression to an opaque canvas simply hides the effect (safe direction).

## Alternatives Considered

- `titleBarStyle: overlay` (keeps native buttons): rejected — cannot host the wordmark/breadcrumb layout and looks non-native on Windows.
- Applying Mica from the frontend via a plugin: rejected — window effects are native state; Rust owns them and can truth-report activation.
