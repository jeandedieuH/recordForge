# Editor P0 Reproductions

> **Status:** Phase 0 baseline
> **Scope:** Reproducible editor and export correctness failures identified during the editor implementation audit
> **Related:** `docs/specs/editor-capability-matrix.md`

These are baseline reproductions. They describe current behavior before the Phase 1-8 fixes. They are not claims that the current implementation should remain unchanged.

## Summary

| ID   | Failure                                              | Current status              | Reproduction                                                                 | Planned fix                             |
| ---- | ---------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| P0-1 | Project edits disappear after reopen                 | Confirmed by code path      | Open a recording, edit it, leave editor, reopen the same recording           | Phase 1 project persistence             |
| P0-2 | Preview and export use different cursor time mapping | Confirmed by code path      | Split/trim a recording, inspect cursor at edited time, export, compare frame | Phases 2, 5, and 8 shared mapping       |
| P0-3 | Render plan drops supported editor state             | Confirmed by plan shape     | Build a project with camera/canvas/captions/masks/zoom and inspect plan      | Phase 8 complete render plan            |
| P0-4 | Export is not project/asset authoritative            | Confirmed by contract       | Parse an export request using only a recording ID and arbitrary destination  | Phases 1 and 8 asset-ID path resolution |
| P0-5 | Export job cannot be reliably cancelled or resumed   | Confirmed by implementation | Start export, request cancellation, inspect job IDs and partial output       | Phase 8 durable export job              |

## P0-1: Project Edits Are Not Durable

### Steps

1. Open a completed library recording in the editor.
2. Split the screen clip at a visible point.
3. Delete or ripple-delete one side of the split.
4. Change a track setting or cursor setting.
5. Navigate away from the editor.
6. Reopen the same recording.

### Current result

`timeline-store.load()` calls `createTimelineFromRecording()` and creates a new in-memory command engine. `editor-store` stores only the recording ID. The edited timeline, cursor settings, and history are not loaded from a project file.

### Expected result after Phase 1

The same stable project is loaded. All committed edits and settings are present, and the save indicator reports the last durable state.

### Evidence

- `apps/desktop/src/stores/editor-store.ts`
- `apps/desktop/src/stores/timeline-store.ts`
- `packages/contracts/src/project.ts`
- `packages/domain/src/timeline.ts`

## P0-2: Cursor Preview/Export Time Divergence

### Steps

1. Use the checked-in editor fixture and its cursor telemetry.
2. Create a screen clip with a source range that is split into two timeline clips.
3. Place the playhead in the second clip at an output time that differs from its source time.
4. Compare the React cursor overlay position with the cursor position in an export frame.
5. Repeat after a ripple delete and with a non-16:9 source.

### Current result

The React overlay looks up telemetry using playhead time directly. The Rust export path maps output time through render segments. The coordinate fitting logic also differs between React and Rust. The same cursor event can therefore appear at different positions or times.

### Expected result after Phase 5/8

Preview and export use the same source/timeline/output mapping and coordinate transform within documented tolerances.

### Evidence

- `apps/desktop/src/features/editor/cursor/custom-cursor-overlay.tsx`
- `apps/desktop/src/features/editor/timeline/timeline-view.tsx`
- `apps/desktop/src-tauri/src/exports/cursor.rs`

## P0-3: Render Plan Drops Editor State

### Steps

1. Construct a project fixture with a camera clip, canvas padding/radius, audio fade, caption, mask, and zoom range.
2. Call `buildRenderPlan()` for the project.
3. Inspect the returned plan and compare it with the project state.

### Result before Phase 8

The plan represented screen segments and audio tracks, with limited overlay support. Camera overlays, canvas composition, captions, masks, zoom, speed, fades, and annotations were absent or not consumed by Rust.

### Result after Phase 8

Every supported project field either appears in the validated render plan and final filter graph or is not exposed as an enabled feature.

### Evidence

- `packages/media-core/src/render-plan.ts`
- `packages/contracts/src/timeline.ts`
- `apps/desktop/src-tauri/src/exports/mod.rs`
- `apps/desktop/src-tauri/src/exports/cursor.rs`

## P0-4: Export Is Not Project/Asset Authoritative

### Steps

1. Construct an export request using an arbitrary `outputPath` and a recording ID rather than a project ID.
2. Parse the request through the current TypeScript contract.
3. Observe that the request has no project asset registry reference and that Rust resolves the source from the recording database row.

### Result before Phase 8

`exportTimelineOptionsSchema` included `outputPath` and `recordingId`, while the render plan was not rooted in a durable project asset registry.

### Result after Phase 8

React supplies a project ID, asset IDs, and a user-selected destination. Rust validates the destination and resolves all source paths from the project registry with canonical containment checks.

### Evidence

- `packages/contracts/src/timeline.ts`
- `packages/media-core/src/render-plan.ts`
- `apps/desktop/src-tauri/src/commands/exports.rs`
- `docs/specs/media-jobs-render-plan.md`

## P0-5: Export Job Identity And Cancellation

### Steps

1. Start a timeline export.
2. Observe the job ID emitted by the command path.
3. Observe the job ID created inside the render path.
4. Attempt to cancel the export through the media job cancellation path.
5. Inspect the destination after cancellation or process failure.

### Result before Phase 8

The command and render path could create different job identities. Export ran outside the preparation cancellation token path, and output validation/partial publication was incomplete.

### Result after Phase 8

One durable scheduler-owned job controls the export from request through completion. Cancellation cleans partial output, retry starts from a known state, and only FFprobe-validated output is published.

### Evidence

- `apps/desktop/src-tauri/src/commands/exports.rs`
- `apps/desktop/src-tauri/src/exports/mod.rs`
- `apps/desktop/src-tauri/src/commands/media.rs`
- `docs/specs/media-jobs-render-plan.md`

## Phase 0 Evidence Rules

- A code-path reproduction is acceptable where the behavior is deterministic and the current implementation lacks an isolated test seam.
- Any future fix must add a regression test that fails against the baseline behavior and passes after the fix.
- Reproductions must use synthetic fixtures or controlled temporary directories.
- Do not use user media, absolute machine-specific paths, or secrets in tests or logs.
