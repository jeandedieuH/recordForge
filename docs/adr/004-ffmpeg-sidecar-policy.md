# ADR 004: FFmpeg Sidecar Policy

## Status

Accepted

## Context

recordForge requires FFmpeg and FFprobe for proxy generation, thumbnails, waveforms, audio mixing, and final export.

## Decision

Use FFmpeg as an **external sidecar binary**, bundled per platform and invoked from Rust. Do not link FFmpeg libraries directly.

## Consequences

- Clear legal separation: LGPL/ GPL compliance is handled by bundling binaries.
- Rust controls job lifecycle, cancellation, and error parsing.
- Easier to update FFmpeg without rebuilding the app.
- Requires packaging FFmpeg binaries for Windows in `src-tauri/binaries/`.

## Alternatives Considered

- Direct Rust FFmpeg bindings: complex, risky license-wise, harder to update.
