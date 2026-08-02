# ADR 001: Tauri v2 + Rust + React

## Status

Accepted

## Context

recordForge needs a desktop application that can perform native screen/audio capture, access the filesystem, run FFmpeg, and present a modern, responsive UI.

## Decision

Use **Tauri v2** with a **Rust** backend and **React + TypeScript** frontend.

- Tauri v2 provides the desktop shell, IPC, windowing, tray, global shortcuts, and packaging.
- Rust handles native capture, audio, media jobs, filesystem, and security-sensitive operations.
- React handles the user interface and interaction state only.

## Consequences

- Small bundle size compared to Electron.
- Strong type safety on both sides of the IPC boundary.
- Rust ecosystem provides direct access to Windows capture APIs.
- JavaScript cannot accidentally access raw media frames or credentials.

## Alternatives Considered

- **Electron**: Larger bundle, less control over native code, more security surface.
- **Native Windows (WinUI/WPF)**: Harder to iterate UI, less portable, no shared web tech.
- **Qt**: Higher learning curve, less ecosystem for modern UI.
