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

## Consequences

- Higher friction for features that need filesystem access.
- Clear audit trail for permission changes.
- Users can inspect capability files to understand what the app can do.

## Alternatives Considered

- Broad permissions from the start: faster development but unacceptable security risk.
