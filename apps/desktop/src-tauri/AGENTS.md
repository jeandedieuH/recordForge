# RecordForge Rust Core — Agent Guide

## Scope

The Tauri Rust backend owns native capture, audio, filesystem, encoding coordination, credentials, media jobs, and security-sensitive operations.

## Commands

```bash
# Format
cargo fmt
cargo fmt --check

# Lint
cargo clippy
cargo clippy --fix

# Test
cargo test

# Live capture check: records the screen region and the default microphone for
# ~4 s and asserts audio/cursor data start with the video (needs an interactive
# desktop session and a microphone; on Windows keep -j 1)
cargo test -j 1 live_recording_audio_and_cursor_cover_the_screen_startup_window -- --ignored --nocapture

# Build release
cargo build --release
```

## Directory Layout

- `src/commands/` — Tauri command handlers
- `src/capture/` — Native screen/audio capture
  - `src/capture/audio/wasapi.rs` — Native WASAPI microphone and render-loopback capture
  - `src/capture/devices.rs` — WASAPI audio and DirectShow video device enumeration
  - `src/capture/media/mod.rs` — FFmpeg concat, audio mux, trim, copy, and version helpers
- `src/database/` — SQLite and migrations
  - `src/database/library.rs` — Library recording persistence and tag helpers
- `src/diagnostics/` — Preflight, metrics, and diagnostics
- `src/events/` — Tauri event/channel publishers
- `src/exports/` — Export job orchestration
- `src/media/` — FFmpeg/FFprobe job management
- `src/projects/` — Project persistence and loading
- `src/storage/` — S3 and Google Drive adapters
- `src/shortcuts.rs` — Global shortcut registration and handlers
- `src/tray.rs` — System tray icon and menu
- `src/errors.rs` — Application error types
- `src/state.rs` — Shared application state and updater operation gate

## Dependencies

- `tauri` is configured with the `tray-icon` and `image-png` features.
- `tauri-plugin-single-instance` is registered first so a second launch focuses the running instance instead of starting another tray app.
- `tauri-plugin-notification` provides the native one-time close-to-tray hint (Rust-side only; no JS notification permission is required).
- `tauri-plugin-global-shortcut` is used for global hotkeys.
- `tauri-plugin-dialog` is used for save/export dialogs.
- `tauri-plugin-updater` verifies signed official GitHub Release artifacts; its installer is guarded by `UpdateGate`.
- `installer-hooks.nsh` is registered through `bundle.windows.nsis.installerHooks` and works around the Restart Manager update abort when third-party software (e.g. McAfee) holds the main executable; it is NSIS-only.
- `wasapi` provides native Windows microphone and render-loopback capture.
- `pipewire`/`libspa-sys` provide Wayland screen capture on Linux. `libspa` is patched to a vendored copy at `vendor/libspa/` via `[patch.crates-io]` so the crate also compiles against PipeWire < 1.0 headers (e.g. Ubuntu 22.04); see `vendor/libspa/README-vendored.md` before bumping `pipewire`/`libspa`.
- These are initialized in `src/lib.rs` and gated by `capabilities/default.json`.

## Module Rules

- Use `tracing` for all logging.
- Return `errors::Result<T>` from commands.
- Keep media frame data in Rust; do not stream it to React.
- Use background tasks for long-running capture, encoding, or upload jobs.
- Store credentials only in the OS credential vault.

## Security Notes

- Validate all file paths before use.
- Do not execute arbitrary shell commands from user input.
- Redact secrets and tokens from logs.
- Require review for any new Tauri capability or filesystem permission.
- Keep updater installation behind the native readiness gate; never install while recording, media jobs, or uploads are active.
