# ADR 004: FFmpeg Sidecar Policy

## Status

Accepted (updated)

## Context

recordForge requires FFmpeg and FFprobe for proxy generation, thumbnails, waveforms, audio mixing, and final export.

## Decision

Use FFmpeg as an **external sidecar binary**, bundled per platform and invoked from Rust. Do not link FFmpeg libraries directly.

### Acquisition

A tooling script (`tooling/ffmpeg/setup.mjs`) downloads the **gyan.dev release essentials** build (GPLv3, includes x264/x265) and stages the binaries into `apps/desktop/src-tauri/binaries/` with the Tauri target-triple naming convention (e.g. `ffmpeg-x86_64-pc-windows-msvc.exe`).

The FFmpeg version is **pinned to 9.0.1**. To upgrade, edit `FFMPEG_VERSION` in the setup script and re-run.

### Bundling

Tauri's `externalBin` configuration in `tauri.conf.json` ensures the sidecar binaries are included in MSI/NSIS installers automatically.

### Resolution at Runtime

The Rust `resolve_executable` function checks:
1. The Tauri resource directory (where `externalBin` lands in production installs).
2. Next to the current executable (dev builds after running the setup script).
3. Inside a `{name}/` subdirectory next to the executable.
4. A sibling `bin/` directory.
5. The OS `PATH`.

## Consequences

- Clear legal separation: LGPL/GPL compliance is handled by bundling binaries.
- Rust controls job lifecycle, cancellation, and error parsing.
- Easier to update FFmpeg without rebuilding the app.
- Requires running `bun run setup:ffmpeg` after a fresh clone.
- The `binaries/` directory is git-ignored (~150 MB per binary).
- CI must run `setup:ffmpeg` before building or testing.

## Alternatives Considered

- Direct Rust FFmpeg bindings: complex, risky license-wise, harder to update.
- BtbN nightly builds: less stable than gyan.dev release builds.
- LGPL builds: would lose x264/x265 software encoders that the recorder relies on.
