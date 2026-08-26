# ADR 002: Windows 11 First

## Status

Superseded by [ADR 014: Cross-Platform macOS and Linux Expansion](014-cross-platform-macos-linux.md)

## Context

recordForge must prove reliable capture on low-end hardware before expanding. Windows 11 is the primary development and target platform for the founding user.

## Decision

Target **Windows 11 first** for V1. macOS and Linux support are explicitly deferred.

## Consequences

- Use Windows Graphics Capture, DXGI, and WASAPI for capture.
- Build Windows-specific recovery and hardware-encoder detection first.
- Avoid cross-platform abstractions that would slow V1 validation.
- Code is written so future platform adapters can be added, but no resources are spent on them now.

## Alternatives Considered

- Cross-platform from day one: too risky for V1; capture quality varies significantly by OS.
