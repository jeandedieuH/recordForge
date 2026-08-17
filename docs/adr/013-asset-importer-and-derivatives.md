# ADR 013: Project Asset Management, Deduplication, and Derivative Pipeline

> **Status:** Accepted — Implemented in Phase 8  
> **Date:** 2026-08-17  
> **Scope:** Management of external media assets, local project persistence, security sanitization, and background derivative generation  
> **Related:** `editor-advanced-features-plan.md`, `apps/desktop/src-tauri/src/commands/assets.rs`, `apps/desktop/src-tauri/src/media/`, `packages/contracts/src/project.ts`

## Context

recordForge users import external audio tracks (background music, voiceover) and graphics/logos to enrich their desktop screen recordings. In earlier versions:
- Assets were referenced using browser `URL.createObjectURL()` with hardcoded fallback metadata (`durationMs: 30000`, `width: 400`, `height: 300`).
- Assets were not persisted into the project file and broke upon reopening the application.
- Unsanitized SVG files posed security risks (arbitrary JavaScript execution via `<script>` or event handlers embedded in SVGs).
- No background processing existed to generate waveforms for audio or thumbnails for images.

## Decision

Establish a robust, **local-first project asset bin** managed by Rust with transactional Tauri commands:

### 1. Project Asset Model (`ProjectAsset`)
- **Semantic Separation of Format and Behavior**: Media `kind` (`audio`, `image`, `video`) describes the file container; timeline `role` (`music`, `graphic`, `sound_effect`, `b_roll`, `audio_track`) describes the clip's editing behavior.
- **Copy vs. Reference Storage**:
  - **Copy (default)**: Source files are copied directly into the recording's project directory (`audio/`, `images/`), creating self-contained, portable project bundles.
  - **Reference (opt-in)**: Retains files at external paths validated by `PathPolicy`.

### 2. SHA-256 Content Deduplication
- Files imported into a project are hashed using SHA-256. Duplicate files within the project reuse existing asset records, saving disk space and avoiding redundant processing.

### 3. SVG Security Sanitization
- All imported vector SVGs are parsed and inspected by `media::svg` before ingestion.
- Files containing `<script>`, inline JavaScript event handlers (`onload`, `onclick`), or external URL references are rejected or sanitized to ensure safe client rendering.

### 4. Background Derivative Generation Pipeline
- Upon asset import, the backend queues async derivative jobs in the SQLite `media_job` table:
  - **Audio**: Generates peak waveforms (`waveform.png`) and audio proxies via FFmpeg.
  - **Images**: Generates downsampled thumbnails for fast asset-bin browsing.
- Progress updates stream to React via Tauri events (`media://job-update`) without blocking the UI thread.

### 5. Safe Relinking and Deletion Policy
- Missing referenced assets are detected and flagged with an interactive "Relink" flow.
- Assets currently referenced by any timeline clip cannot be deleted, preventing dangling clip references and render plan corruption.

## Consequences

- Projects are fully self-contained and durable across application restarts.
- High-fidelity visual waveforms and instant thumbnail previews in the editor asset bin.
- Protection against malicious SVG scripts.
- Clean separation between storage management (Rust) and user presentation (React).
