# recordForge Rust Core — Agent Guide

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

# Build release
cargo build --release
```

## Directory Layout

- `src/commands/` — Tauri command handlers
- `src/capture/` — Native screen/audio capture
  - `src/capture/devices.rs` — DirectShow audio/video device enumeration
  - `src/capture/media/mod.rs` — FFmpeg concat, trim, copy, and version helpers
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
- `src/state.rs` — Shared application state

## Dependencies

- `tauri` is configured with the `tray-icon` and `image-png` features.
- `tauri-plugin-global-shortcut` is used for global hotkeys.
- `tauri-plugin-dialog` is used for save/export dialogs.
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
