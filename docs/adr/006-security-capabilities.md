# ADR 006: Tauri Security and Capabilities

## Status

Accepted

## Context

Tauri v2 uses a capability-based security model. recordForge must minimize the attack surface and keep React from accessing dangerous APIs.

## Decision

- Start with the minimal `default` capability: `core:default` and `opener:default`.
- Add filesystem, shell, and other permissions only when required, narrowly scoped.
- Any capability expansion requires an ADR and a security review.
- Cloud credentials are stored only in the OS credential vault.
- The recording countdown window uses a separate `countdown` capability containing only core window/event permissions; it receives no filesystem, shell, or credential permissions.

## Recording Countdown Review

The countdown is a dynamically-created Tauri webview used while the main window is minimized. Its URL contains only a UUID session ID, a constrained countdown value, and a display label. Rust validates the session ID/state before starting or cancelling capture. The capability is limited to `countdown` and does not broaden the main window or expose raw media data.

## Local Media Asset Protocol Review

The main window uses Tauri's asset protocol to stream finalized recordings and generated derivatives into the HTML video element. The protocol is enabled only for `$APPDATA/sessions/**/*`, which contains the immutable recording originals and their preparation outputs. No arbitrary filesystem or shell permission is granted to the webview, and media outside the application sessions directory is not exposed.

## Consequences

- Higher friction for features that need filesystem access.
- Clear audit trail for permission changes.
- Users can inspect capability files to understand what the app can do.

## Alternatives Considered

- Broad permissions from the start: faster development but unacceptable security risk.
