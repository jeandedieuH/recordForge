# ADR 005: Project File Format

## Status

Accepted

## Context

The editor must be non-destructive. Original recordings are immutable; edits are stored as metadata.

## Decision

Project state is stored in two layers:

- `project.json` in the project directory: human-readable, versioned project metadata.
- `app.db`: SQLite index of recordings, projects, jobs, and upload queue state.

The project JSON includes canvas settings, tracks, clips, markers, and export settings. Source media files are referenced by ID and never embedded.

## Consequences

- Projects are portable and easy to inspect.
- SQLite provides fast querying and recovery.
- Original media is never modified.
- Version field allows future migration.

## Alternatives Considered

- Single SQLite database for everything: harder to move projects, less transparent.
