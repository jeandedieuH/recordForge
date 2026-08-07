# recordForge Editor Development Plan

> **Status:** Draft - implementation-ready after phase-level review
> **Product area:** Desktop editor
> **Primary target:** A practical, local-first screen-story editor for Windows 10/11
> **Reference product specification:** [recordforge-editor-specification.md](recordforge-editor-specification.md)
> **Audit basis:** Existing workspace implementation and current project specifications

---

## 1. Purpose

This document converts the external editor specification into an implementation plan for the current recordForge repository.

The reference specification defines the desired product behavior and feature scope. This document adds the missing engineering decisions:

- What the repository already implements.
- Which current implementations can be retained.
- Which implementations are incomplete, misleading, or structurally incompatible.
- Which changes must happen before feature work is safe.
- Which packages, files, contracts, tests, and acceptance gates are involved in each phase.

This is an editor-specific execution plan. It does not replace the recorder-first constraints in `project-plan.md` or `end-to-end improvement-plan.md`, and it does not replace the on-disk contracts in `docs/specs/project-format.md` or `docs/specs/media-jobs-render-plan.md`.

Redesign is explicitly allowed. Existing editor and cursor code should be retained only where it supports the target behavior without creating persistence, timing, security, or preview/export parity problems.

## 2. Source Of Truth And Precedence

When documents or existing code disagree, use this order:

1. Security, local-first, and native/media ownership rules in `AGENTS.md`.
2. Recorder reliability and release gates in `project-plan.md` and `end-to-end improvement-plan.md`.
3. Durable project and render contracts in `docs/specs/project-format.md` and `docs/specs/media-jobs-render-plan.md`.
4. Product intent and feature behavior in `recordforge-editor-specification.md`.
5. Current implementation, which is evidence of existing behavior but not authority over the target design.

Any conflict discovered during implementation must result in one of:

- An update to the relevant specification before code changes continue.
- A documented phase decision that explains why the target behavior is intentionally changed.
- A migration plan if existing user data or shipped behavior is affected.

## 3. Product Definition

recordForge Editor is a **screen-story editor**, not a general-purpose nonlinear editor. It turns screen recordings into clear, polished communication artifacts for tutorials, demos, bug reports, onboarding, education, support, and internal communication.

The editor should be substantially more capable than a trim-only tool while remaining simpler than Premiere Pro or DaVinci Resolve. The product prioritizes:

- Removing mistakes quickly.
- Making small interfaces readable.
- Guiding attention with zoom and cursor treatment.
- Presenting webcam and screen content professionally.
- Improving narration enough for everyday communication.
- Protecting sensitive information.
- Exporting a trustworthy local file without requiring cloud services.

### 3.1 Product goals

- Open a recording project quickly using proxy media.
- Preserve every edit as durable, non-destructive project metadata.
- Keep the timeline usable for at least a 60-minute recording on the baseline low-end machine.
- Make preview and final export use the same timeline and effect semantics.
- Support the common screen-video workflow without arbitrary NLE complexity.
- Keep original recordings immutable and offline use complete.

### 3.2 Non-goals

- Unlimited arbitrary track compositing.
- Full VFX, color grading, or node-based compositing.
- DAW-style buses and advanced audio mixing.
- After Effects-style motion-graphics authoring.
- Collaborative multi-user editing.
- A plugin ecosystem in the initial release.
- Hosted sharing, accounts, or workspaces.
- Generated captions, silence removal, or AI assistance before the editor foundation is reliable.

### 3.3 Release tiers

The reference specification has three tiers. This plan preserves that division so the MVP does not become an unbounded rewrite.

| Tier                   | Release meaning                               | Included capabilities                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation             | Required before feature work can be trusted   | Project persistence, asset registry, timeline semantics, proxy playback, durable commands, core cuts, reliable export plumbing                                                                                                  |
| Tier 1 - Editor MVP    | First usable practical editor                 | Trim, split, delete, ripple delete, move, undo/redo, proxy playback, crop/transform, webcam PiP, cursor scale/click/spotlight, manual zoom, audio gain/fades, SRT/VTT captions, basic canvas styling, static masks, MP4 export  |
| Tier 2 - Modern Editor | Differentiated screen-video workflow          | Smart zoom, cursor smoothing/presets, transcript-linked caption navigation, aspect-ratio scenes, audio normalization/emphasis/ducking presets, per-segment masks, social export presets, regeneration and lockable auto effects |
| Tier 3 - Later         | Delight and intelligence after the foundation | Silence suggestions, smart chapters, kinetic cursor, lens effects, follow-cursor mode, keyboard overlays, branded scenes, freeze-frame annotation, guided cleanup                                                               |

Tier 2 work may be developed behind feature flags, but it must not destabilize Tier 1 editing, persistence, or export.

## 4. Recorder And Editor Dependencies

The broader product plan correctly keeps recordForge recorder-first. The editor can be developed against synthetic media and completed recordings while capture work continues, but an editor release cannot be considered complete until the recorder supplies trustworthy source assets.

### 4.1 Required recorder guarantees

- The original screen recording is immutable and has stable identity.
- Microphone, system audio, and webcam assets have stable roles or stream identities.
- Cursor telemetry has a stable asset reference and source coordinate metadata.
- Recording duration, dimensions, frame rate, and stream timing are validated.
- Proxy, thumbnail, waveform, and metadata derivatives can be regenerated.
- A recovered recording follows the same asset/project creation path as a normally completed recording.
- Recording and editor paths do not expose raw frames or audio buffers to React or IPC.

### 4.2 Editor work that can begin earlier

The following can proceed with synthetic fixtures and the current media outputs:

- Project schema and persistence.
- Timeline command and time-mapping redesign.
- Proxy playback synchronization.
- Timeline interaction and virtualization.
- Cursor-core algorithms using fixture telemetry.
- Caption, mask, canvas, and render-plan contracts.

The following must be gated by real recorder evidence before release:

- Cursor metadata completeness after pause, forced exit, and recovery.
- Webcam asset timing and stream identity.
- A/V alignment in final export.
- Performance while derivative and export jobs coexist with capture.

## 5. Current Codebase Assessment

The current codebase contains a meaningful first-cut editor. It is not an empty shell, but it is not yet a durable editor implementation.

### 5.1 Current architecture

```text
Library recording
  -> AppShell opens recordingId
  -> timeline-store.load()
  -> recording + metadata + media jobs
  -> createTimelineFromRecording()
  -> editor-core CommandEngine in memory
  -> TimelineView renders proxy/original media and timeline

Media preparation
  -> Rust JobManager
  -> FFprobe / proxy / thumbnails / audio / waveform
  -> SQLite media jobs and derivative paths
  -> compact media-job events
  -> React media state

Editor export
  -> timeline-store.export()
  -> media-core.buildRenderPlan()
  -> export_timeline IPC
  -> Rust FFmpeg render
  -> Rust cursor compositor
```

The main architectural break is that the timeline is regenerated in memory from a recording every time the editor opens. The current render plan also represents only a subset of the editor state.

### 5.2 Capability matrix

| Area                          | Current status              | Evidence                                                                                   | Plan disposition                                                        |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Editor entry point            | Partial                     | `apps/desktop/src/features/editor/editor-view.tsx` delegates directly to timeline UI       | Replace with project-aware editor shell                                 |
| Project persistence           | Missing                     | `editor-store.ts` stores only `recordingId`; `timeline-store.ts` recreates a timeline      | Implement before durable feature work                                   |
| Project schema                | Incomplete                  | `packages/contracts/src/project.ts` aliases timeline state; no asset registry              | Replace with versioned durable project schema                           |
| Recording-to-timeline mapping | Working baseline            | `packages/domain/src/timeline.ts` creates screen, audio, camera, and marker data           | Retain as a migration/bootstrap path, not the reopen path               |
| Pure command engine           | Working baseline            | `packages/editor-core/src/engine.ts`, `commands.ts`, `history.ts`                          | Retain concept; redesign commands as serializable operations            |
| Undo/redo                     | Partial                     | Full-state history exists, but history is unbounded and not persisted                      | Cap, test, and connect to project autosave                              |
| Core cuts                     | Partial                     | Split, delete, ripple-delete, source trim commands exist                                   | Finish interaction model, locking, range semantics, and tests           |
| Clip move                     | Partial                     | Core command exists; timeline UI does not provide drag interaction                         | Add direct manipulation and keyboard alternative                        |
| Range selection               | Missing                     | No timeline range selection model                                                          | Add view selection separate from project data                           |
| Snapping                      | Missing                     | No snap implementation                                                                     | Add before finalizing drag and trim interactions                        |
| Multi-selection               | Missing                     | UI has one selected clip                                                                   | Add selection set and primary selection semantics                       |
| Markers                       | Partial                     | Markers are created from recordings and included in state                                  | Add marker lane, editing, snapping, and ripple rules                    |
| Proxy generation              | Working backend             | Rust media jobs generate proxy derivatives                                                 | Keep; wire readiness and invalidation to projects                       |
| Thumbnail generation          | Working backend, unused UI  | Rust creates thumbnails, timeline does not consume them                                    | Add thumbnail manifest loading and virtualization                       |
| Waveform generation           | Working backend, partial UI | PNG is displayed; peak JSON is not consumed                                                | Use precomputed peaks for scalable rendering                            |
| Playback synchronization      | Partial and unsafe          | Store and video controls exist, but edited source/output time mapping is not authoritative | Build one playback/time-mapping path                                    |
| Camera model                  | Partial                     | Camera clip and numeric transform exist                                                    | Add asset identity, preview compositor, direct manipulation, and export |
| Canvas model                  | State-only                  | Basic fields and command exist; preview/export do not apply them fully                     | Implement shared canvas transform/compositor                            |
| Audio model                   | Partial                     | Separate streams, preview, volume, and basic export exist                                  | Add semantic roles, fades, solo/export parity, and mix plan             |
| Captions                      | State-only                  | Caption schema and add command exist                                                       | Add import, edit, track, preview, and export                            |
| Zoom                          | Missing                     | No zoom model, commands, or renderer                                                       | Add manual zoom in Tier 1; smart zoom later                             |
| Masks                         | Missing                     | No mask model, command, preview, or render path                                            | Add static blur/redaction in Tier 1                                     |
| Annotations                   | Missing                     | No annotation model or renderer                                                            | Add lightweight instructional annotations after core compositing        |
| Cursor capture                | Partial                     | Rust samples telemetry and writes `cursor_telemetry.json` on pause/stop                    | Make durable asset with recovery/checkpoint semantics                   |
| Cursor preview                | Partial                     | `custom-cursor-overlay.tsx` renders telemetry and effects, but parity is unproven          | Rebuild on shared time/coordinate/effect semantics                      |
| Cursor inspector              | Partial                     | Global settings inspector exists                                                           | Convert to range-aware cursor effect inspector                          |
| Cursor export                 | Partial                     | Rust raster compositor exists, but parity is unproven                                      | Reuse primitives where possible; align with preview and render graph    |
| Export plan                   | Partial                     | `packages/media-core/src/render-plan.ts` handles screen/audio basics                       | Replace with complete project-derived plan                              |
| Export job lifecycle          | Partial                     | Export creates inconsistent job identity and has no cancellation                           | Integrate with durable scheduler                                        |
| Export UI                     | Partial/misleading          | Preset controls are not connected to backend                                               | Replace with one truthful export flow                                   |
| Timeline virtualization       | Missing                     | Tracks and clips render with direct `.map()`                                               | Required before 60-minute acceptance                                    |
| Editor tests                  | Partial                     | Core and render-plan tests exist; no desktop editor tests                                  | Add unit, integration, golden, and component coverage                   |

### 5.3 Existing code disposition

| Existing area                        | Decision                   | Reason                                                                                                                                  |
| ------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/editor-core`               | Keep and refactor          | Pure command/history architecture is valuable, but current command closures are difficult to persist and inspect                        |
| `packages/domain/src/timeline.ts`    | Adapt                      | Useful for bootstrapping a new project from a recording; must stop generating fresh project identity on every open                      |
| `packages/contracts/src/timeline.ts` | Replace in stages          | Current model is too narrow for typed tracks, effect ranges, assets, and complete export settings                                       |
| `packages/contracts/src/cursor.ts`   | Adapt substantially        | Existing visual settings provide a useful baseline, but lack range semantics, button-specific behavior, and complete idle handling      |
| `packages/media-core`                | Keep as render-plan owner  | Existing package is the natural home for project-to-render-plan translation; a separate `render-core` package is not required initially |
| Rust media preparation               | Keep and connect           | Derivative generation is real and useful; editor must consume its outputs and recipe versions                                           |
| React timeline UI                    | Consolidate and refactor   | Keep reusable controls, remove duplicated/static paths, and establish one authoritative timeline renderer                               |
| React cursor overlay                 | Adapt or replace internals | Visual primitives can be retained only after time and coordinate mapping are corrected                                                  |
| Rust cursor exporter                 | Adapt or replace internals | Existing raster path is useful, but it must become one stage of the complete render graph                                               |
| `pip-controls.tsx`                   | Integrate or remove        | It is currently not part of the authoritative editor flow                                                                               |
| Legacy copy-style export command     | Remove from editor path    | It cannot represent non-destructive edits or effect composition                                                                         |

## 6. Priority Misalignment Register

### P0 - Data loss or output correctness

| ID   | Misalignment                                                                                           | Affected code                                                               | Required correction                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| P0-1 | Editor edits disappear when the editor closes or reopens                                               | `editor-store.ts`, `timeline-store.ts`, `packages/contracts/src/project.ts` | Add durable `project.json`, SQLite project index, autosave, load, migration, and dirty state       |
| P0-2 | Preview uses playhead time directly while export maps edited output time back to source time           | `custom-cursor-overlay.tsx`, `timeline-view.tsx`, Rust cursor exporter      | Create one authoritative timeline-to-source mapping used by playback, overlays, and export         |
| P0-3 | Render plan drops camera, canvas, captions, masks, zoom, speed, fades, and annotations                 | `packages/media-core/src/render-plan.ts`, `src-tauri/src/exports/*`         | Define a complete asset-ID-based render plan and implement the render graph incrementally          |
| P0-4 | Export request is not project/asset authoritative and still accepts recording ID plus destination path | `packages/contracts/src/timeline.ts`, export IPC                            | Send project/asset IDs; resolve source paths only in Rust through the project registry             |
| P0-5 | Export job identity and cancellation are not durable                                                   | `commands/exports.rs`, `exports/mod.rs`, `jobs/*`                           | Use one scheduler-owned job ID, cancellation token, partial output, validation, and restart policy |

### P1 - Model and workflow correctness

| ID   | Misalignment                                                                                          | Affected code                                        | Required correction                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| P1-1 | Current track kinds cannot represent zoom, cursor, masks, annotations, or separate audio roles        | `packages/contracts/src/timeline.ts`                 | Move to semantic track/effect models aligned with the reference specification                        |
| P1-2 | Cursor settings are global canvas state instead of editable ranges                                    | `timeline.ts`, cursor inspector, cursor command      | Treat the current global setting as a full-duration default effect range and support range overrides |
| P1-3 | Cursor telemetry is only written on graceful pause/stop and is absent from the project asset registry | `capture/cursor.rs`, manifest, library contracts     | Persist a versioned cursor asset reference and checkpoint/recover it with the session                |
| P1-4 | Camera transform exists in state but camera is not composited in preview or export                    | `clip-inspector.tsx`, `render-plan.ts`, Rust exports | Add shared composition semantics and camera overlay rendering                                        |
| P1-5 | Canvas fields exist but are not rendered                                                              | contracts, preview, Rust exports                     | Implement canvas transform and styling in preview and export                                         |
| P1-6 | Captions have a command/schema but no import, editing, preview, or export path                        | contracts/editor-core/media-core                     | Implement SRT/VTT MVP workflow                                                                       |
| P1-7 | Numeric source trim is not direct trim interaction                                                    | `clip-inspector.tsx`, timeline UI                    | Add trim handles with keyboard and accessibility alternatives                                        |
| P1-8 | Ripple delete does not fully define marker/audio/locked-track behavior                                | `packages/editor-core/src/commands.ts`               | Define and test project-wide ripple semantics before adding more interactions                        |
| P1-9 | Export controls are visual and fixed backend settings are used                                        | `features/export/export-view.tsx`, Rust exports      | Replace disconnected controls with capability-driven options wired to the job plan                   |

### P2 - Performance, usability, and maintainability

| ID   | Misalignment                                                         | Affected code                          | Required correction                                                            |
| ---- | -------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| P2-1 | Timeline maps every clip and track directly                          | `timeline-view.tsx`                    | Virtualize tracks, thumbnails, captions, markers, and time-window content      |
| P2-2 | Waveform JSON and thumbnail derivatives are not fully consumed       | timeline UI and media contracts        | Load precomputed data and avoid decoding large media on the UI thread          |
| P2-3 | Commands are executable closures rather than serializable operations | `editor-core/src/commands.ts`          | Use discriminated command records with deterministic reducer/application logic |
| P2-4 | Core commands do not consistently enforce locked-track behavior      | `editor-core/src/commands.ts`          | Centralize editability checks in command application                           |
| P2-5 | Missing telemetry can result in a fabricated centered cursor         | `custom-cursor-overlay.tsx`            | Render no cursor and show an explicit metadata-unavailable state               |
| P2-6 | Rust and React cursor presets and coordinate fitting differ          | React overlay and Rust cursor renderer | Share fixture contracts and matching transform/effect definitions              |
| P2-7 | There are no desktop editor component or preview/export parity tests | editor features and media pipeline     | Add test harness before claiming feature completion                            |

## 7. Target Architecture

### 7.1 Durable project boundary

The project is the source of truth for editor state. A recording is immutable source media; the project is a versioned metadata document that references recording assets.

```text
Recording/session
  - immutable screen source
  - microphone asset or audio stream
  - system-audio asset or audio stream
  - webcam asset or video stream
  - cursor telemetry asset
  - recording markers

Project
  - stable project identity and recording identity
  - asset registry with relative paths and roles
  - canvas settings
  - typed timeline tracks and clips/effect ranges
  - markers
  - export settings
  - schema version, timestamps, checksum
```

Rust owns project file IO and path resolution. React receives validated project DTOs and never supplies arbitrary media paths to the render command.

The normative on-disk rules remain in `docs/specs/project-format.md`; this section maps those rules to the current repository and identifies implementation work. Contract changes must update the normative spec before code is merged.

### 7.2 Project file and database rules

- Store the project beside its source recording as `project.json`.
- Use an atomic temp-file write followed by replacement.
- Preserve the last known good file as `project.json.bak`.
- Debounce autosave after modifying commands.
- Track `dirty`, `saving`, `saved`, and `save-error` states.
- Create bounded snapshots before destructive operations.
- Index project identity and timestamps in SQLite.
- Resolve asset paths from asset IDs with canonical containment validation.
- Mark missing assets explicitly and block export until relinked or removed.
- Run forward-only migrations and preserve the original file before migration.

The current `TimelineState.version = 1` is an in-memory runtime shape, not a shipped project format. Before persistence is implemented, confirm whether any external project files exist. If none exist, reserve the durable project version for the project-format specification and add a format discriminator so runtime and persisted versions cannot be confused later.

### 7.3 Timeline model

The final model should represent the reference specification without forcing every feature into a generic `effects` bucket.

Required semantic track roles:

| Track role     | Purpose                                              |
| -------------- | ---------------------------------------------------- |
| `zoom`         | Manual and generated zoom segments                   |
| `cursor`       | Cursor effect ranges and presets                     |
| `screen`       | Main screen/window/region clips                      |
| `camera`       | Webcam clips and layout instances                    |
| `microphone`   | Narration source and gain/fade settings              |
| `system-audio` | System/app audio source and gain/fade settings       |
| `music`        | Optional background music                            |
| `captions`     | Timed text cues                                      |
| `masks`        | Blur, pixelation, and redaction ranges               |
| `annotations`  | Arrows, callouts, highlights, and instructional text |

Markers remain a top-level project collection and are rendered as a dedicated marker lane; they are not duplicated as a clip track. Other tracks may contain clips or range effects, but each `kind` must determine the allowed data and render behavior. Avoid one untyped `effects` track for new features.

### 7.4 Time semantics

Every feature must distinguish these time domains:

- **Source time:** timestamp in an immutable asset.
- **Timeline time:** position in the editable project, including intentional gaps.
- **Output time:** position in the final rendered file.

Required pure functions include:

- `timelineToSource(clipId, timelineMs)`.
- `sourceToTimeline(assetId, sourceMs)` where unambiguous.
- `timelineToOutput(timelineMs)`.
- `outputToTimeline(outputMs)`.
- `clipDurationFromSourceRange(sourceInMs, sourceOutMs, speed)`.

Default rules:

- Timeline positions are authoritative for editing and preview.
- Output preserves intentional timeline gaps as silence/filler unless the user explicitly ripple-deletes them.
- Speed changes alter duration and source-time mapping, not the identity of the source asset.
- Markers move with ripple edits when they occur after the deleted range.
- Locked tracks cannot be modified by direct commands or ripple operations without an explicit override policy.
- Cursor telemetry is sampled in source time and mapped through the same clip/time functions as the video.

These rules must be implemented once in pure code and covered by fixtures before the UI and Rust export paths depend on them.

### 7.5 Command and history model

Replace closure-only commands with serializable command records. The exact schema can evolve, but commands must contain:

- Stable command type.
- Target IDs.
- Validated arguments.
- Schema/version information where migration is required.
- Enough information for deterministic application and undo.

The command engine should expose:

- `apply(state, command)`.
- `canApply(state, command)` with a user-facing reason.
- `undo()` and `redo()`.
- A bounded history policy.
- Command coalescing for drag and trim gestures.
- A project-change signal for autosave.

The UI may keep transient drag state, hover state, and selection state outside the persisted project. Only committed commands change project data.

### 7.6 Cursor architecture

Cursor handling has two separate concerns:

1. **Cursor telemetry asset:** immutable source-time events captured during recording.
2. **Cursor effect ranges:** editable project metadata that controls how telemetry is presented.

The current global `canvas.cursorSettings` should be migrated to a full-duration cursor effect range. It must not remain the long-term model.

The target cursor effect needs to support:

- Enabled/disabled behavior.
- Preset identity.
- Size, opacity, fill, stroke, and shadow.
- Smoothing preset.
- Highlight/spotlight behavior.
- Separate left/right click treatment.
- Idle fade/hide behavior.
- Range/clip timing.
- Locked manual or generated ranges.

Create a pure `packages/cursor-core` only if it remains independently testable and reusable. It should own telemetry normalization, click-edge interpretation, source/output time lookup, smoothing, idle behavior, and coordinate fitting. The Rust renderer should mirror the same contract and be verified with shared JSON fixtures; it cannot import the TypeScript package at runtime.

### 7.7 Preview architecture

Preview is a compositor over proxy media, not a separate approximation of the final video.

```text
Project + playback time
  -> timeline/source time mapping
  -> proxy screen/camera/audio sources
  -> canvas transform
  -> zoom and crop
  -> camera composition
  -> cursor effects
  -> captions, masks, annotations
  -> preview canvas/video surface
```

The preview must:

- Use the same timeline mapping as export.
- Use a shared coordinate convention for screen, camera, cursor, masks, and captions.
- Avoid passing frames through React state.
- Keep high-frequency overlay updates imperative or isolated from broad Zustand rerenders.
- Show a clear unavailable state when metadata is missing instead of fabricating visual content.

### 7.8 Export architecture

The TypeScript render plan is a declarative description of the project. It must contain project and asset IDs, not arbitrary filesystem paths.

Rust must:

- Resolve asset IDs through the trusted project registry.
- Build the complete FFmpeg filter/render graph.
- Render to a `.partial` destination.
- Support cancellation between stages and during process supervision.
- Validate output with FFprobe.
- Atomically publish only a valid final output.
- Persist logs and compact failure diagnostics without leaking paths or secrets.

The graph must eventually cover:

- Screen source trims and ordering.
- Timeline gaps and speed.
- Separate microphone/system/music audio, gain, fades, mute, solo, and mix.
- Webcam crop, transform, shape, border, shadow, and visibility.
- Canvas background, padding, radius, shadow, and aspect ratio.
- Manual and smart zoom.
- Cursor telemetry and effect ranges.
- Captions, masks, and annotations.

### 7.9 Job architecture

Prepare and export jobs must use the same durable job platform described in `docs/specs/media-jobs-render-plan.md`.

- Persist job before starting work.
- Use one job ID from UI request through Rust worker completion.
- Persist serialized options and stage.
- Support cancellation, retry, restart recovery, and deduplication.
- Write partial outputs atomically.
- Emit compact progress events.
- End every job with a toast or jobs-drawer entry.

## 8. Implementation Phases

Each phase has a gate. A later phase may be prototyped against fixtures, but it must not be declared complete until its gate and required evidence pass.

### Phase 0 - Freeze Editor Truth And Fixtures

**Goal:** Convert the reference specification and current implementation audit into testable decisions before changing the data model.

**Dependencies:** None.

**Work packages:**

| Work package                                                                                                                                             | Primary locations                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Create a capability traceability matrix for every Tier 1, Tier 2, and Tier 3 feature                                                                     | This plan, reference specification                                                           |
| Resolve conflicts between project format, render plan, current timeline contracts, and the broader roadmap                                               | `docs/specs/project-format.md`, `docs/specs/media-jobs-render-plan.md`, `packages/contracts` |
| Define project version/discriminator policy and whether any persisted editor files already exist                                                         | `docs/specs/project-format.md`, `packages/contracts/src/project.ts`                          |
| Build synthetic media fixtures containing screen, camera, separate audio streams, non-16:9 dimensions, gaps, speed cases, captions, and cursor telemetry | `tooling/fixtures/**` or approved test fixture location                                      |
| Add fixture cases with no cursor metadata and imported MP4s without cursor metadata                                                                      | Fixture tooling, editor tests                                                                |
| Record current behavior for reopen, trim, split, ripple, cursor placement, camera state, and export                                                      | `docs/test-plans/**`, package tests                                                          |
| Add failing tests or reproducible cases for P0 misalignments                                                                                             | `packages/editor-core`, `packages/media-core`, Rust export tests                             |

**Acceptance criteria:**

- Every reference feature is classified as Tier 1, Tier 2, Tier 3, or deferred.
- Every current implementation is classified as keep, adapt, replace, or missing.
- Fixtures cover at least a five-minute project and the timing edge cases listed above.
- Project version collision is resolved in writing before durable project code starts.
- P0-1 through P0-5 have a red test or recorded reproduction.

**Fallback:** If synthetic media generation is delayed, use checked-in small fixtures, but do not use real user media or untracked local paths in automated tests.

### Phase 1 - Project Contracts And Durable Persistence

**Goal:** Make the editor durable before adding more effects or interactions.

**Dependencies:** Phase 0; recorder/library stable identities from the broader roadmap.

**Work packages:**

| Work package                                                                                                                                  | Primary locations                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Replace the project alias with a versioned project schema containing assets, roles, tracks, canvas, export settings, checksum, and timestamps | `packages/contracts/src/project.ts`, `packages/contracts/src/timeline.ts` |
| Add typed asset roles for screen, microphone, system audio, webcam, cursor events, captions, images, and future assets                        | `packages/contracts/src/project.ts`, `packages/contracts/src/media.ts`    |
| Define migration from the current generated timeline bootstrap shape to the durable project shape                                             | `packages/domain/src/timeline.ts`, contracts, docs                        |
| Implement Rust project load/save/create/rename/duplicate/delete/relink commands                                                               | `apps/desktop/src-tauri/src/projects/**`, `commands/**`                   |
| Add atomic writes, backup snapshots, checksum validation, and forward-only migrations                                                         | Rust projects module, `docs/specs/project-format.md`                      |
| Add SQLite project index and recording/project reference checks                                                                               | `src-tauri/src/database/**`                                               |
| Expand `editor-store` to hold project identity and save lifecycle rather than only `recordingId`                                              | `apps/desktop/src/stores/editor-store.ts`                                 |
| Load an existing project before falling back to a one-time recording bootstrap                                                                | `apps/desktop/src/stores/timeline-store.ts`, `src/lib/timeline.ts`        |
| Add debounced autosave after committed commands and manual save status                                                                        | editor stores, editor shell                                               |
| Add missing-asset and relink states                                                                                                           | editor project loader, project commands                                   |

**Acceptance criteria:**

- Opening a recording creates one stable project identity.
- Closing and reopening preserves cuts, markers, track settings, canvas settings, and cursor settings.
- Restarting the app preserves the last atomically saved project.
- A failed save keeps the last known good project and exposes an actionable error.
- Missing assets are visible and prevent export rather than being silently skipped.
- Project migrations preserve the original file before changing it.

**Tests and evidence:**

- Contract parse/serialize tests.
- Rust atomic-write and backup tests.
- Migration tests from every supported version.
- Reopen and app-restart integration tests.
- Missing-asset and relink tests.

**Fallback:** Keep recording bootstrap for new recordings, but never silently overwrite an existing project file.

### Phase 2 - Timeline Semantics And Command Engine Redesign

**Goal:** Establish deterministic editing behavior and authoritative time mapping.

**Dependencies:** Phase 1 project schema.

**Work packages:**

| Work package                                                                              | Primary locations                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Define source, timeline, and output time semantics                                        | `packages/domain`, `packages/editor-core`, `docs/specs/project-format.md` |
| Implement clip lookup and timeline/source/output conversion helpers                       | `packages/editor-core/src/time-mapping.ts` or equivalent                  |
| Convert closure commands into serializable discriminated command records                  | `packages/editor-core/src/commands.ts`                                    |
| Add command validation, lock checks, deterministic application, and inverse/undo behavior | `packages/editor-core/src/engine.ts`, `history.ts`                        |
| Cap history and coalesce high-frequency drag/trim commands                                | `packages/editor-core/src/history.ts`                                     |
| Add typed selection state for primary clip, selected clips, and selected range            | editor store/domain view state                                            |
| Define marker, caption, cursor, mask, and effect behavior under trim/split/ripple         | editor-core tests and contracts                                           |
| Define how gaps, speed, audio offsets, and track locks behave                             | render plan spec and editor-core                                          |

**Acceptance criteria:**

- The same project state and command sequence always produce the same result.
- Source-to-timeline mapping handles trim, split, gaps, and speed.
- Ripple delete moves eligible content and markers according to documented rules.
- Locked tracks are not changed by direct or ripple commands.
- Undo/redo restores state without creating new IDs or losing project metadata.
- Command records can be serialized and replayed from a test fixture.

**Tests and evidence:**

- Unit tests for every command.
- Property tests for split/trim/ripple invariants.
- Time-mapping table tests for speed, gaps, and source boundaries.
- Serialized command replay tests.
- History cap and coalescing tests.

**Fallback:** Ship only the subset of commands with proven time semantics; do not add UI controls for unsupported operations.

### Phase 3 - Real Editor Shell, Playback, And Timeline Rendering

**Goal:** Replace the current thin/static editor path with one project-aware editor shell and synchronized proxy playback.

**Dependencies:** Phase 1 and Phase 2; proxy and metadata preparation outputs.

**Work packages:**

| Work package                                                                                             | Primary locations                                                        |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Build top bar with project name, save state, undo/redo, export, and recovery/diagnostic status           | `features/editor/editor-view.tsx`, new editor shell components           |
| Add task-oriented sidebar tabs for media, captions, effects, layouts, and exports                        | editor shell and feature panels                                          |
| Make the right inspector contextual to the primary selection or canvas                                   | `features/editor/timeline/clip-inspector.tsx`, new inspector panels      |
| Consolidate the authoritative timeline renderer and remove duplicate/static render paths                 | `features/editor/timeline/**`, `timeline-view.tsx`                       |
| Synchronize video element play, pause, seek, timeupdate, and playback rate with timeline view state      | `features/editor/timeline/timeline-view.tsx`, `stores/timeline-store.ts` |
| Map playhead time to proxy source time through the shared time-mapping layer                             | editor-core, playback components                                         |
| Load proxy, original fallback, metadata, thumbnail manifest, and waveform peaks with four-state handling | `features/editor`, `src/lib/media.ts`, media contracts                   |
| Render a marker lane and marker interactions                                                             | timeline components, editor-core                                         |
| Add time ruler, timeline zoom, scroll, playhead, and keyboard focus semantics                            | timeline components                                                      |
| Virtualize tracks, clips, markers, captions, and thumbnail windows                                       | `features/editor/timeline/**`, TanStack Virtual or approved equivalent   |
| Keep transient playhead/drag/hover state out of project JSON                                             | stores and timeline components                                           |

**Acceptance criteria:**

- Opening a project shows its saved state without rebuilding it.
- Play/pause/seek controls move the actual proxy video and remain synchronized after cuts.
- The playhead and cursor/overlay time are based on timeline time, not raw source time.
- Thumbnails and waveform peaks are loaded from derivatives without decoding the entire source.
- A 60-minute fixture opens without freezing the UI.
- Loading, empty/missing derivative, content, and error/retry states are present.

**Tests and evidence:**

- React component tests for playback control and loading states.
- Browser/editor integration tests with synthetic proxy media.
- Time-mapping playback tests after trim and split.
- Timeline render performance measurement on 5-, 30-, and 60-minute fixtures.

**Fallback:** If full virtualization cannot land in one change, virtualize thumbnails and captions first, then tracks; do not accept a known unbounded render path as the final MVP implementation.

### Phase 4 - Core Editing Interactions

**Goal:** Make the basic editing workflow direct, keyboard-friendly, and non-destructive.

**Dependencies:** Phases 2 and 3.

**Work packages:**

| Work package                                                                                                              | Primary locations             |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Add trim handles and direct clip edge dragging                                                                            | `features/editor/timeline/**` |
| Add split at playhead with correct source ranges and effect ranges                                                        | editor-core, timeline UI      |
| Add clip move with snapping and collision rules                                                                           | editor-core, timeline UI      |
| Add range selection and range delete/ripple-delete                                                                        | editor-core, timeline UI      |
| Add multi-select with primary-selection inspector behavior                                                                | stores, timeline UI           |
| Add snapping to clip edges, playhead, markers, caption boundaries, and cursor click events                                | new editor-core snap helpers  |
| Add marker add/edit/delete and marker keyboard shortcut                                                                   | timeline UI, editor-core      |
| Add track mute, solo, lock, collapse, and height states                                                                   | timeline UI, commands         |
| Add required shortcuts: Space, S, Delete, Shift+Delete, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, M, arrows, and J/K/L where feasible | editor shell and timeline     |
| Add accessible keyboard alternatives for every drag-only operation                                                        | editor components, UI package |

**Acceptance criteria:**

- A user can remove a mistake using trim, split, delete, or ripple-delete without losing adjacent content.
- Dragging a clip or trim edge produces one coalesced undoable command.
- Snapping can be disabled and never moves content unexpectedly beyond the snap threshold.
- Multi-track selection and locked-track behavior are deterministic.
- All core edits survive close/reopen.

**Tests and evidence:**

- Command tests for all edit combinations.
- Snap threshold and priority tests.
- Keyboard interaction tests.
- Manual QA for 5-, 30-, and 60-minute projects.

**Fallback:** If arbitrary clip movement cannot be made safe, restrict movement to non-overlapping positions and show a clear conflict state rather than silently overwriting clips.

### Phase 5 - Cursor Asset, Cursor Core, And Cursor Effect Ranges

**Goal:** Bring the existing cursor implementation into alignment with the specification without discarding useful rendering work.

**Dependencies:** Phases 1 and 2; recorder cursor metadata contract.

**Existing behavior to preserve where valid:**

- Native cursor is omitted from the capture video.
- Rust captures relative cursor events and click information.
- React has a visual overlay with scale, click feedback, spotlight, and smoothing behavior.
- Rust has a cursor raster/compositing path for export.

**Work packages:**

| Work package                                                                                                                                         | Primary locations                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Define versioned cursor telemetry asset metadata: source dimensions, capture bounds, DPI/scale, timebase, schema version, and stable asset reference | `packages/contracts/src/cursor.ts`, project/media contracts   |
| Persist cursor telemetry as a registered asset and make it recoverable/checkpointed with the recording session                                       | `src-tauri/src/capture/cursor.rs`, manifest/recovery/database |
| Fix click capture to distinguish button edges from button-held samples where possible                                                                | `src-tauri/src/capture/cursor.rs`                             |
| Define coordinate fitting and visibility behavior for non-16:9, DPI-scaled, and partially out-of-bounds sources                                      | cursor contracts, docs/specs                                  |
| Add pure telemetry normalization, event lookup, smoothing presets, idle behavior, and coordinate transforms                                          | proposed `packages/cursor-core`                               |
| Mirror the cursor-core contract in Rust and verify with shared JSON fixtures                                                                         | `src-tauri/src/exports/cursor.rs`, new Rust module if needed  |
| Add a cursor track or range-effect collection to the project model                                                                                   | contracts, domain, editor-core                                |
| Migrate current global canvas cursor settings into a full-duration default cursor range                                                              | project migration/bootstrap                                   |
| Add cursor range creation, split, resize, preset application, locking, and deletion                                                                  | editor-core, cursor timeline UI                               |
| Expand inspector to edit enabled state, presets, opacity, smoothing, highlight, left/right clicks, and idle behavior                                 | `cursor-inspector.tsx`                                        |
| Make missing telemetry render no cursor with an explicit unavailable state                                                                           | `custom-cursor-overlay.tsx`                                   |
| Make preview use the same output-to-source mapping and aspect-fit transform as export                                                                | React overlay and Rust renderer                               |
| Add cursor effect data to the render plan through asset/effect IDs, not a path or hidden recording lookup                                            | `packages/media-core`, export contracts                       |

**Acceptance criteria:**

- Completed and recovered recordings expose cursor telemetry through the project asset registry.
- A recording without telemetry never displays a fabricated centered cursor.
- Cursor preview and export agree after trim, split, ripple-delete, speed, and non-16:9 canvas changes.
- Current baseline scale, click, spotlight, and smoothing behaviors remain available or have an explicit replacement.
- Cursor effects can differ across timeline ranges and survive reopen.
- Idle hiding and left/right click behavior are either implemented or the controls remain absent/disabled.

**Tests and evidence:**

- Cursor schema and migration tests.
- Telemetry atomic write, checkpoint, pause/resume, and recovery tests.
- Click-edge and visibility tests.
- Shared TypeScript/Rust fixture tests for event lookup and coordinate fitting.
- Preview/export golden-frame tests after timeline edits.

**Fallback:** If a shared runtime algorithm is not practical across TypeScript and Rust, keep mirrored implementations with mandatory shared fixtures and tolerance-based parity tests. Do not maintain two undocumented behaviors.

### Phase 6 - Manual Zoom, Camera Composition, Canvas, And Audio Polish

**Goal:** Implement the visual and audio polish that makes the editor useful for screen stories.

**Dependencies:** Phases 2, 3, and 4; cursor time semantics from Phase 5 where zoom targets use cursor data.

**Work packages:**

| Work package                                                                                                               | Primary locations                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Add manual zoom segments with target rectangle, scale, timing, easing, and safe-edge clamping                              | contracts, editor-core, `features/editor`               |
| Render manual zoom consistently in preview and render plan                                                                 | preview compositor, `packages/media-core`, Rust exports |
| Render secondary video/camera clips in the preview                                                                         | timeline preview components                             |
| Add direct manipulation and numeric inspector controls for camera position, size, crop, shape, opacity, border, and shadow | `clip-inspector.tsx`, camera components                 |
| Add canvas background, padding, corner radius, shadow, and 16:9/1:1/9:16 framing                                           | canvas contracts, preview, inspector                    |
| Add camera visibility ranges and camera mute/hide behavior                                                                 | editor-core, timeline UI                                |
| Split audio into semantic microphone/system-audio/music roles where source metadata allows                                 | domain, contracts, project asset registry               |
| Implement track/clip gain, mute, solo, fades, and preview synchronization                                                  | audio components, editor-core                           |
| Wire audio fades and mix behavior into the render plan instead of storing state only                                       | `packages/media-core`, Rust exports                     |
| Replace or integrate unused `pip-controls.tsx` into the authoritative inspector path                                       | editor feature files                                    |

**Acceptance criteria:**

- A webcam clip is visible in preview with the same transform that export uses.
- Canvas styling changes the preview and are represented in the project file.
- Manual zoom ranges can be edited, split, locked, and undone.
- Separate audio tracks preview with mute/solo/volume behavior that matches export semantics.
- Basic canvas and audio controls are not presented as working unless their render path is implemented.

**Tests and evidence:**

- Camera transform and crop unit tests.
- Canvas aspect-ratio and coordinate transform tests.
- Audio gain/fade/mute/solo plan tests.
- Preview/export golden media tests for camera, zoom, and canvas.
- Manual QA on 16:9, square, vertical, non-16:9 source, and no-webcam projects.

**Fallback:** Ship camera and canvas features only for the transforms that have preview/export parity. Hide unsupported styling options rather than persisting state that export ignores.

### Phase 7 - Captions, Masks, And Lightweight Annotations

**Goal:** Add communication and privacy features without introducing a general motion-graphics system.

**Dependencies:** Phases 1 through 4 and the preview/render composition foundations from Phase 6.

**Work packages:**

| Work package                                                                                              | Primary locations                             |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Import and validate SRT/VTT with normalized timing                                                        | contracts, `packages/domain`, editor lib      |
| Add caption track creation, text/timing editing, safe-area placement, and style presets                   | editor features, editor-core                  |
| Render captions in preview and as burn-in or sidecar export                                               | preview compositor, media-core, Rust exports  |
| Add static rectangle blur and pixelation/redaction masks                                                  | contracts, editor-core, preview, Rust exports |
| Add mask timing, position, resize, and direct manipulation                                                | mask feature components                       |
| Add text callouts, arrows, outline highlights, spotlight regions, and numbered steps                      | annotation contracts and components           |
| Define whether annotations are rasterized, vector-rendered, or represented as FFmpeg draw/overlay filters | render plan spec and ADR if needed            |
| Add explicit missing-font/style and invalid-caption handling                                              | editor UI and export validation               |

**Acceptance criteria:**

- SRT/VTT import produces editable caption clips without changing original media.
- Caption text and timing survive reopen and export correctly.
- Masks cover the intended source region across timeline ranges and are present in final output.
- Export is blocked or clearly warns when a caption/mask/annotation cannot be rendered safely.
- No sensitive source content is logged during preview or export.

**Tests and evidence:**

- SRT/VTT parser and malformed-input tests.
- Caption timing and split/ripple tests.
- Mask coordinate and range tests.
- Caption burn-in and mask golden-frame export tests.
- Manual QA with sensitive UI fixture.

**Fallback:** Deliver caption import and static masks before annotations. Keep advanced animated annotation behavior deferred rather than creating a second motion system.

### Phase 8 - Complete Render Plan And Durable Export

**Goal:** Make final export an accurate, secure, cancellable rendering of the saved project.

**Dependencies:** Phases 1 through 7 for the features included in the selected release; durable job scheduler from the broader roadmap.

**Work packages:**

| Work package                                                                                                                               | Primary locations                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Replace `recordingId`/path-based export input with `projectId` and trusted asset/effect references                                         | `packages/contracts`, `packages/media-core`, Rust command DTOs |
| Make `buildRenderPlan()` include every supported clip, effect, gap, source range, speed, audio role, and canvas transform                  | `packages/media-core/src/render-plan.ts`                       |
| Add render-plan schema validation on both TypeScript and Rust boundaries                                                                   | contracts, `src/lib/ipc.ts`, Rust validation                   |
| Build the FFmpeg filter graph for screen cuts, gaps, speed, audio, camera, canvas, zoom, cursor, captions, masks, and annotations          | `src-tauri/src/exports/**`                                     |
| Resolve asset IDs to canonical paths in Rust and reject missing or unauthorized assets                                                     | Rust projects/path policy/exports                              |
| Integrate export with the durable scheduler and use one job identity end-to-end                                                            | `src-tauri/src/jobs/**`, `commands/exports.rs`                 |
| Add `.partial` output, FFprobe validation, atomic publish, cleanup, cancellation, retry, and failure diagnostics                           | Rust exports/jobs                                              |
| Replace disconnected export controls with one flow for preset, range, destination, progress, cancellation, reveal, and completion feedback | `features/export/**`, app shell                                |
| Implement capability-driven presets: fast share, balanced, high quality, vertical, square, and selected-range export where valid           | export contracts/UI/Rust profiles                              |
| Preserve intentional timeline gaps and use the same output-time mapping as preview                                                         | media-core and Rust tests                                      |

**Acceptance criteria:**

- A saved project can be exported without React supplying a media path.
- Final output contains every enabled supported effect represented in the project.
- Preview and export agree within defined video-frame, geometry, timing, and audio tolerances.
- Cancellation never publishes a corrupt or partial final file.
- Failed jobs can be retried without duplicate job identity or stale published output.
- Export settings shown in the UI are the settings used by Rust.
- Output duration, streams, and A/V alignment are FFprobe-validated.

**Tests and evidence:**

- Cross-language render-plan fixtures.
- Golden-media tests for trim, split, gaps, speed, audio, camera, canvas, cursor, captions, masks, and combined effects.
- Export cancellation and partial-output tests.
- Missing-asset and path-containment tests.
- Windows manual render tests on the baseline low-end machine.

**Fallback:** If the full graph is not ready, ship only a clearly scoped export subset whose preview is also limited to that subset. Never present ignored effects as exported behavior.

### Phase 9 - Smart Zoom And Modern Editor Differentiation

**Goal:** Add the reference specification's primary differentiation after cursor metadata, timeline semantics, and render parity are trustworthy.

**Dependencies:** Phases 2, 5, 6, and 8.

**Work packages:**

| Work package                                                                              | Primary locations                                                                 |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Define click, dwell, movement, and safe-edge input features                               | cursor-core/editor-core                                                           |
| Generate editable zoom suggestions from cursor/click metadata                             | proposed zoom module in `packages/editor-core` or a separate package if justified |
| Add zoom presets: subtle, product demo, cinematic, manual only                            | contracts, cursor/zoom inspector                                                  |
| Support locked manual/auto segments and regeneration that preserves locked segments       | editor-core commands                                                              |
| Add follow-cursor mode only after target clamping is stable                               | zoom model and preview                                                            |
| Add aspect-ratio-aware zoom target calculations                                           | canvas/time mapping/render plan                                                   |
| Add transcript-linked navigation and richer caption styling only if caption MVP is stable | caption feature                                                                   |
| Add audio normalization, voice emphasis, and ducking presets behind capability checks     | audio model, Rust render filters                                                  |
| Add vertical/social export presets using the same canvas model                            | export UI and render graph                                                        |

**Acceptance criteria:**

- Generated zooms are suggestions represented as editable project metadata.
- Manual and locked segments are not overwritten by regeneration.
- Zoom targets remain within the visible canvas and do not jump across aspect ratios.
- Smart zoom preview/export parity passes golden tests.
- A project without cursor telemetry receives a clear unavailable state rather than fabricated smart zooms.

**Fallback:** Keep smart zoom behind a feature flag and ship reliable manual zoom if generation quality or performance does not meet the acceptance threshold.

### Phase 10 - Performance, Accessibility, And Release Hardening

**Goal:** Prove the editor is usable for real projects on the target machine and remove misleading or inaccessible surfaces.

**Dependencies:** All release-target feature phases.

**Work packages:**

| Work package                                                                                                                     | Primary locations                       |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Profile timeline render, Zustand subscriptions, overlay updates, IPC payloads, and media asset loading                           | desktop editor, stores, docs benchmarks |
| Validate 5-, 30-, 60-, and 120-minute projects with many clips, markers, captions, and effects                                   | fixture tooling, benchmarks             |
| Add keyboard navigation and screen-reader labels for editor transport, timeline, inspector, and direct manipulation alternatives | editor features and `packages/ui`       |
| Add visible focus, reduced motion, sufficient contrast, and caption safe-area readability                                        | UI styles and editor components         |
| Ensure every async editor/job surface uses skeleton -> content or empty or error with retry                                      | editor/project/media/export features    |
| Add save, render, export, and missing-media feedback through toasts/jobs drawer                                                  | app shell, jobs store                   |
| Remove or disable every control whose backend behavior is not implemented                                                        | editor/export/settings UI               |
| Add desktop component tests and Tauri/WebDriver flow coverage where browser tests cannot cover native behavior                   | test harness/workflows                  |
| Run security review for asset resolution, export paths, project relinking, diagnostics, and logs                                 | Rust path policy, exports, diagnostics  |

**Acceptance criteria:**

- A 60-minute project remains responsive under the documented frame and interaction budgets.
- Core editor operations are keyboard accessible.
- No visible control lies about support for a feature.
- Async loading, empty, missing, error, retry, saving, and exporting states are complete.
- Performance and manual QA results are recorded for the baseline Windows machine.
- No P0/P1 editor or export defect remains open for the selected release tier.

## 9. Contract And Module Impact Map

### 9.1 Existing files to refactor

| Area              | Files                                                                        | Planned change                                                                            |
| ----------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Editor shell      | `apps/desktop/src/features/editor/editor-view.tsx`                           | Project-aware shell, top bar, save/export state, panel routing                            |
| Timeline UI       | `apps/desktop/src/features/editor/timeline/**`                               | One authoritative renderer, playback, interactions, virtualization, inspector integration |
| Cursor UI         | `apps/desktop/src/features/editor/cursor/**`                                 | Range-aware effects, unavailable state, shared mapping semantics                          |
| Editor stores     | `apps/desktop/src/stores/editor-store.ts`, `timeline-store.ts`               | Project lifecycle, durable save, selected ranges, playback/time mapping                   |
| Timeline helpers  | `apps/desktop/src/lib/timeline.ts`                                           | Validated commands, project loading, time mapping, render-plan request                    |
| Project contracts | `packages/contracts/src/project.ts`, `timeline.ts`                           | Durable project, assets, typed tracks, effects, render DTOs                               |
| Cursor contracts  | `packages/contracts/src/cursor.ts`                                           | Telemetry asset metadata and range effect model                                           |
| Domain mapping    | `packages/domain/src/timeline.ts`                                            | Bootstrap/migration path and semantic source roles                                        |
| Command engine    | `packages/editor-core/src/commands.ts`, `engine.ts`, `history.ts`            | Serializable commands, time semantics, lock/snap/range rules                              |
| Render planning   | `packages/media-core/src/render-plan.ts`                                     | Complete project-derived asset-ID render plan                                             |
| Media preparation | `apps/desktop/src-tauri/src/media/**`, `jobs/**`                             | Derivative readiness, recipes, scheduler integration                                      |
| Projects          | `apps/desktop/src-tauri/src/database/**`, new `projects/**`                  | CRUD, migration, atomic files, SQLite index                                               |
| Capture cursor    | `apps/desktop/src-tauri/src/capture/cursor.rs`, `manifest.rs`, `recovery.rs` | Registered durable telemetry asset and recovery behavior                                  |
| Cursor export     | `apps/desktop/src-tauri/src/exports/cursor.rs`                               | Shared contract, range effects, time/coordinate parity                                    |
| Export            | `apps/desktop/src-tauri/src/exports/**`, `commands/exports.rs`               | Complete render graph, durable jobs, validation, cancellation                             |
| Export UI         | `apps/desktop/src/features/export/**`                                        | One connected, truthful export workflow                                                   |

### 9.2 Proposed new modules

These are proposals to keep boundaries clear, not permission to create a large speculative abstraction layer.

| Proposed module                                   | Purpose                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/desktop/src-tauri/src/projects/**`          | Rust project CRUD, file persistence, migration, asset resolution                          |
| `apps/desktop/src/features/editor/project/**`     | Project loading, save state, missing asset/relink UI                                      |
| `apps/desktop/src/features/editor/playback/**`    | Video/audio synchronization and timeline/source mapping                                   |
| `apps/desktop/src/features/editor/preview/**`     | Canvas and effect compositor surface                                                      |
| `apps/desktop/src/features/editor/captions/**`    | SRT/VTT import, edit, styling, safe area                                                  |
| `apps/desktop/src/features/editor/masks/**`       | Redaction/blur range workflow                                                             |
| `apps/desktop/src/features/editor/annotations/**` | Lightweight instructional overlays                                                        |
| `packages/cursor-core/**`                         | Pure telemetry normalization and cursor-effect algorithms if shared boundary is justified |
| `tooling/fixtures/**`                             | Synthetic project/media/cursor fixtures                                                   |
| `tests/editor/**`                                 | Cross-package and desktop editor integration tests                                        |

Do not add `zoom-core` or `render-core` automatically. Start with `packages/editor-core` for zoom algorithms and `packages/media-core` for render-plan construction. Split packages only when independent ownership or test/runtime boundaries make the split useful.

## 10. Test Strategy

### 10.1 Unit tests

| Area              | Required tests                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Project contracts | Parse, default, migration, checksum, missing asset, round-trip serialization                 |
| Timeline commands | Trim, split, move, delete, range delete, ripple, markers, locks, selection, undo/redo        |
| Time mapping      | Source/timeline/output mapping, speed, gaps, split clips, boundaries                         |
| Snapping          | Priority, threshold, disabled snapping, marker/caption/click targets                         |
| Cursor            | Telemetry normalization, click edges, smoothing, idle hiding, visibility, coordinate fitting |
| Zoom              | Safe-edge clamping, easing, manual updates, generated suggestion locking                     |
| Captions          | SRT/VTT parsing, timing edits, split/ripple behavior, safe-area placement                    |
| Canvas            | Aspect-ratio transforms, padding, radius, camera placement, crop                             |
| Audio             | Gain, fades, mute/solo, track roles, source offsets                                          |
| Render planning   | Asset IDs, gaps, speed, effects, overlay ranges, preset validation                           |

### 10.2 Integration tests

- Create a project from a completed recording and reopen it.
- Autosave, close, restart, and recover the same project.
- Prepare proxy, thumbnails, and waveforms, then load them in the editor.
- Trim/split/ripple a project and verify preview source positions.
- Load camera and separate audio assets and preserve their roles.
- Load cursor telemetry and verify source/output mapping after edits.
- Import captions, edit them, reopen, and export.
- Add masks and verify their location after timeline edits.
- Build a render plan and validate it in both TypeScript and Rust.
- Start, cancel, retry, and restart an export job.

### 10.3 Preview/export parity tests

Use deterministic fixtures with known frame content and known cursor/caption/mask coordinates. Compare:

- Frame selection after trim/split/ripple.
- Cursor position and click effect at selected times.
- Camera geometry and canvas transform.
- Zoom target and scale.
- Caption baseline and timing.
- Mask bounds and timing.
- Audio duration, gain, fades, and silence gaps.

Define tolerances before writing golden assertions. Differences outside those tolerances are defects, not expected implementation variance.

### 10.4 Performance tests

- Open 5-, 30-, and 60-minute projects.
- Render projects with thousands of markers/caption ranges.
- Scrub while cursor, captions, camera, and masks are visible.
- Measure React commits during drag and playback.
- Measure memory used by thumbnails, waveforms, and telemetry.
- Export while the jobs drawer and library remain responsive.

### 10.5 Manual QA matrix

- Full-screen 16:9 recording.
- Window/region recording with non-16:9 dimensions.
- Recording with webcam.
- Recording with separate microphone and system audio.
- External MP4 without cursor metadata.
- Recovered recording after forced exit.
- 30-minute tutorial with captions and markers.
- 60-minute project with many zoom/cursor ranges.
- Vertical and square exports.
- Sensitive information covered by masks.

## 11. Cross-Cutting Quality Rules

Every editor feature must satisfy these rules:

- Original media remains immutable.
- Project changes are explicit commands and are autosaved.
- No feature is complete if it exists only in the schema or inspector.
- Preview and export must either share semantics or be explicitly limited to the same supported subset.
- Rust owns filesystem access, media processing, path resolution, and export security.
- React receives compact validated data and never receives raw frames/audio buffers.
- File paths are resolved from trusted project assets, not accepted from arbitrary React input.
- Missing media produces a visible actionable state.
- Every background job reports completion, failure, cancellation, or retry.
- Every async surface renders skeleton, content, empty/missing, and error/retry states as appropriate.
- Every icon-only control uses the shared accessible icon-button primitive.
- Every drag interaction has a keyboard or numeric alternative.
- Unsupported controls are absent or visibly disabled with a reason.
- No sensitive media content, telemetry, credentials, or unrestricted paths are written to logs.

## 12. Editor MVP Definition Of Done

The Tier 1 editor MVP is complete only when a user can:

1. Open a stable project from a completed or recovered recording.
2. Close and reopen the project without losing edits.
3. Play and seek proxy media using edited timeline time.
4. Trim, split, move, delete, and ripple-delete clips.
5. Undo and redo all supported edits deterministically.
6. Use markers, snapping, selection, and keyboard editing controls.
7. Apply manual zoom segments and preview them correctly.
8. Apply cursor scale, click effects, and spotlight without preview/export drift.
9. Position and style a webcam overlay in preview and export.
10. Adjust canvas background, padding, radius, shadow, and basic aspect ratio.
11. Adjust microphone/system audio gain, mute, solo, and fades.
12. Import and edit SRT/VTT captions.
13. Add static blur or redaction masks.
14. Export the saved project to a validated local MP4.
15. Recover from missing derivatives, failed saves, and failed/cancelled exports without silent data loss.
16. Complete the core workflow on a 60-minute fixture within the documented performance budget.

## 13. Modern Editor Definition Of Done

The Tier 2 modern editor release adds:

- Cursor smoothing presets, idle behavior, separate click behavior, and range-aware cursor effects.
- Smart zoom suggestions from cursor and click metadata.
- Locked and regenerable auto effects.
- Transcript-linked caption navigation and richer styles.
- Aspect-ratio scenes and social export presets.
- Audio normalization, voice emphasis, and ducking presets where the render graph supports them.
- Per-segment masks and improved sensitive-area workflow.
- Preview/export parity evidence for every enabled effect.

Smart zoom is not allowed to block the durable Tier 1 editor. It is a post-foundation feature because it depends on cursor telemetry, stable time mapping, canvas transforms, and reliable render parity.

## 14. Execution Rules For Coding Tasks

Implement this plan as bounded milestones, not as one editor rewrite.

Recommended task order:

1. Phase 0 contract decisions and fixtures.
2. Project schema and persistence.
3. Time mapping and serializable command engine.
4. Playback and timeline consolidation.
5. Core edit interactions.
6. Cursor asset/range/parity work.
7. Manual zoom, camera, canvas, and audio.
8. Captions, masks, and annotations.
9. Complete render plan and durable export.
10. Smart zoom and modern features.
11. Performance, accessibility, and release hardening.

Each coding task should identify:

- The phase and acceptance criteria it advances.
- The exact existing files it changes.
- Any new contract or migration it requires.
- Unit/integration/manual tests to run.
- Whether it changes preview, export, or both.
- Whether it changes persisted project data.

No task may claim a feature complete when it updates only a schema, command, inspector, or preview without connecting the full required path.

## 15. Final Traceability

| Reference specification area              | This plan coverage                                      |
| ----------------------------------------- | ------------------------------------------------------- |
| Product positioning and goals             | Sections 3 and 4                                        |
| Tier 1/2/3 feature scope                  | Section 3.3 and Phases 6-9                              |
| Editor shell and information architecture | Phase 3                                                 |
| Timeline model and interactions           | Sections 7.3-7.5 and Phase 4                            |
| Smart zoom                                | Phase 9                                                 |
| Cursor effects                            | Section 7.6 and Phase 5                                 |
| Captions                                  | Phase 7                                                 |
| Webcam and canvas                         | Phase 6                                                 |
| Audio                                     | Phase 6 and Phase 8                                     |
| Masks and annotations                     | Phase 7                                                 |
| Export workflow                           | Sections 7.8-7.9 and Phase 8                            |
| Performance                               | Phase 3 and Phase 10                                    |
| Error/recovery behavior                   | Phases 1, 8, and 10                                     |
| Accessibility                             | Phase 10 and cross-cutting rules                        |
| Unit/integration/manual test plan         | Section 10                                              |
| Suggested milestone order                 | Section 14, reordered to protect persistence and parity |
| Definition of done                        | Sections 12 and 13                                      |

## 16. Plan Completion Criteria

This development plan is considered ready for implementation when:

- The project-version decision is approved.
- Tier 1 versus Tier 2 scope is approved.
- The current cursor telemetry asset and recovery contract is approved.
- Time semantics and gap/ripple rules are approved.
- Synthetic fixtures exist or have an assigned implementation task.
- Phase 1 has explicit contract and migration tasks.
- No current editor or cursor behavior is assumed to be correct solely because it exists in the repository.
