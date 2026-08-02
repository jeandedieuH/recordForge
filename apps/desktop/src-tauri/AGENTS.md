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
- `src/database/` — SQLite and migrations
- `src/diagnostics/` — Preflight, metrics, and diagnostics
- `src/events/` — Tauri event/channel publishers
- `src/exports/` — Export job orchestration
- `src/media/` — FFmpeg/FFprobe job management
- `src/projects/` — Project persistence and loading
- `src/storage/` — S3 and Google Drive adapters
- `src/errors.rs` — Application error types
- `src/state.rs` — Shared application state

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
