# ADR 004: FFmpeg Sidecar Policy

## Status

Accepted (updated)

## Context

RecordForge requires FFmpeg and FFprobe for proxy generation, thumbnails, waveforms, audio mixing, and final export.

## Decision

Use FFmpeg as an **external sidecar binary**, bundled per platform and invoked from Rust. Do not link FFmpeg libraries directly.

### Acquisition

A tooling script (`tooling/ffmpeg/setup.mjs`) downloads pinned static builds and stages the binaries into `apps/desktop/src-tauri/binaries/` with the Tauri target-triple naming convention (e.g. `ffmpeg-x86_64-pc-windows-msvc.exe`). The script uses a per-platform provider with a fallback:

- Windows x86_64: GyanD GitHub release essentials (GPLv3, includes x264/x265).
- macOS arm64: Martin Riedl release builds (primary) with the same host's `redirect/latest` URL as fallback — no independent arm64 static-build mirror exists (evermeet.cx is Intel-only).
- macOS x64: Martin Riedl release builds (primary) with evermeet.cx release zip fallback.
- Linux x86_64: BtbN FFmpeg-Builds, pinned to a retained monthly autobuild snapshot (n9.0.1 + release-branch commits), with the floating `n9.0-latest` asset as fallback. Martin Riedl and johnvansickle static builds ship no capture indevs (x11grab/v4l2/pulse), so they cannot serve the Linux recorder.

Transient download failures (5xx including Cloudflare origin errors, 408/425/429, network/stream errors) are retried with backoff before the script moves to the fallback URL; a hard failure only aborts after both URLs are exhausted.

The FFmpeg version is **pinned to 9.0.1**. To upgrade, edit `FFMPEG_VERSION` and the pinned Martin Riedl build IDs / BtbN autobuild tag in the setup script, then re-run.

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
- BtbN nightly builds: less stable than gyan.dev release builds — used only for Linux, where no alternative static build ships the required capture indevs; the pin targets a retained monthly snapshot, not a daily build.
- LGPL builds: would lose x264/x265 software encoders that the recorder relies on.
