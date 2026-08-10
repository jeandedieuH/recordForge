# recordForge Editor UI, Editing Reliability, and Cursor Improvement Plan

> **Status:** Proposed — planning only; no implementation is included in this document  
> **Date:** 2026-08-10  
> **Product area:** Desktop editor  
> **Primary specification:** `recordforge-editor-specification.md`  
> **Requested filename:** `editor-ui-cursor-imrovement-plan.md`  
> **Target:** A modern, focused, reliable screen-story editor with a first-class cursor workflow comparable in capability and polish to Cap and Screen Studio while retaining Loom-like simplicity for common tasks

---

## 1. Purpose

This document defines the next improvement program for the recordForge editor. It covers three connected goals:

1. Redesign the editor UI and interaction hierarchy so it feels modern, sleek, calm, and purpose-built for screen-video editing.
2. Make every editing action deterministic, responsive, recoverable, and consistent across preview, persistence, undo/redo, and export.
3. Replace the current cursor implementation with a deliberately designed cursor system that captures trustworthy metadata, produces natural movement, supports useful post-recording controls, and guarantees preview/export parity.

This plan does **not** implement those changes. It records the target product behavior, architecture, work sequence, tests, and release gates for later implementation.

The existing editor should not be discarded wholesale. Its project-first persistence, pure command engine, virtualized timeline foundation, semantic tracks, render plan, and background job architecture are valuable. The correct approach is to retain proven foundations while replacing shallow UI composition, unsafe session orchestration, high-frequency edit handling, and the current cursor pipeline.

---

## 2. Source of Truth and Audit Basis

### 2.1 Precedence

If implementation details conflict during this program, use this order:

1. Security, local-first, and native/media ownership rules in `AGENTS.md`.
2. Durable project and render contracts in `docs/specs/project-format.md` and `docs/specs/media-jobs-render-plan.md`.
3. Product behavior in `recordforge-editor-specification.md`.
4. The decisions and acceptance criteria in this plan.
5. Existing code, which is evidence of current behavior but not authority over the target design.

### 2.2 Repository areas reviewed

The audit covered:

- Editor shell and navigation: `apps/desktop/src/app/app-shell.tsx`, `apps/desktop/src/features/editor/editor-shell.tsx`, and `editor-sidebar.tsx`.
- Preview, transport, timeline, gestures, selection, and inspector: `apps/desktop/src/features/editor/timeline/**`.
- Project/session state: `apps/desktop/src/stores/editor-store.ts` and `timeline-store.ts`.
- Timeline commands, history, snapping, selection, composition, and time mapping: `packages/editor-core/src/**`.
- Cursor contracts and algorithms: `packages/contracts/src/cursor.ts` and `packages/cursor-core/src/**`.
- Cursor capture and export: `apps/desktop/src-tauri/src/capture/cursor.rs`, `apps/desktop/src-tauri/src/exports/cursor.rs`, and `exports/mod.rs`.
- Render planning: `packages/media-core/src/render-plan.ts`.
- Existing specs, phase decisions, capability matrix, and editor baseline documents.

### 2.3 Baseline caveat

The older capability matrix and development plan describe an earlier implementation state. The current working tree already contains durable projects, autosave, multi/range selection, snapping, virtualized tracks, direct clip trim/move, cursor ranges, manual and generated zooms, captions, masks, camera composition, and a durable export lifecycle. Implementation work must re-audit the current branch rather than treating older “missing” labels as current truth.

### 2.4 Validation performed during planning

The existing pure package tests pass:

```text
bunx turbo run test \
  --filter=@recordforge/contracts \
  --filter=@recordforge/cursor-core \
  --filter=@recordforge/editor-core \
  --filter=@recordforge/media-core

Result: 4 packages passed, 19 test files passed, 127 tests passed.
```

This is meaningful coverage of pure contracts and commands, but it does not verify the desktop editor interaction layer. There are currently no React component, browser integration, visual regression, accessibility automation, or end-to-end editor tests under `apps/desktop`.

---

## 3. Executive Decisions

### 3.1 Product decisions

- The editor becomes a focused project workspace. Global application navigation must not compete with editing tools while a project is open.
- The interface remains compact and dark-first, but uses calmer neutral surfaces, fewer decorative borders, stronger hierarchy, and progressive disclosure.
- Cursor becomes a top-level task beside Focus/Zoom, Captions, Layout, Audio, and Privacy rather than a large settings block embedded in the default inspector.
- Common actions must remain obvious without requiring professional NLE knowledge. Advanced controls remain available but collapsed by default.
- Healthy background state stays quiet. Recovery, diagnostics, missing assets, save failures, and job failures become prominent only when action is required.

### 3.2 Reliability decisions

- A mounted editor session owns one in-memory project until the user explicitly closes it. Opening Export or another editor panel must not reload the project.
- Every pointer gesture uses draft → validate → commit/cancel semantics. Pointer movement must not execute and persist a complete project command on every event.
- One completed user gesture produces exactly one undo entry and one autosave request.
- Project saves are revision-aware and serialized. A stale save result must never overwrite newer in-memory edits or clear their dirty state.
- Ripple operations are atomic across participating tracks. Locks must never cause a silent partial ripple.
- Preview, overlays, cursor, audio, and export derive from one authoritative timeline/source/output time model.

### 3.3 Cursor decisions

- The current cursor implementation should be treated as a prototype, not as the long-term renderer.
- Cursor telemetry remains immutable source metadata. Cursor appearance and behavior remain editable project metadata.
- The new cursor system must capture real coordinate-space metadata, cursor shape/hotspot changes, button edges, visibility, and quality diagnostics.
- Cursor position and effects at time `t` must be a pure, seek-safe evaluation. Browser-clock CSS animations must not determine rendered cursor state.
- Preview and export must use the same canonical cursor evaluator and the same cursor asset manifest.
- The preview must not invoke Rust once per frame. The preferred architecture is a native Rust evaluator compiled to WebAssembly for preview and linked natively for export. A compiled motion-plan fallback is allowed only if it meets the same parity and low-end performance gates.
- Motion blur, kinetic rotation, and other Tier 3 effects are deferred until core mapping, seeking, and parity are proven.

---

## 4. Current-State Assessment

### 4.1 Foundations to retain

| Foundation                               | Evidence                                               | Disposition                                                                |
| ---------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Project-first loading and asset registry | `timeline-store.ts:190-305`, Rust `projects` module    | Retain; harden session lifecycle and save concurrency                      |
| Pure command engine                      | `packages/editor-core/src/engine.ts` and `commands.ts` | Retain; add stronger invariants and transaction-facing interface           |
| Bounded/coalesced history                | `packages/editor-core/src/history.ts`                  | Retain concept; commit only final gestures                                 |
| Shared time-mapping helpers              | `packages/editor-core/src/time-mapping.ts`             | Make authoritative for every preview and render path                       |
| Deterministic snap helper                | `packages/editor-core/src/snap.ts`                     | Retain; add visual feedback and cache target indexes                       |
| Track and visible-time virtualization    | `timeline-lanes.tsx:184-245` and `616-707`             | Retain; optimize indexes and avoid rebuilding target sets per row          |
| Project-derived render plan              | `packages/media-core/src/render-plan.ts`               | Retain; require effect capability and parity gates                         |
| Background prepare/export jobs           | `timeline-store.ts`, Rust jobs/exports                 | Retain; unify completion feedback and job visibility                       |
| Cursor asset/range concept               | cursor contracts, project migration, render plan       | Retain concept; replace telemetry, evaluator, and rendering implementation |

### 4.2 P0 correctness and data-integrity risks

#### A. Editor session can be reloaded during normal navigation

`TimelineView` loads the project on mount (`timeline-view.tsx:214-216`). Export is rendered as a separate app view, and returning to the editor remounts `TimelineView` (`app-shell.tsx:183-209`). A fast editor → export → editor transition can therefore reload project data while an autosave is pending. Global sidebar navigation also bypasses the dedicated close-and-flush path.

**Required correction:** Move project loading and ownership into a persistent `EditorSession` above workspace panels. Export should consume the existing session or open as an editor route/panel without recreating it.

#### B. Save completion can overwrite newer edits

`save()` captures one project snapshot, awaits native persistence, then writes the returned project back into the store and marks it clean (`timeline-store.ts:453-472`). If a user edits while that save is in flight, the older save result can replace newer in-memory state or clear the dirty indicator.

**Required correction:** Track `currentRevision`, `savingRevision`, and `durableRevision`; serialize writes; never replace newer in-memory state with an older save response; and make `flush()` wait until the latest revision is durable.

#### C. Required destructive snapshots are fire-and-forget

Destructive commands start `snapshotProject()` but ignore failures and do not wait for the snapshot (`timeline-store.ts:362-367`). That does not satisfy a strict “snapshot before destructive operation” guarantee.

**Required correction:** Put snapshot, command commit, autosave, and error reporting behind one operation coordinator. If a required snapshot fails, either block the destructive command or present a deliberate user choice; never fail silently.

#### D. Pointer gestures commit on every move

Clip move/trim and direct preview manipulation dispatch commands repeatedly during pointer movement. Each command rebuilds project state, schedules autosave, updates history, and rerenders broad editor surfaces. Pointer cancellation leaves the last intermediate state committed.

**Required correction:** Keep draft geometry in transient interaction state, render it at animation-frame cadence, validate continuously, and commit once on pointer-up. Escape or pointer-cancel must restore the pre-gesture state.

#### E. Navigation and close behavior are not centrally guarded

The explicit close path saves dirty work, but generic application navigation directly changes views. Window close, global navigation, export navigation, and project switching must all use the same `flush-or-stay` policy.

**Required correction:** Add one editor navigation guard owned by the session. Autosave remains the default; save failure prevents silent exit and offers Retry, Save Copy/Recover, or Stay.

### 4.3 Current UI/UX issues

#### Workspace hierarchy

- The application title bar and global sidebar remain visible while the editor adds its own top bar and task sidebar. The result is nested navigation and reduced preview width.
- Healthy “Recovery clear” and “Diagnostics ready” badges consume prime top-bar space (`editor-shell.tsx:173-182`) even when no action is needed.
- The left tools panel and right inspector are hidden below the `lg` breakpoint with no drawer replacement (`editor-sidebar.tsx:55-57`, `clip-inspector.tsx:217-219` and `380-381`). A narrower desktop window loses editing controls rather than adapting.
- The no-selection inspector renders Canvas, Zoom, and the full Cursor inspector in one long surface. Selection context is weak and high-frequency tasks are buried in scrolling.
- Selected media clips always expose a Clip/Cursor tab pair, even when cursor behavior is not the user’s current task.
- The current cursor inspector exposes presets, fill, stroke, shadows, click effects, smoothing, spotlight, and idle behavior at once. It lacks a clear Basic/Advanced model.

#### Direct manipulation and timeline feedback

- Camera position is draggable, but resize handles and explicit selection coupling are incomplete.
- Masks support pointer move and one resize corner, but the resize affordance has no keyboard operation.
- Zoom targets, screen crop, and caption placement do not yet share a consistent preview-selection and transform system.
- Dragging provides no snap guide, target label, collision preview, or invalid drop visualization.
- Timeline height is fixed, rather than resizable and remembered per workspace.
- The split tool is visually selectable, but clip behavior remains primarily shortcut/selection driven; tool mode needs explicit pointer semantics or removal.
- Context menus required by the editor specification are absent.

#### Accessibility and motion

- Several preview objects use `div role="button"` instead of a complete semantic control model.
- Camera preview has no visible focus treatment; the mask resize handle has no keyboard handler.
- Some cursor color inputs and switches do not have programmatic labels.
- `transition-all` appears in cursor preset controls and cursor movement/effects do not consistently honor reduced-motion preferences.
- Narrow-window panel hiding removes functionality rather than presenting an accessible drawer or command alternative.

### 4.4 Current cursor failures that explain poor feel

#### Capture and metadata

- Capture samples `GetCursorPos` and button state at a nominal 60 Hz (`capture/cursor.rs:173-208`, `269-298`).
- DPI scale is stored but currently hardcoded to `1.0` (`capture/cursor.rs:95`, `capture/session.rs:75`).
- `visible` represents whether `GetCursorPos` succeeded, not whether Windows reports the cursor as shown.
- The format records no cursor shape, shape transitions, bitmap identity, or hotspot.
- One string represents button state, so simultaneous/multi-button transitions are not modeled robustly.
- The tracker owns its own `Instant`; synchronization to the actual first encoded video frame and segment boundaries is not an explicit contract.
- Native cursor capture is disabled in FFmpeg. If cursor metadata is missing or corrupt, the recording can have no recoverable cursor.

#### Evaluation and rendering

- Position lookup selects the nearest sample (`cursor-core/src/index.ts:53-78`) instead of interpolating between samples.
- Smoothing is a fixed five-sample trailing weighted average (`cursor-core/src/index.ts:103-130`). It is not velocity-adaptive and is not a natural, deterministic motion model.
- The preview’s playhead primarily advances from the video element’s `timeupdate` callback (`timeline-view.tsx:1097-1099`), which is not a frame clock. Cursor movement can therefore update at a visibly low cadence.
- The preview click effect is a CSS `animate-ping` driven by browser time (`custom-cursor-overlay.tsx:216-235`), while export derives effect progress from output time. Seeking and pausing cannot be deterministic.
- The preview scans only eight samples for a 350 ms click window (`custom-cursor-overlay.tsx:146-162`). At 60 Hz, that covers roughly 133 ms of continuously sampled data.
- The current “pulse” branch has neither a visible border nor fill in the preview styling, so it can become effectively invisible.
- Preview applies an extra CSS transform transition while export does not (`custom-cursor-overlay.tsx:237-261`).
- Preview cursor assets are React SVGs while export redraws separate Rust primitives. Geometry, hotspot, color, shadow opacity, and antialiasing can diverge.
- Rust applies zoom to cursor coordinates, while the preview cursor is a separate sibling overlay whose relationship to the transformed video is indirect. Cursor/zoom parity is therefore not guaranteed.

#### Loading and performance

The same telemetry is loaded independently by:

1. `timeline-store.load()` for store state.
2. `TimelineView` for click snap times.
3. `CustomCursorOverlay` for rendering.

A 60-minute 60 Hz recording contains approximately 216,000 samples. Parsing and retaining multiple copies increases load time and memory pressure. Idle detection can also scan backward through a long stationary run on every evaluated frame.

#### Persistence model

`CursorEffectClip` is modeled like source media with placeholder `sourceInMs`, `sourceOutMs`, and `speed` even though it is an effect interval. Global canvas cursor settings and range overrides also create two overlapping sources of behavior.

**Required correction:** Use a project default cursor profile plus explicit sparse interval overrides. Cursor effect ranges must not pretend to be source-media clips.

---

## 5. Reference-Product Lessons

Reference products are behavioral benchmarks, not designs to copy.

### Loom

Loom’s official documentation exposes a simple recording-time mouse-click highlight. It does not document a Cap/Screen Studio-style post-recording cursor editor. Loom is therefore a reference for low-friction defaults and simple language, not the feature-depth target for the cursor rewrite.

### Cap

Cap is the strongest open, inspectable reference for the technical direction:

- Studio projects remain local and editable.
- Recorded cursor/click metadata enables generated zooms; imported MP4s do not gain that data.
- Cursor interpolation uses spring-based behavior, shake filtering, and explicit rendering work shared across editor/preview/export paths.
- Cursor assets include shape-specific SVG artwork and hotspot metadata.
- Idle hiding uses a configurable delay and deterministic fade.

### Screen Studio

Screen Studio is the strongest UX reference:

- Cursor controls use simple choices such as size, type, hide cursor, hide when idle, and preserve a consistent system cursor.
- Advanced options are disclosed separately.
- Smoothing can be disabled for a selected fragment.
- Cursor visibility can be changed for a specific timeline fragment through a contextual action.
- Animation presets use understandable labels rather than exposing physics values first.
- Quality, Performance, and Power Saving preview modes make fidelity trade-offs explicit; Quality is intended to match export.

### recordForge synthesis

recordForge should combine:

- Loom’s simple default path.
- Cap’s metadata-first, local, deterministic architecture.
- Screen Studio’s fragment-level controls, progressive disclosure, and explicit preview quality modes.

The default experience should not expose novelty presets such as “Cyberpunk” before useful system-quality choices. The primary styles should be **Recorded/System**, **Clean Pointer**, **High Contrast**, and **Touch Dot**. Decorative styles may remain optional later.

---

## 6. Target Editor Experience

### 6.1 Target workspace

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Back  Project name  Save state     Undo Redo     Preview quality     Export │
├──────┬───────────────┬──────────────────────────────────────┬────────────────┤
│ Task │ Active panel  │ Preview stage                        │ Inspector      │
│ rail │ Media         │ Canvas + selection overlays          │ Selection only │
│      │ Focus         │ Direct manipulation                  │ Basic          │
│      │ Cursor        │                                      │ Advanced       │
│      │ Captions      │                                      │                │
│      │ Layout        │                                      │                │
│      │ Audio         │                                      │                │
│      │ Privacy       │                                      │                │
├──────┴───────────────┴──────────────────────────────────────┴────────────────┤
│ Timeline toolbar: tools, snap, marker, zoom, view controls, job indicators  │
├──────────────────────────────────────────────────────────────────────────────┤
│ Marker / Zoom / Cursor / Screen / Camera / Audio / Captions / Masks lanes  │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Focus mode

- Hide the global application sidebar while editing.
- Keep one explicit Back to Library action and one editor top bar.
- Preserve the live editor session when opening Export, jobs, or project settings.
- Offer a distraction-free preview toggle without changing project state.

#### Task rail and panels

Use a narrow task rail plus one active panel:

| Task     | Primary content                                                      |
| -------- | -------------------------------------------------------------------- |
| Media    | Source assets, derivatives, imports, missing/relink states           |
| Focus    | Manual zoom, generated zoom suggestions, regenerate/lock workflow    |
| Cursor   | Project cursor profile, ranges, click effects, idle behavior         |
| Captions | Import, cue list/transcript later, style and placement               |
| Layout   | Aspect ratio, background, padding, screen and camera scenes          |
| Audio    | Mic/system controls, gain, fades, future voice presets               |
| Privacy  | Blur, pixelate, redact, mask list and duration                       |
| Export   | Optional summary/queue shortcut; full flow remains a focused surface |

The rail must stay keyboard navigable. At narrow desktop widths, the active panel and inspector become drawers; they must never simply disappear.

#### Top bar

Keep only high-value persistent information:

- Back to Library.
- Editable/truncated project name.
- Compact save state: Saving…, Saved, Save failed.
- Undo/redo with action labels in tooltips.
- Preview quality selector.
- Primary Export button.

Move healthy recovery/diagnostic state into a health popover. Show a top-level warning badge only when recovery data, missing assets, save failures, or diagnostics require action.

#### Preview stage

- Give the preview the strongest visual weight.
- Use one canvas coordinate system for video, camera, masks, captions, zoom target, and cursor.
- Selection in the preview and timeline must be synchronized.
- Use consistent transform handles for position, resize, crop, and target regions.
- Show safe areas only while relevant controls are selected.
- Provide fit, 50%, 100%, and fullscreen preview controls separate from timeline zoom.
- Make quality trade-offs explicit: Quality, Performance, and Power Saving.

#### Inspector

- Show only controls for the primary selection.
- Use Basic and Advanced sections.
- Keep labels and values aligned; use slider + numeric field pairs where precision matters.
- Group destructive actions at the bottom.
- Never mix Canvas, Zoom, and all Cursor controls in the no-selection state. The no-selection inspector should show a concise Project/Canvas summary and suggested next action.
- Multi-selection shows compatible shared controls and explains excluded mixed controls.

#### Timeline

- Make timeline height resizable and store it as view state.
- Add a visible playhead handle and clear range-selection treatment.
- Add snap lines, snap target labels, drag ghosts, and invalid collision states.
- Add context menus for clips, ranges, zooms, cursor ranges, markers, and tracks.
- Show generated/locked/manual badges on zoom segments.
- Show cursor override badges such as Hidden, Precise, Smooth, or Style on cursor ranges.
- Keep trim handles discoverable on hover and focus, but increase their effective hit area.
- Add “Zoom to fit project” and “Zoom to selection.”

### 6.2 Visual direction

The editor should use a **calm precision-tool** aesthetic rather than a marketing-dashboard aesthetic.

- Preserve the existing design-token and `@recordforge/ui` system.
- Keep Inter Variable because it is the approved vendored product font.
- Reduce blue-tinted surface stacking; use neutral dark surfaces with blue reserved for selection, focus, and primary actions.
- Use track colors only for track identity and timeline items.
- Replace repeated card borders with spacing, section headings, and subtle separators.
- Use a consistent radius/elevation scale. Avoid deep shadows in dense panels.
- Keep body/control text readable; reserve 10–11 px text for secondary timeline metadata, not primary controls.
- Use tabular numerals for all timecode, percentages, dimensions, and frame values.
- Do not use emoji. Continue using the approved Lucide icon set and `IconButton`.

### 6.3 Motion and interaction feedback

- UI transitions: short, interruptible, and limited to opacity/transform.
- Do not use `transition-all`.
- Respect `prefers-reduced-motion` for nonessential UI movement.
- Editing motion authored into the video remains previewable, but the editor must provide a reduced-motion preview preference where practical.
- Press/drag feedback should appear within 100 ms.
- Cursor and zoom motion in the content preview must use project time, not wall-clock CSS animation.

### 6.4 Four-state and background-job behavior

Every async editor surface renders:

```text
skeleton/loading → content | empty/unavailable | error + retry
```

Apply this to project load, source media, proxy, thumbnails, waveforms, cursor metadata, captions import, preview composition, and export.

Every background job ends with a toast or jobs-drawer entry:

- Prepare complete / failed.
- Autosave failed.
- Export complete / failed / cancelled.
- Cursor telemetry unavailable or degraded.
- Smart zoom generation complete / no eligible events / failed.

---

## 7. Editing Reliability Architecture

### 7.1 Deep modules and seams

#### EditorSession

One module owns project identity, in-memory timeline, command history, save revisions, asset state, and lifecycle.

```ts
interface EditorSession {
  dispatch(request: EditorCommandRequest): EditorCommandResult
  undo(): EditorCommandResult
  redo(): EditorCommandResult
  flush(): Promise<EditorFlushResult>
  close(): Promise<EditorCloseResult>
}
```

The interface must hide Tauri persistence, autosave timers, snapshot sequencing, and store synchronization. React consumes state and results; it must not coordinate competing saves itself.

#### InteractionTransaction

One module owns high-frequency pointer/keyboard gestures.

```ts
interface InteractionTransaction<TDraft> {
  update(request: { draft: TDraft }): InteractionPreview
  commit(): EditorCommandResult
  cancel(): void
}
```

Invariants:

- Begin captures one immutable base revision.
- Updates are transient and animation-frame throttled.
- Commit validates against the latest compatible base state.
- Commit creates one command/history entry.
- Cancel restores the exact pre-gesture project state.
- Losing pointer capture, pressing Escape, or unmounting cancels safely.

#### PersistenceCoordinator

```ts
interface PersistenceState {
  currentRevision: number
  savingRevision: number | null
  durableRevision: number
  status: "saved" | "dirty" | "saving" | "error"
}
```

Rules:

- Revisions increase only on committed project changes.
- Writes run serially.
- A completed old write updates only `durableRevision`; it never replaces a newer project.
- If edits arrive while saving, queue one latest snapshot rather than every intermediate state.
- `flush()` resolves only when `durableRevision === currentRevision`.
- Save errors keep the project dirty and preserve the in-memory recovery copy.
- Export uses a known durable revision or explicitly renders the current frozen revision after a successful flush.

#### PlaybackClock

One module maps video frames, timeline time, source time, and overlays.

- Use `requestVideoFrameCallback` when video is driving playback.
- Use an animation-frame clock only for gaps or non-video canvas sections.
- Correct drift against authoritative media timestamps.
- Seek all active media and overlays through one mapping request.
- Keep preview and export frame-boundary rules documented and tested.

### 7.2 Global invariants

Every editing command must preserve:

1. `startMs >= 0`.
2. Positive duration for visible timeline items.
3. Source ranges within the referenced asset duration.
4. `durationMs = (sourceOutMs - sourceInMs) / speed` within the documented rounding tolerance.
5. No overlap on constrained tracks; overlap only on explicitly compositing tracks such as masks.
6. Effect ranges remain inside project duration unless a command deliberately extends the project.
7. Locked items are not modified indirectly.
8. Command failure produces no project mutation, history entry, autosave, or selection corruption.
9. One user gesture produces one undo step.
10. Close/reopen reproduces the last durable project exactly.

### 7.3 Action contract matrix

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

### 7.4 Interaction performance

- Do not rebuild the complete snap target list once per visible track row.
- Build indexed snap targets once per relevant timeline revision.
- Keep timeline geometry in memoized indexes that support visible-window binary search.
- Keep playhead updates isolated from panels and inspectors that do not depend on playhead time.
- Use Zustand selectors and shallow comparison; avoid subscribing an entire component to broad store objects.
- Keep high-frequency draft state outside durable project state.
- Budget the complete preview frame under 16.7 ms at 60 fps on the baseline machine; cursor evaluation should consume no more than 1 ms p95 after preprocessing.

---

## 8. Cursor Rewrite

### 8.1 Target user experience

#### Default behavior

A new recordForge recording should open with:

- Custom cursor enabled when healthy telemetry is available.
- Recorded/System or Clean Pointer as the default style, subject to product testing.
- Natural smoothing.
- Subtle left-click emphasis.
- Right-click emphasis visually distinguishable but not distracting.
- Idle hiding off by default until fade behavior has passed usability testing.
- No spotlight or motion blur by default.

Imported videos without cursor metadata show a clear unavailable state. recordForge must not invent a centered or synthetic cursor path.

#### Basic cursor controls

- Show cursor.
- Style: Recorded/System, Clean Pointer, High Contrast, Touch Dot.
- Size.
- Movement: Precise, Natural, Smooth, Cinematic.
- Click emphasis: Off, Subtle, Strong.
- Hide when idle.

#### Advanced controls

- Preserve recorded cursor types vs always use one pointer.
- Shake removal.
- Idle delay and fade duration.
- Left/right click colors, radius, and duration.
- Cursor opacity, fill, outline, and shadow where supported by the selected style.
- Spotlight/highlight controls.
- Reduced-motion preview behavior.
- Motion blur later, only after parity.

#### Range workflow

- Project cursor profile defines the default.
- Sparse cursor override ranges change only selected fields.
- Context actions on a selected clip/range: Hide Cursor, Disable Smoothing, Apply Cursor Style, Reset Cursor Overrides.
- Cursor ranges appear in a dedicated lane and can be moved, resized, split, locked, and deleted.
- The inspector clearly states whether a value is inherited from the project profile or overridden by the range.

### 8.2 Cursor Telemetry V2

Replace the current sample shape with a versioned, explicitly synchronized asset.

#### Header metadata

- Format discriminator and schema version.
- Stable asset and recording IDs.
- Shared recording clock definition and timestamp unit.
- Capture kind: display, window, or region.
- Virtual desktop physical-pixel bounds.
- Captured source physical-pixel bounds.
- Encoded frame dimensions.
- Explicit affine transform from virtual-desktop coordinates to source-frame coordinates.
- Monitor topology and per-monitor scale/DPI snapshots relevant to the capture.
- Nominal sample rate and measured quality data.

#### Continuous samples

- Monotonic timestamp from the shared recording clock.
- Physical virtual-desktop x/y.
- Cursor visible flag from the Windows cursor state, not position-query success.
- Active cursor shape ID.
- Button bitset/drag state.

#### Discrete events

- Independent left, right, and middle button down/up edges.
- Wheel deltas where available for future zoom/attention analysis.
- Cursor shape changes.
- Monitor/DPI/topology changes.
- Pause/resume and segment boundaries.

#### Cursor asset manifest

Each known cursor shape provides:

- Stable shape ID and semantic role: arrow, hand, I-beam, crosshair, resize variants, custom.
- Shared SVG or raster asset.
- Width/height.
- Hotspot x/y.
- Fallback semantic shape.
- Hash for custom/unknown cursor images.

Use Windows cursor APIs such as `GetCursorInfo` and icon information APIs to determine actual visibility, handle/shape identity, bitmap, and hotspot. Record only cursor assets and metadata; never record screen content in cursor logs.

#### Capture health and fallback

- Start and validate cursor tracking before starting an FFmpeg path that omits the native cursor.
- If custom-cursor capture cannot initialize, either fall back to recording the native cursor or require an explicit user choice. Never silently produce a cursorless recording.
- Checkpoint telemetry and shape assets atomically.
- Recovery must trim/normalize cursor data to the recovered media timeline.
- Record local diagnostics for sample gaps, clock offset, dropped samples, shape failures, and topology changes without logging coordinates or media paths.

### 8.3 Canonical cursor engine

#### Preferred module design

Create one deep `cursor-engine` implementation in Rust:

```text
Raw Telemetry V1/V2
  → validate/migrate
  → normalize/index
  → compile deterministic motion path + event index
  → evaluate CursorFrame at timeline time
  → Preview adapter (WASM)
  → Export adapter (native Rust)
```

The browser must not call Tauri IPC per frame. Compile the evaluator to WebAssembly for preview and link the same implementation natively for export.

If WebAssembly size, startup, or toolchain cost fails the low-end budget, use the fallback architecture:

```text
Rust compiles canonical source-time CursorMotionPlan
  → tiny, specification-driven evaluator in TypeScript and Rust
  → mandatory cross-language golden parity suite
```

Do not continue with two independent smoothing, hotspot, click-animation, and geometry implementations.

#### Small external interface

```ts
interface CursorEvaluator {
  evaluate(request: CursorFrameRequest): CursorFrame
}

interface CursorFrameRequest {
  timelineMs: number
  screenSegment: ScreenTimeSegment | null
  profile: ResolvedCursorProfile
  previewQuality: "quality" | "performance" | "power-saving"
}

interface CursorFrame {
  visible: boolean
  position: { x: number; y: number }
  velocity: { x: number; y: number }
  opacity: number
  shapeId: string
  hotspot: { x: number; y: number }
  clickEffects: CursorClickFrame[]
  spotlight: CursorSpotlightFrame | null
}
```

Callers should not know about sample search, interpolation windows, spring state, idle indexes, cut resets, DPI transforms, or asset fallback.

### 8.4 Motion model

#### Position reconstruction

- Separate continuous position interpolation from discrete click/button events.
- Interpolate between bracketing position samples; never use a future button edge to affect an earlier frame.
- Detect telemetry gaps and lower confidence or hold safely rather than bridging long gaps with a false sweep.
- Precompute indexes and activity intervals; no backward O(n) idle scan per frame.

#### Natural smoothing

Use a deterministic, seek-safe analytical motion model:

- Filter micro-shakes before interpolation using measured distance/time thresholds.
- Use velocity-aware spring or spline behavior.
- Preserve fast intentional movement while softening small jitter.
- Define understandable presets that map to tested internal parameters.
- Precompute or analytically solve state so evaluating time `t` does not depend on having rendered frames `0…t-1`.
- “Precise” must preserve raw intent for menus, drawing, resize handles, and small controls.

#### Cut and time-remap policy

- Map timeline time through the active screen segment before evaluating cursor source time.
- Never interpolate across hard cuts, gaps, asset changes, or discontinuous source ranges.
- Reset smoothing and idle state at a hard cut unless two adjacent segments are proven source-contiguous.
- Do not leak click effects across a cut.
- Speed changes resample the cursor in timeline/output time while reading the correct source event time.
- Duplicated clips reuse immutable source telemetry but maintain independent timeline evaluation state.
- Gaps render no cursor unless a future scene type explicitly defines one.

#### Zoom and canvas policy

- Apply the same source → canvas → zoomed viewport transform to screen pixels, cursor position, click effects, spotlight, masks, and direct-manipulation overlays.
- Cursor size has an explicit policy: screen-relative or output-relative. Default to output-relative readability unless product testing chooses otherwise.
- Auto-zoom uses recorded click positions and safe-edge clamping.
- Follow-cursor remains a later capability until click-based auto zoom and static target parity are stable.

### 8.5 Rendering

#### Shared assets

- Preview displays the exact shared SVG/raster asset from the cursor manifest.
- Export rasterizes the same asset using a deterministic renderer and the same hotspot.
- Remove separately hand-authored React and Rust approximations once V2 parity is proven.

#### Effects

All effects are functions of project time:

- Click ring progress.
- Pulse scale/opacity.
- Idle fade.
- Spotlight radius/opacity.
- Shadow opacity.
- Optional motion blur later.

No effect uses an autonomous CSS animation in Quality mode. CSS may be used only as a presentation mechanism for values already evaluated from project time.

#### Preview quality modes

| Mode         | Behavior                                                                     |
| ------------ | ---------------------------------------------------------------------------- |
| Quality      | Same semantics and visual effects as export; used for parity review          |
| Performance  | Same geometry/timing, optional expensive blur disabled; clear badge          |
| Power Saving | Lower preview cadence/resolution without changing project or export settings |

### 8.6 Cursor migration

- Preserve V1 telemetry and project files; never rewrite originals without backup.
- Add a forward V1 → V2 normalization adapter.
- Mark V1 quality as `legacy-assumed` where DPI, shape, or clock data is unknowable.
- V1 projects use Clean Pointer and known top-left hotspot unless a better shape can be proven.
- Migrate global canvas cursor settings into the project default cursor profile.
- Migrate existing cursor-effect clips into sparse cursor override ranges, removing placeholder source fields.
- Preserve range timing, enabled state, preset, scale, smoothing, lock, and supported visual settings.
- Keep a compatibility reader for shipped projects until migration telemetry proves it can be removed.

### 8.7 Cursor observability

Local, redacted diagnostics may include:

- Telemetry schema and quality class.
- Sample count and measured sample cadence.
- Maximum/percentile timestamp gap.
- Number of shape changes and unsupported shapes.
- Clock offset and recovery trim result.
- Cursor evaluation p50/p95 duration.
- Preview frame drift.
- Export cursor-frame throughput.
- Parity fixture failures in development/CI.

Do not log cursor coordinates, click locations, window titles, monitor content, media paths, or user media.

---

## 9. Implementation Phases

The sequence below is dependency order, not a calendar estimate.

### Phase 0 — Freeze behavior, fixtures, and architecture decisions

**Goal:** Prevent another partial rewrite built on ambiguous behavior.

**Work:**

- Update the editor capability matrix against the current branch.
- Record current P0 reproductions: save race, editor/export remount, pointer-cancel behavior, cursor cadence, click effect mismatch, and cursor/zoom parity.
- Define the minimum supported editor window size and capture reference screenshots at key resolutions.
- Create deterministic fixture projects for cuts, gaps, speed changes, duplicate source ranges, locks, zoom, cursor ranges, captions, masks, and camera.
- Create cursor V1/V2 fixtures for 100%, 125%, 150%, mixed-DPI monitors, negative virtual-desktop coordinates, region/window capture, clicks, idle, shape changes, pause/resume, and recovery.
- Prototype Rust+WASM evaluator versus compiled motion-plan fallback and record an ADR.
- Freeze action semantics, especially ripple + locks and cut behavior for effects.

**Exit gate:** Approved action contract, cursor-engine ADR, fixture inventory, and measurable baseline.

### Phase 1 — Editor session and persistence safety

**Goal:** Eliminate edit loss before UI polish.

**Primary areas:** `app-shell.tsx`, editor stores, project wrappers, Rust project persistence.

**Work:**

- Introduce persistent `EditorSession` ownership above editor/export panels.
- Remove project loading from `TimelineView` mount.
- Add revision-aware serialized save coordinator.
- Add navigation/window-close flush guard.
- Sequence destructive snapshots with command commit.
- Preserve recovery state on save failure.
- Freeze a durable project revision before export.

**Exit gate:** Rapid edit/save/navigation/export/close tests cannot lose or roll back a newer edit.

### Phase 2 — Transactional editing interactions

**Goal:** Make core actions smooth, cancellable, and one-step undoable.

**Primary areas:** timeline lanes, camera/mask/zoom direct manipulation, editor-core command validation.

**Work:**

- Add interaction transaction controller.
- Convert move, trim, camera, mask, zoom target, crop, and caption placement to draft/commit/cancel.
- Add atomic command preflight and structured errors.
- Add lock-aware ripple policy.
- Add duplicate, context menus, snap guides, collision previews, and temporary snap disable.
- Reconcile selection after commands without persisting transient view state.

**Exit gate:** Every gesture passes pointer-up, Escape, pointer-cancel, focus-loss, invalid-drop, undo, save, reopen, and export checks.

### Phase 3 — Focused editor shell and visual redesign

**Goal:** Deliver the modern, organized workspace without changing established command semantics.

**Primary areas:** editor shell, task rail/panels, inspector modules, timeline toolbar, UI primitives.

**Work:**

- Add editor focus mode and remove nested global navigation.
- Split monolithic `timeline-view.tsx` and `clip-inspector.tsx` by workspace concern.
- Build task rail and dedicated Media, Focus, Cursor, Captions, Layout, Audio, and Privacy panels.
- Rebuild contextual inspector with Basic/Advanced sections.
- Add adaptive drawers for narrow windows.
- Add resizable timeline and remembered view layout.
- Quiet healthy statuses; add actionable health popover and jobs drawer.
- Complete keyboard focus, screen-reader labels, semantic controls, and shortcut discovery.
- Remove `transition-all` and add reduced-motion variants.

**Exit gate:** All editor tasks remain reachable by mouse and keyboard at every supported window size; WCAG AA contrast and keyboard checks pass.

### Phase 4 — Frame-accurate preview composition

**Goal:** Establish one clock and one geometry model before cursor replacement.

**Work:**

- Introduce `PlaybackClock` using video frame callbacks.
- Isolate playhead updates from non-frame UI.
- Unify screen, camera, mask, caption, zoom, and selection transforms.
- Add Quality/Performance/Power Saving modes.
- Add drift metrics and playback integration tests for cuts, gaps, and speed changes.

**Exit gate:** Preview drift remains within 1 output frame on deterministic fixtures and direct overlays share the same canvas geometry.

### Phase 5 — Cursor Telemetry V2 capture and migration

**Goal:** Produce trustworthy, recoverable cursor source metadata.

**Primary areas:** Rust capture cursor module, session clock, manifest, recovery, contracts, project assets.

**Work:**

- Add explicit physical-pixel and affine-transform coordinate contract.
- Capture cursor visibility, shape ID, hotspot/assets, independent button edges, and topology/DPI metadata.
- Synchronize timestamps to the recording session clock.
- Add health handshake and native-cursor fallback policy.
- Add compact indexed storage based on measured 60-minute cost.
- Add checkpoint/recovery and V1 reader/migration.

**Exit gate:** Windows hardware matrix passes full-screen, window, region, mixed-DPI, multi-monitor, pause/resume, forced-exit, and recovery tests.

### Phase 6 — Canonical cursor engine and preview

**Goal:** Replace nearest-sample/EMA/CSS behavior with natural deterministic motion.

**Work:**

- Implement normalization, indexes, gap handling, shake filtering, interpolation, analytical smoothing, idle fade, click effects, shape resolution, and cut resets.
- Expose evaluator to preview through the approved ADR path.
- Replace duplicate telemetry loads with one cursor asset repository/cache.
- Replace browser-clock cursor animations with project-time frames.
- Build shared cursor asset manifest.
- Add Basic/Advanced cursor controls and project profile + sparse overrides.

**Exit gate:** Arbitrary seeking produces the same cursor frame as uninterrupted playback; 60-minute cursor assets meet memory and frame budgets.

### Phase 7 — Cursor export and parity

**Goal:** Make Quality preview trustworthy.

**Work:**

- Use the native canonical evaluator in export.
- Rasterize shared cursor assets with shared hotspots.
- Apply the common canvas/zoom transform.
- Add cross-language and pixel-golden parity suites.
- Define graceful behavior for legacy/degraded telemetry.
- Validate cancellation and partial-output cleanup with cursor rendering active.

**Exit gate:** Geometry/timing parity is within 0.5 output pixel and 1 output frame on all fixtures; agreed pixel-diff tolerance passes for cursor assets/effects.

### Phase 8 — Cursor/zoom workflow polish

**Goal:** Reach the reference-product interaction standard.

**Work:**

- Add fragment context actions and visible override badges.
- Add generated click-based zoom review workflow.
- Add safe-edge target editing and lock-preserving regeneration.
- Add preset persistence and reset/inheritance UX.
- Tune default motion and click styles through user evaluation.
- Add optional idle fade and shape optimization.

**Exit gate:** A user can record, trim, apply/review cursor polish and zoom, override one fragment, and export without opening advanced settings.

### Phase 9 — Performance, accessibility, and release hardening

**Goal:** Prove the editor on the low-end Windows baseline.

**Work:**

- Run 5-, 30-, and 60-minute project benchmarks.
- Test dense cuts, captions, cursor samples, and zoom ranges.
- Add automated accessibility and keyboard-flow tests.
- Add crash/recovery and corrupted-asset tests.
- Run the complete preview/export golden suite.
- Remove legacy cursor rendering only after migration and rollback gates pass.

**Exit gate:** All Definition of Done criteria below pass on the baseline machine and supported Windows display matrix.

---

## 10. Test Strategy

### 10.1 Pure unit and property tests

- Timeline invariants for every command.
- Lock-aware atomic ripple behavior.
- Negative-time and overlap rejection for multi-move.
- Gesture transaction begin/update/commit/cancel.
- Save revision ordering and concurrent edit/save cases.
- Time mapping at every boundary and speed.
- Cursor V1/V2 migration.
- Cursor interpolation, gap handling, deterministic analytical smoothing, idle intervals, click causality, shape/hotspot, and cut resets.
- Zoom/cursor shared transforms.

### 10.2 React component and integration tests

Add desktop test infrastructure only after explicit dependency review. Cover:

- Project load four states.
- Editor → Export → Editor without reload.
- Save failure and navigation guard.
- Pointer move/trim with one final command.
- Pointer cancel and Escape.
- Keyboard alternatives for every direct manipulation.
- Inspector context and mixed multi-selection.
- Narrow-window drawers.
- Toast and jobs-drawer terminal feedback.
- Quality/performance mode labeling.

### 10.3 Desktop end-to-end flows

- Open, split, ripple-delete, undo, redo, close, reopen.
- Trim and export; compare source/output timing.
- Move multi-selection with collision and lock.
- Create and edit camera, mask, caption, zoom, and cursor override.
- Cancel and retry export.
- Missing asset relink.
- Save failure recovery.

### 10.4 Cursor parity fixtures

At selected frames, compare:

- Source and timeline time.
- Position and velocity.
- Visible/idle opacity.
- Shape ID and hotspot.
- Click effect progress.
- Zoomed canvas position.
- Preview RGBA output and export RGBA output.

Required cases:

- 16:9, 4:3, ultrawide, square, and vertical canvas.
- 100%, 125%, 150%, and mixed-DPI monitor setups.
- Negative virtual-desktop coordinates.
- Full-screen, window, and region capture.
- Hard cut, contiguous cut, gap, duplicate, and speed change.
- Left/right/middle clicks, drag, idle fade, shape changes.
- Sparse samples, long gaps, pause/resume, recovery, legacy V1.
- Cursor at safe edges under zoom and canvas padding.

### 10.5 Performance evidence

Measure on the recorded baseline machine:

- Project open and first interactive frame.
- Main-thread long tasks during load.
- Timeline drag/trim frame rate and input latency.
- Scrub latency and playback drift.
- Cursor parse/preprocess time and memory.
- Cursor evaluation p50/p95.
- Quality/Performance preview FPS.
- Export throughput with and without cursor effects.
- Save queue latency and flush correctness.

---

## 11. File and Module Impact Map

### UI/session refactor

- `apps/desktop/src/app/app-shell.tsx`
- `apps/desktop/src/features/editor/editor-shell.tsx`
- `apps/desktop/src/features/editor/editor-sidebar.tsx`
- `apps/desktop/src/features/editor/timeline/timeline-view.tsx`
- `apps/desktop/src/features/editor/timeline/timeline-lanes.tsx`
- `apps/desktop/src/features/editor/timeline/clip-inspector.tsx`
- `apps/desktop/src/features/editor/timeline/camera-preview.tsx`
- `apps/desktop/src/features/editor/timeline/mask-preview.tsx`
- `apps/desktop/src/stores/editor-store.ts`
- `apps/desktop/src/stores/timeline-store.ts`

Expected new feature folders should be concern-based, for example:

```text
features/editor/
  session/
  shell/
  workspace/
  inspector/
  timeline/
  preview/
  cursor/
  focus/
  captions/
  layout/
  audio/
  privacy/
```

Do not keep adding behavior to the existing 1,000+ line `timeline-view.tsx` and `clip-inspector.tsx` files.

### Core contracts and commands

- `packages/contracts/src/project.ts`
- `packages/contracts/src/timeline.ts`
- `packages/contracts/src/cursor.ts`
- `packages/editor-core/src/command-records.ts`
- `packages/editor-core/src/commands.ts`
- `packages/editor-core/src/history.ts`
- `packages/editor-core/src/time-mapping.ts`
- `packages/editor-core/src/snap.ts`
- `packages/cursor-core/**` or its replacement binding package
- `packages/media-core/src/render-plan.ts`

### Native cursor/project/export

- `apps/desktop/src-tauri/src/capture/cursor.rs` — split into focused capture, Windows state, telemetry, clock, and checkpoint modules.
- `apps/desktop/src-tauri/src/capture/session.rs`
- `apps/desktop/src-tauri/src/capture/manifest.rs`
- `apps/desktop/src-tauri/src/capture/recovery.rs`
- `apps/desktop/src-tauri/src/projects/mod.rs`
- `apps/desktop/src-tauri/src/exports/cursor.rs` — replace with adapter over canonical engine.
- `apps/desktop/src-tauri/src/exports/mod.rs`

Any new Tauri command or capability requires the existing security review. Per-frame cursor data must not cross Tauri IPC.

---

## 12. Rollout and Rollback

- Guard the new cursor pipeline with an internal project/capture feature flag.
- New recordings may write V2 after capture hardware gates pass; readers continue accepting V1.
- In development, run V1 and V2 evaluators against fixtures and report redacted parity metrics.
- Do not render both cursor systems into user output.
- Keep the V1 export path available for rollback until V2 migration and export parity are proven.
- A V2 capture failure must fall back before recording starts, not after the native cursor has already been omitted.
- Remove legacy React SVG/Rust primitive renderers only after release evidence confirms V1 projects migrate or use a supported compatibility path.

---

## 13. Definition of Done

### UI/UX

- One focused editor shell replaces nested global/editor navigation.
- Tasks are organized as Media, Focus, Cursor, Captions, Layout, Audio, Privacy, and Export.
- Healthy statuses are quiet; actionable failures are prominent and recoverable.
- Panels remain reachable at every supported window size.
- Preview, timeline, and inspector can be resized without losing controls.
- All direct manipulation has visible hover, active, focus, snap, invalid, and selected states.
- Keyboard and screen-reader paths cover every primary editing operation.

### Editing stability

- Every gesture commits once, cancels cleanly, and undoes once.
- No newer edit can be overwritten by an older save completion.
- Navigation, export, close, and project switching flush the latest revision or keep the user safely in the editor.
- Ripple delete is atomic and lock-aware.
- Core actions survive save, close, reopen, undo/redo, and export.
- Preview remains frame-synchronized across cuts, gaps, and speed changes.
- Every background job has visible progress and terminal feedback.

### Cursor

- Cursor capture is explicitly synchronized, DPI/coordinate-aware, shape/hotspot-aware, recoverable, and health-checked.
- Missing cursor capture cannot silently create a cursorless source when custom cursor mode was expected.
- Cursor movement is natural, deterministic, and seek-safe.
- Click effects, idle fade, visibility, and shape changes are project-time driven.
- Cursor and zoom share one coordinate transform.
- Project defaults and sparse range overrides are clear and non-destructive.
- Quality preview and export meet the agreed geometry, timing, and pixel-diff parity thresholds.
- V1 projects remain readable and migrate with backup and explicit legacy limitations.
- A 60-minute cursor recording meets load, memory, preview, and export budgets on the baseline machine.

---

## 14. Known Non-Goals for This Program

- General-purpose NLE track compositing.
- Hosted collaboration or cloud project synchronization.
- AI-generated captions before the editor foundation is stable.
- Cursor motion blur, kinetic rotation, trails, magnification, or cursor-only export before parity is complete.
- Arbitrary user-supplied cursor code or unsafe asset formats.
- Passing raw video/audio frames or per-frame cursor buffers through React state or Tauri IPC.

---

## 15. Primary Reference Sources

Accessed 2026-08-10:

- recordForge editor specification: `recordforge-editor-specification.md`
- Cap Studio Mode: https://cap.so/docs/recording/studio-mode
- Cap cursor/zoom interpolation work: https://github.com/CapSoftware/Cap/pull/1504
- Cap idle cursor delay/fade: https://github.com/CapSoftware/Cap/pull/1184
- Cap cursor shape assets/hotspots: https://github.com/CapSoftware/Cap/pull/1175
- Screen Studio cursor controls: https://screen.studio/guide/cursor
- Screen Studio per-fragment smoothing: https://screen.studio/guide/disable-smooth-mouse-movement
- Screen Studio per-fragment cursor hiding: https://screen.studio/guide/hiding-the-cursor-in-specific-sections
- Screen Studio animations: https://screen.studio/guide/animations
- Screen Studio auto zoom: https://screen.studio/guide/auto-zoom
- Screen Studio preview performance modes: https://screen.studio/guide/performance-settings
- Loom click highlighting: https://support.atlassian.com/loom/docs/highlight-your-mouse-clicks/
- Microsoft DPI and physical/logical coordinate guidance: https://learn.microsoft.com/en-us/windows/win32/learnwin32/dpi-and-device-independent-pixels
- W3C animation-from-interactions guidance: https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html

---

## 16. First Implementation Task After Approval

The first implementation task should **not** be visual styling or a new cursor preset. It should be Phase 0/1 evidence and editor-session safety:

1. Reproduce the stale save and editor/export remount risks with automated tests.
2. Introduce revision-aware `EditorSession` persistence and a single flush/navigation guard.
3. Verify that rapid edits, export navigation, close, and reopen preserve the newest project revision.

Only after this gate passes should interaction transactions, visual redesign, or Cursor V2 implementation begin.
