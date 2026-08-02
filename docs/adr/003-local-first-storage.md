# ADR 003: Local-First Storage

## Status

Accepted

## Context

recordForge users must retain ownership of their recordings. Cloud features are optional and must never be required.

## Decision

All recording, editing, exporting, and recovery happen locally. Uploads are copies of completed local exports. Local media is the source of truth.

## Consequences

- No recordForge backend is required.
- Users choose their own S3-compatible storage or Google Drive.
- Offline use is fully supported.
- Cloud credentials are stored in the OS credential vault, not in the app.

## Alternatives Considered

- RecordForge-hosted cloud: creates lock-in and recurring costs, out of scope for V1.
