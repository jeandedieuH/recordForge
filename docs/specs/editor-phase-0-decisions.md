# Editor Phase 0 Decisions

> **Status:** Phase 0 baseline decisions
> **Scope:** Decisions required before changing editor contracts or persisted project data
> **Related:** `recordforge-editor-specification.md`, `record-forge-editor-development-plan.md`

These decisions freeze the editor direction for implementation. They are intentionally narrow. They do not implement the project format or render graph; those changes belong to later phases and must follow these constraints.

## 1. Editor Is Project-First

**Decision:** A saved project is the source of truth for editor state. The recording is immutable source media.

**Implications:**

- Opening an existing project must load `project.json` rather than regenerate a timeline.
- Timeline edits, canvas settings, cursor settings, captions, masks, and export settings are project metadata.
- Recording-to-timeline generation remains only a first-open bootstrap path.
- Project identity must remain stable across close/reopen and application restart.

## 2. Runtime State And Persisted State Have Separate Versions

**Decision:** The current `TimelineState.version = 1` is treated as an in-memory runtime shape, not as a durable file format.

**Implications:**

- The durable project format gets an explicit format discriminator before persistence is implemented.
- The durable project version follows the project-format specification after confirming that no shipped project files depend on the current runtime shape.
- Runtime view state such as playhead, scroll, zoom, hover, and selection is not persisted as project content.
- If existing project files are discovered, a migration is required rather than a silent reinterpretation.

## 3. Asset IDs Cross The IPC Boundary

**Decision:** React and TypeScript render plans send project IDs, asset IDs, and validated render settings. Rust resolves media paths from the trusted project asset registry.

**Implications:**

- `outputPath` remains a one-time user-selected destination subject to path policy.
- Source media paths are not accepted from the editor render plan.
- Missing assets produce an actionable project state and block export.
- Cursor telemetry is a registered asset, not an implicit filename looked up from a recording work directory.

## 4. Timeline Time Is Authoritative

**Decision:** Timeline time is the user-facing editing coordinate. Source time and output time are derived through explicit mappings.

**Implications:**

- Preview, cursor overlay, audio preview, and export use the same mapping functions.
- Intentional timeline gaps are preserved in output unless explicitly ripple-deleted.
- Speed changes alter the mapping and rendered duration.
- Split, trim, ripple-delete, and range effects must define how markers and effect ranges move.
- A cursor event is never looked up using raw playhead time without mapping through the selected source clip.

## 5. Semantic Tracks Replace A Generic Effects Bucket

**Decision:** New editor behavior uses explicit semantic roles for screen, camera, microphone, system audio, music, zoom, cursor, captions, masks, and annotations. Markers remain a top-level project collection rendered in a dedicated marker lane.

**Implications:**

- The current generic `audio` and `effects` kinds are migration targets, not the long-term extension point.
- Each semantic role has a validated data shape and render behavior.
- New features are not added as untyped metadata on arbitrary clips.
- Canonical persisted track kinds are `screen`, `camera`, `microphone`, `system-audio`, `music`, `captions`, `cursor`, `zoom`, `masks`, and `annotations`.
- Canonical asset roles use the storage-oriented names `screen`, `webcam`, `microphone`, `system_audio`, `cursor_events`, `caption`, and `image`. The reference shorthand `mic` maps to `microphone` at the contract boundary.
- The reference model's top-level `effects.zoom` and `effects.cursor` fields are treated as a logical grouping, while the persisted timeline representation uses the semantic `zoom` and `cursor` tracks defined here. Phase 1 must make that relationship explicit in the durable schema.
- Phase 0 effect fixtures use a common `id`, `kind`, `startMs`, `durationMs`, and `locked` range shape. Zoom ranges additionally contain `scale`, `easing`, and `target`; mask ranges contain `mode`, `shape`, `x`, `y`, `width`, and `height`. These are fixture invariants until Phase 1 publishes the Zod contract.

## 6. Cursor Telemetry And Cursor Effects Are Different Data

**Decision:** Cursor telemetry is immutable source metadata. Cursor visual treatment is editable range-based project metadata.

**Implications:**

- The current global `canvas.cursorSettings` is migrated to a full-duration cursor effect range.
- Later ranges may override the default with a preset or partial patch.
- Cursor telemetry must carry source dimensions, timebase, schema version, and stable identity.
- Missing telemetry means no cursor overlay and a visible unavailable state, not a centered synthetic cursor.

## 7. Existing Cursor Rendering Is Reusable, Not Authoritative

**Decision:** Keep current React and Rust cursor rendering primitives only where parity fixtures prove they agree with the target model.

**Implications:**

- Existing scale, click feedback, spotlight, and smoothing are candidate baseline behaviors.
- Presets, idle behavior, click-button handling, time mapping, and coordinate fitting require verification or redesign.
- Preview and export must be tested against the same deterministic telemetry fixtures.

## 8. Preview And Export Must Share A Supported Subset

**Decision:** A feature is not exposed as complete until preview and export both support the same semantics.

**Implications:**

- State-only fields are not presented as working controls.
- If the render graph supports only a subset temporarily, preview is constrained to that subset and the limitation is visible.
- Golden fixtures define parity tolerances for geometry, timing, and audio.

## 9. Tier 1 And Tier 2 Boundary

**Decision:** Tier 1 includes durable editing, manual zoom, basic cursor effects, camera/canvas composition, caption import, static masks, and validated MP4 export. Smart zoom and generated captions remain Tier 2 or later.

**Implications:**

- Smart zoom does not block the durable Tier 1 editor.
- Cursor telemetry and time mapping still need to be correct before smart zoom is attempted.
- Advanced audio presets, transcript navigation, and social presets are added only after render parity is stable.

## 10. Fixture Policy

**Decision:** Editor tests use deterministic synthetic media and metadata, not user recordings or machine-specific absolute paths.

**Implications:**

- Generated media is ignored by Git and recreated by the fixture command.
- Checked-in JSON/SRT fixtures describe the project, cursor, and caption edge cases.
- Fixtures include screen, camera, separate microphone/system audio, non-16:9 dimensions, an intentional gap, speed metadata, captions, and cursor telemetry.
- The optional `--include-long` fixture creates a five-minute project for performance work without making every fast test regenerate a large file.
- Windows/manual evidence remains required for capture, A/V sync, FFmpeg behavior, and long-project performance.
