# Editor Action Contract

> **Status:** Phase 0 — frozen for implementation  
> **Scope:** Semantics for every user-level editing action. This document is the source of truth for command behavior, undo boundaries, and lock/ripple rules.  
> **Related:** `editor-ui-cursor-imrovement-plan.md`, `packages/editor-core/src/commands.ts`, `packages/editor-core/src/history.ts`

## 1. Transaction model

Every user gesture follows `draft → validate → commit/cancel`.

- **Draft** surfaces are not persisted and do not create undo entries.
- **Validate** runs on every update and on `commit`. A validation failure cancels the gesture and shows an actionable message.
- **Commit** is atomic: it produces exactly one history transaction and exactly one autosave request.
- **Cancel** (Escape, pointer cancel, focus loss, invalid drop) reverts to the pre-gesture state and leaves the project unchanged.

A single completed user gesture produces exactly one undo entry and one autosave request. High-frequency events (pointer move, trim drag, crop resize) are coalesced inside the gesture and collapsed into one commit.

## 2. Action contract matrix

| Action          | Required behavior                                              | Reliability acceptance                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trim            | Drag either edge, numeric edit, frame nudge, snapping          | Draft during drag; one commit; min 1 frame; source bounds enforced; Escape cancels; one undo restores exact range                                                                          |
| Split           | Split selected compatible items at playhead                    | Boundary split is a non-destructive no-op with feedback; source mapping remains exact; cursor/zoom ranges follow documented split policy                                                   |
| Delete          | Remove selection without shifting time                         | Immediate because it is undoable; show Undo toast; durable snapshot policy succeeds before destructive commit                                                                              |
| Ripple delete   | Remove range and close time atomically                         | All participating unlocked tracks, markers, zoom, cursor overrides, captions, masks, and audio follow one rule; affected locks block with an actionable message rather than partial ripple |
| Move            | Reposition single or multi-selection                           | Drag ghost, snap guide, no negative time, no illegal overlap, one commit, invalid destination never mutates project                                                                        |
| Multi-select    | Modifier toggle and marquee/range behavior                     | Stable primary selection; mixed-type inspector explains compatibility; batch command validates all items before mutating any                                                               |
| Range selection | Drag empty timeline area, keyboard-adjust boundaries           | Visible handles, snapping, clear duration, deterministic delete/export range behavior                                                                                                      |
| Duplicate       | Duplicate appropriate clips/ranges                             | New stable IDs, offset with collision handling, asset identity preserved, one undo entry                                                                                                   |
| Undo/redo       | Reverse/reapply every committed project edit                   | Labels are accurate; failed autosave does not lose history; transient hover/playhead state is not persisted or incorrectly restored                                                        |
| Seek/scrub      | Drag playhead and click ruler/timeline                         | Frame-aware preview, throttled media seeks, final exact seek on release, no audible scrub unless deliberately enabled                                                                      |
| Playback        | Play cuts, gaps, speed changes, camera, audio, and overlays    | Drift remains within 1 output frame on fixtures; no overlay crosses a cut incorrectly; end/gap transitions do not stall                                                                    |
| Snapping        | Snap to playhead, clip edges, markers, captions, cursor clicks | Visible target and label; deterministic priority; temporarily disable with modifier; threshold expressed in screen-space or converted consistently across zoom                             |
| Track controls  | Mute, solo, lock, collapse, height                             | `aria-pressed`/`aria-expanded`; solo semantics identical in preview/export; locks participate in command preflight                                                                         |
| Marker          | Add, edit, move, delete                                        | Keyboard and pointer paths; ripple policy tested; labels remain accessible at dense zoom levels                                                                                            |
| Zoom            | Add, move, resize, target, split, lock, regenerate             | Direct target manipulation; no overlaps; regeneration preserves manual/locked ranges; cursor and zoom share geometry                                                                       |
| Camera          | Select, drag, resize, crop, style, show/hide                   | One transaction per gesture; bounds enforced; keyboard move/resize; preview/export geometry parity                                                                                         |
| Caption         | Import, select, text/timing/style edit                         | Parse errors identify the failing cue; timing collision is actionable; safe-area preview/export parity                                                                                     |
| Mask            | Add, move, resize, time, mode                                  | Minimum usable size; all handles keyboard accessible; no pointer-capture leak; exact preview/export placement                                                                              |
| Audio           | Gain, mute, fade, solo                                         | No clipping of invalid values; fades bounded by clip; preview/export mix parity                                                                                                            |
| Export          | Freeze revision, validate, render, cancel, retry, reveal       | Cannot start from stale/unsaved ambiguous state; progress and terminal toast; cancellation cleans partial output; validated output only                                                    |

## 3. Ripple and lock policy

### 3.1 Definition

- A **ripple operation** removes a time range from the timeline and shifts all later content on participating tracks to the left by the removed duration.
- A **locked track** cannot be edited except to unlock it. Moving, trimming, deleting, or rippling content on a locked track is blocked.
- A **locked clip/range** cannot be moved, resized, or deleted. It can still be split if the track is not locked, and the resulting pieces keep the original locked state.

### 3.2 Participating layers

A ripple delete affects the following layers when they are not locked:

- Screen clips
- Camera clips
- Audio clips (microphone, system audio, music)
- Cursor effect ranges
- Zoom segments
- Caption clips
- Mask clips
- Markers (shifted in time)

Locked layers are never shifted. Layers that are locked at the track level are skipped entirely. Layers with a locked individual clip/range keep that item in place; later unlocked items on the same track are shifted around it, producing a gap on the track if necessary.

### 3.3 Atomicity rules

1. The command preflight collects every participating track and item.
2. If any participating layer is locked and would be moved or deleted, the command is rejected with a clear message naming the locked item(s).
3. If validation passes, all shifts and deletions are applied in one engine state update.
4. A ripple never leaves a project in a partially shifted state.

### 3.4 Range ripple delete

When a user ripple-deletes a timeline range:

1. Determine the range `[startMs, endMs]`.
2. For every unlocked clip that starts at or after `endMs`, shift it left by `endMs - startMs`.
3. For every unlocked clip that starts before `endMs` and ends after `startMs`, trim or split it:
   - If the clip starts inside the range, delete the portion from `startMs` to `endMs` and shift the remainder left.
   - If the clip starts before the range and ends inside, truncate at `startMs`.
   - If the clip spans the range, split at `startMs` and `endMs`, delete the middle, and shift the tail left.
4. Markers at or after `endMs` shift left.
5. Markers inside the range are deleted.
6. Zoom, cursor, caption, and mask ranges are handled as clip-like items with the same split/trim/shift rules.
7. If any shift would cause an overlap, the command is rejected.

### 3.5 Lock blocking messages

Blocked ripple messages must identify the user-visible name of the locked layer:

- `"Screen track is locked. Unlock it to ripple-delete this range."`
- `"Zoom segment 'Zoom In' is locked. Unlock it or exclude it from the range."`
- `"Marker 'Chapter 2' is locked. Unlock it before ripple-deleting."`

## 4. Cut behavior

### 4.1 Split

A **split** at time `t` divides a clip into two adjacent clips with the same `assetId` and continuous source ranges.

- The left clip keeps the original start and source in. Its duration ends at `t`.
- The right clip starts at `t`. Its source in is the original source in plus the elapsed source time at `t`.
- Splitting at a boundary (start or end of a clip) is a non-destructive no-op with brief feedback.
- Splitting a locked track is blocked. Splitting an unlocked clip inside a locked track is blocked.

### 4.2 Cut in the context of effects

Effects (cursor, zoom, captions, masks) are ranges, not source media. A split at `t` for an effect range produces two adjacent ranges with the same settings.

- The left range keeps the original start. Its duration ends at `t`.
- The right range starts at `t`. Its duration is the original end minus `t`.
- The right range inherits the original range's settings and locked state.
- A split that would produce a range shorter than the minimum supported duration (e.g., 100 ms for zoom, 1 frame for masks) is rejected.

### 4.3 Cut and speed changes

When a clip has `speed != 1`:

- Splitting at timeline time `t` computes the source time as `sourceInMs + (t - startMs) * speed`.
- Both resulting clips preserve the same `speed`.
- The source range boundary must remain inside `[0, sourceDurationMs]`.

### 4.4 Cut and gaps

A split cannot create a gap. The two resulting clips must be adjacent (`left.startMs + left.durationMs == right.startMs`). Any command that would leave a gap between split parts is rejected.

## 5. Validation order

Every command runs validation in this order:

1. **Project state guard:** project is loaded, not being saved, and has no missing assets for the affected action.
2. **Track lock guard:** the target track is not locked, or the command is an allowed lock change.
3. **Range guard:** all start/duration values are non-negative and within source bounds.
4. **Overlap guard:** resulting clips/ranges do not overlap on non-overlapping tracks.
5. **Duration guard:** resulting durations are at least the minimum supported length.
6. **Asset guard:** asset IDs exist in the project registry and point to available files.
7. **Permission guard:** destructive commands (`delete`, `ripple-delete`, `delete-track`) require a durable snapshot before commit.

If any guard fails, the command is rejected before the engine state is mutated.

## 6. Undo/redo semantics

- **One gesture = one undo.** A pointer drag that drafts for 200 ms and commits once creates one undo entry.
- **Coalescing** is used only for high-frequency updates within the same gesture and the same `coalesceKey`.
- **History** stores the complete state before each transaction (`past`) and after (`future`).
- **Failed save** does not lose history. History is in memory until the project is closed.
- **Transient state** (playhead, scroll, zoom, hover, selection) is never persisted in history and is not restored by undo/redo.

## 7. Exit criteria

This action contract is frozen when:

- Every matrix action has a matching command record or command group.
- Ripple and lock rules are covered by unit tests in `packages/editor-core`.
- Cut behavior for screen, camera, audio, cursor, zoom, captions, masks, and markers is documented and testable.
- The command preflight order is implemented in `packages/editor-core/src/engine.ts` or equivalent.
