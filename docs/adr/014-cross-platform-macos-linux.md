# ADR 014: Cross-Platform macOS and Linux Expansion

> **Status:** Accepted — Partially implemented
> **Date:** 2026-08-26
> **Supersedes:** `docs/adr/002-windows-first.md` (which deferred non-Windows platforms)
> **Scope:** Multi-platform desktop support for Windows, macOS, and Linux
> **Related:** `apps/desktop/src-tauri/src/capture/`, `apps/desktop/src-tauri/src/storage/vault.rs`, `tooling/ffmpeg/setup.mjs`, `.github/workflows/`

## Context

recordForge initially launched as Windows-first to validate the core local-first screen recording and lightweight proxy editor architecture. With the core recording pipeline, timeline editing engine, SQLite persistence, and export pipeline stabilized and tested, expanding to macOS and Linux is necessary to serve creators across all major desktop environments.

## Decision

Expand recordForge to support **Windows 10/11**, **macOS 12+ (Apple Silicon & Intel)**, and **Linux (x86_64)** while maintaining low idle memory usage and zero-trust local-first privacy:

### 1. Multi-Platform Capture Subsystems
- **Screen & Window Capture**:
  - Windows: Desktop Duplication API (`ddagrab`) and GDI (`gdigrab`).
  - macOS: ScreenCaptureKit / AVFoundation (`avfoundation`).
  - Linux: X11 Grab (`x11grab`) with fallback capabilities.
- **Webcam & Camera Inputs**:
  - Windows: DirectShow (`dshow`).
  - macOS: AVFoundation (`avfoundation`).
  - Linux: Video4Linux2 (`v4l2`).
- **Audio Capture**:
  - Windows: Native WASAPI loopback and microphone capture.
  - macOS: CoreAudio / ScreenCaptureKit audio streams.
  - Linux: ALSA / PulseAudio / PipeWire streams.

### 2. Multi-Platform Hardware Acceleration
- Hardware encoding priority expands to:
  - Windows: NVIDIA NVENC (`h264_nvenc`), Intel QuickSync (`h264_qsv`), AMD AMF (`h264_amf`), Windows Media Foundation (`h264_mf`).
  - macOS: Apple VideoToolbox (`h264_videotoolbox` on Apple Silicon and Intel).
  - Linux: VAAPI (`h264_vaapi`), NVIDIA NVENC (`h264_nvenc`), Intel QuickSync (`h264_qsv`).
  - Universal Software Fallback: `libx264`.

### 3. OS Credential Vault Abstraction
- Windows: Native Windows Credential Manager.
- macOS: Apple Keychain Services via `keyring`.
- Linux: Secret Service / DBus via `keyring`.
- Test/Headless: In-memory fallback.

### 4. Pinned Multi-Platform FFmpeg Sidecars & Tooling
- `tooling/ffmpeg/setup.mjs` downloads and stages pinned FFmpeg/FFprobe binaries across all target triples:
  - `x86_64-pc-windows-msvc`
  - `aarch64-apple-darwin`
  - `x86_64-apple-darwin`
  - `x86_64-unknown-linux-gnu`

### 5. Multi-Platform Packaging & CI Matrix
- Tauri v2 configured with bundle targets: `["msi", "nsis", "dmg", "app", "deb", "appimage"]` and `Info.plist` with Apple privacy keys (`NSScreenCaptureUsageDescription`, `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`).
- GitHub Actions CI matrix builds and runs tests concurrently on `windows-latest`, `macos-latest`, and `ubuntu-latest`.

## Consequences

- Full desktop parity across Windows, macOS, and Linux.
- Zero-drift A/V synchronization maintained across all platforms.
- Unified single codebase with target-conditional native bindings.
