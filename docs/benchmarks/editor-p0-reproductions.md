# Editor P0 Reproductions

> **Status:** Phase 0 baseline
> **Scope:** Reproducible editor and export correctness failures identified during the editor implementation audit
> **Related:** `docs/specs/editor-capability-matrix.md`, `editor-ui-cursor-imrovement-plan.md`

These are baseline reproductions. They describe current behavior before the Phase 1-8 fixes. They are not claims that the current implementation should remain unchanged.

## Summary

| ID   | Failure                                              | Current status              | Reproduction                                                                 | Planned fix                             |
| ---- | ---------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| P0-1 | Project edits disappear after reopen                 | Confirmed by code path      | Open a recording, edit it, leave editor, reopen the same recording           | Phase 1 project persistence             |
| P0-2 | Preview and export use different cursor time mapping | Confirmed by code path      | Split/trim a recording, inspect cursor at edited time, export, compare frame | Phases 2, 5, and 8 shared mapping       |
| P0-3 | Render plan drops supported editor state             | Confirmed by plan shape     | Build a project with camera/canvas/captions/masks/zoom and inspect plan      | Phase 8 complete render plan            |
| P0-4 | Export is not project/asset authoritative            | Confirmed by contract       | Parse an export request using only a recording ID and arbitrary destination  | Phases 1 and 8 asset-ID path resolution |
| P0-5 | Export job cannot be reliably cancelled or resumed   | Confirmed by implementation | Start export, request cancellation, inspect job IDs and partial output       | Phase 8 durable export job              |
| P0-6 | Save race / stale save result                        | Confirmed by code path      | Edit while autosave is in flight, then save manually                         | Phase 1 revision-aware save coordinator |
| P0-7 | Editor/export remount has no explicit session owner  | Mitigated but not guaranteed | Switch between Editor and Export, inspect session lifecycle                 | Phase 1 `EditorSession` ownership       |
| P0-8 | Pointer gestures commit on every pointer move        | Confirmed by code path      | Drag a clip, observe history, press Escape                                   | Phase 2 draft/validate/commit/cancel    |
| P0-9 | Cursor cadence does not align preview and export     | Confirmed by code path      | Compare cursor position at 30 fps preview vs. 60 fps export frame            | Phases 5 and 6 shared evaluator         |
| P0-10 | Click effect timing differs between React and Rust   | Confirmed by implementation | Observe click feedback in preview vs. exported frame                         | Phase 6 shared click-effect model       |
| P0-11 | Cursor/zoom parity diverges between preview and export | Confirmed by implementation | Set zoom target, compare cursor position inside zoomed frame                 | Phases 6 and 8 shared transform         |

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

## P0-6: Save Race / Stale Save Result

### Steps

1. Open a recording in the editor.
2. Make an edit that triggers autosave (`timeline-store.ts:440-453`).
3. While autosave is in flight, make another edit.
4. Manually save before the autosave completes.
5. Observe the resulting `project.json` and save status.

### Current result

`timeline-store.ts:455-475` performs a simple `saveProject(project)` call without revision tracking or checksum validation. The `project` schema includes a `checksum` field, but it is not used for validation. A stale save can overwrite a newer in-memory state and clear dirty state.

### Expected result after Phase 1

Each save includes a revision number or checksum. Concurrent saves are detected and rejected with a conflict error, and the user is prompted to reload or merge. Autosave is serialized with manual save and navigation flush.

### Evidence

- `apps/desktop/src/stores/timeline-store.ts:440-475`
- `packages/contracts/src/project.ts:81`
- `apps/desktop/src/lib/project.ts`

### Suggested regression test

A test that interleaves two saves and asserts that the second save either succeeds with the latest state or fails with a conflict, never rolling back to an older state.

## P0-7: Editor/Export Remount Has No Explicit Session Owner

### Steps

1. Open a recording in the editor.
2. Make edits (split, trim, move clips).
3. Click Export to switch to the export view.
4. Return to the editor view.
5. Close the editor and reopen the same recording.

### Current result

`app-shell.tsx:86-90` keeps the timeline-store listener alive and the engine/project state persists in the Zustand store. EditorView and ExportView are conditionally rendered but state is preserved in the current implementation. However, there is no explicit `EditorSession` owner above the panels, so reloading `EditorView` (`timeline-store.ts:190-205`) can still recreate the engine from the recording if the store is reset or the view remounts in a different context.

### Expected result after Phase 1

A persistent `EditorSession` owns the in-memory project. Opening Export or another panel must not reload the project, and close/reopen must reproduce the last durable project exactly.

### Evidence

- `apps/desktop/src/app/app-shell.tsx:86-90`
- `apps/desktop/src/stores/timeline-store.ts:161-188`
- `apps/desktop/src/features/editor/editor-shell.tsx`

### Suggested regression test

A component/integration test that opens the editor, edits, switches to export, switches back, and asserts the same engine state and history stack.

## P0-8: Pointer Gestures Commit On Every Pointer Move

### Steps

1. Open a recording in the editor.
2. Click and drag a clip or trim handle.
3. Observe the command history after every pixel of movement.
4. Press Escape during the drag.
5. Undo once.

### Current result

`timeline-lanes.tsx:782-838` commits commands on every pointer move. `beginGesture` creates a unique coalesce key, and `handlePointerMove` immediately calls `onMoveClip`/`onTrimClip`. Coalescing only collapses commands within the 250 ms window, but it is not a true draft/validate/commit/cancel transaction. Pressing Escape does not cleanly cancel the gesture, and intermediate states can be lost.

### Expected result after Phase 2

Pointer gestures maintain a draft state during the drag. A command is committed only on pointer up. Escape or pointer cancel reverts to the pre-gesture state without adding history entries. One completed gesture produces exactly one undo entry and one autosave request.

### Evidence

- `apps/desktop/src/features/editor/timeline/timeline-lanes.tsx:782-838`
- `apps/desktop/src/features/editor/timeline/timeline-view.tsx:864-873`
- `packages/editor-core/src/history.ts:42-53`

### Suggested regression test

A test that simulates pointer down, move, move, up and asserts one history entry; then pointer down, move, Escape and asserts no history entry and no state mutation.

## P0-9: Cursor Cadence Does Not Align Preview And Export

### Steps

1. Open the editor fixture with cursor telemetry.
2. Split a screen clip so the second clip has a different source time than timeline time.
3. Play the timeline at 30 fps and note the cursor position at a specific frame.
4. Export the project at 30/60 fps and inspect the same frame.

### Current result

The React overlay uses `findCursorEventAtTime` (`packages/cursor-core/src/index.ts:54-78`) with binary search and `smoothCursorPosition` with a fixed 5-event EMA window. The Rust export uses the same lookup but different frame timing and no interpolation between telemetry samples. Preview and export can sample different points because the telemetry sample rate is not aligned to the output frame rate.

### Expected result after Phase 6

A shared canonical evaluator computes cursor position at any project time deterministically. Frame-rate differences are handled by interpolation, and arbitrary seeking produces the same frame as uninterrupted playback.

### Evidence

- `packages/cursor-core/src/index.ts:54-78,103-130`
- `apps/desktop/src/features/editor/cursor/custom-cursor-overlay.tsx:118-122`
- `apps/desktop/src-tauri/src/exports/cursor.rs:184-199`

### Suggested regression test

A cross-language fixture test that evaluates the same fixture at 30, 60, and export frame rates and asserts positions are within the agreed tolerance.

## P0-10: Click Effect Timing Differs Between React And Rust

### Steps

1. Open the editor fixture with left and right click events.
2. Play the timeline and observe the click feedback animation in the preview.
3. Export the project and inspect the same click in the output video.

### Current result

React click detection in `custom-cursor-overlay.tsx:146-162` uses CSS `animate-ping` (Tailwind) for ~350 ms, which is driven by the browser CSS engine, not project time. Rust click detection in `exports/cursor.rs:637-681` and rendering in `render_click_feedback` compute the effect radius from elapsed time. The timing curves can diverge, and CSS animations do not survive seek/playhead jumps deterministically.

### Expected result after Phase 6

Click effect timing is a pure function of project time and is identical in preview and export. The click detection window, easing, and decay are shared by the same canonical evaluator.

### Evidence

- `apps/desktop/src/features/editor/cursor/custom-cursor-overlay.tsx:146-162,217-235`
- `apps/desktop/src-tauri/src/exports/cursor.rs:637-681,1085-1120`
- `packages/cursor-core/src/index.ts:80-92`

### Suggested regression test

A parity test that computes click effect progress for a set of telemetry events at fixed project times in both TypeScript and Rust and asserts identical results.

## P0-11: Cursor/Zoom Parity Diverges Between Preview And Export

### Steps

1. Open the editor fixture with a manual zoom segment over a clip with cursor telemetry.
2. Set the zoom target so the cursor is inside the zoomed area.
3. Play the timeline and observe the cursor position relative to the zoomed frame.
4. Export the project and compare the same frame.

### Current result

React zoom transform in `timeline-view.tsx:317-325` uses `resolveZoomTransform` from `packages/editor-core/src/composition.ts:102-140`. Rust zoom transform in `exports/cursor.rs:184-230` uses `apply_zoom` with `clamped_zoom_target` (`exports/mod.rs:1786-1826`). Coordinate fitting in React uses `fitCursorPoint` (`packages/cursor-core/src/index.ts:153-191`), while Rust fitting is inline in `CursorRenderer::new_with_zoom` and applies DPI/capture bounds differently. The cursor can appear at a different position within the zoomed frame.

### Expected result after Phases 6 and 8

React and Rust use the same coordinate fitting algorithm, the same zoom transform, and the same canvas geometry. Cursor position inside a zoomed frame is identical within the agreed pixel tolerance.

### Evidence

- `apps/desktop/src/features/editor/timeline/timeline-view.tsx:317-325`
- `apps/desktop/src-tauri/src/exports/cursor.rs:162-181,184-230`
- `apps/desktop/src-tauri/src/exports/mod.rs:1786-1826`
- `packages/editor-core/src/composition.ts:102-140`
- `packages/cursor-core/src/index.ts:153-191`

### Suggested regression test

A golden-frame test that renders a frame with a zoomed cursor in both React (or a TS test harness) and Rust and compares crop rectangle and cursor coordinates within 0.5 px.

## Phase 0 Evidence Rules

- A code-path reproduction is acceptable where the behavior is deterministic and the current implementation lacks an isolated test seam.
- Any future fix must add a regression test that fails against the baseline behavior and passes after the fix.
- Reproductions must use synthetic fixtures or controlled temporary directories.
- Do not use user media, absolute machine-specific paths, or secrets in tests or logs.
