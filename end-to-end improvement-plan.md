# recordForge — End-to-End Improvement Roadmap

> **Status:** Draft — ready for review and approval  
> **Scope:** V1 Plus for Windows 11  
> **Primary deliverable:** Implementation-ready roadmap to take the existing Tauri v2 + React + Rust prototype through a performant, reliable, secure, local-first release.  
> **Non-goal:** This document does not rewrite [project-plan.md](project-plan.md); it operationalizes it.

---

## 1. Executive Summary and Completion Definition

### 1.1 Current maturity

recordForge has a working Tauri v2 desktop skeleton: a custom window chrome, a system tray, global shortcuts, a basic recorder UI, a library surface, a timeline presentation, and a Rust backend that can start and stop FFmpeg-based capture, generate proxies/thumbnails, and persist recordings to SQLite. Many of these surfaces are real at the component or command level but are not yet connected to a trustworthy end-to-end flow.

In short, the **demo works**, but the **product does not yet ship**.

### 1.2 V1 Plus scope

The approved target is the full **V1** definition in [project-plan.md](project-plan.md) plus a small set of **V1-plus** additions that are recorder/editor adjacent and safe to include once the critical path is solid:

- **V1 baseline** (15 outcomes from project-plan section 14):
  1. Installable Windows desktop app.
  2. Display / window / region recording.
  3. Microphone + system audio + optional webcam.
  4. Tray, global shortcuts, countdown, pause/resume, markers.
  5. Crash/forced-exit recovery.
  6. Local library.
  7. Proxy-based timeline editor.
  8. Trim, split, move, delete, ripple-delete, undo/redo.
  9. Audio and webcam PiP adjustment.
  10. Basic cursor and canvas effects.
  11. Local MP4 export from original media.
  12. Upload to local folder, S3-compatible, or Google Drive.
  13. Resume interrupted cloud uploads.
  14. Offline-first operation.
  15. Reliable 1080p30 on the agreed baseline low-end PC.

- **V1-plus additions** (see Phase 6):
  - Recording/export templates.
  - Screenshot capture and annotation.
  - First-run onboarding.
  - Truthful diagnostics export.
  - Performance and privacy hardening pass.

### 1.3 Explicit non-goals

The following remain post-V1 unless they are needed only as an architectural extension point:

- recordForge-hosted share links or public video pages.
- User accounts, workspaces, or collaboration.
- Billing, subscriptions, analytics.
- AI transcription, smart zoom, silence removal, noise cleanup, chapter suggestions.
- macOS / Linux production support.
- Full nonlinear / professional editor features (keyframes, multi-track audio mixing, advanced color).

### 1.4 What "almost complete" means

A release is **not "almost complete"** until:

- The recorder-first critical path is closed: display/window/region capture, A/V sync, crash recovery, and 1080p30 baseline performance are proven on real and synthetic hardware.
- All **P0** data-loss, security, and capture blockers are resolved or demonstrably mitigated with a fallback.
- All **P1** functional blockers are resolved: no mock data, no disconnected UI, no lying controls.
- The real proxy editor, durable export, S3-compatible multipart, Google Drive resumable, and offline operation are integrated and tested.
- Security review, privacy redaction, capability audit, and release packaging are complete.

Everything after that is polish and marketing; the roadmap below stops at the release gate, not at "looks nice in a demo."

---

## 2. Current-State Capability Matrix

| Requirement | Status | Notes / Evidence |
| ------------- | -------- | ------------------ |
| Tauri app startup, window chrome, tray | **Working** | Real; needs lifecycle hardening for forced exit. |
| Global shortcuts | **Working** | Three shortcuts wired; conflict detection and state-aware enablement are missing. |
| SQLite + migrations | **Partial** | DB exists; migrations are not atomic, one pre-release migration drops recordings, FK/index constraints incomplete. |
| Display enumeration | **Working** | Windows display/window enumeration is present. |
| Display/region capture | **Partial** | FFmpeg `ddagrab` path exists; not benchmarked, not zero-copy, scales to fixed profile and can distort non-16:9 sources. |
| Window capture | **Misleading** | Crops the desktop rectangle at the window's current coordinates; does not handle occlusion, movement, minimize, mixed-DPI, or app exclusion. |
| Microphone capture | **Partial** | Captured but mixed with system audio, so tracks are not independent in the editor. |
| System audio | **Partial** | Relies on Stereo Mix / virtual-cable DirectShow-style devices, not reliable WASAPI loopback. |
| Webcam | **Partial** | Sidecar capture exists; webcam files are not first-class assets in manifest/project. |
| Countdown | **Misleading** | Titlebar shortcut bypasses the recorder panel countdown. |
| Pause/resume/stop | **Partial** | Works for normal stop; recovery depends on validated fragments only. |
| Markers | **Partial** | Markers exist; not yet durably tied to recovered segments or project model. |
| Crash recovery | **Static/Mock** | Recovery banner is static; active-segment recovery is not dependable. |
| Audio meter | **Static/Mock** | Random data. |
| Library | **Static/Mock** | Falls back to fake recordings; no real thumbnails, no pagination, no search. |
| Storage usage | **Static/Mock** | Fake. |
| Diagnostics | **Static/Mock** | Claims unmeasured readiness. |
| Settings/profiles | **Partial** | Exposes invalid/mismatched profile descriptions; built-in profiles always prefer `libx264`. |
| FFprobe/proxy/thumbnail/waveform | **Partial** | Jobs exist; not automatically enqueued after recording; prepare-job options not persisted; duplicate/race issues. |
| Timeline components | **Partial** | Real components and command engine exist, but `timeline-view.tsx` is a separate static timeline. |
| Playback | **Misleading** | Playback state does not control the video element. |
| Export UI | **Misleading** | Polished export screen is disconnected; functional panel is not mounted. |
| Export backend | **Partial** | Stream-copy trim only; ignores most render plan; no cancel/persist. |
| Project persistence | **Missing** | Projects regenerated with new IDs; no save/autosave. |
| Storage (S3/Drive) | **Missing/Placeholder** | No complete domain or command layer. |
| Security: path policy | **Missing** | `delete_recovery_session` joins IPC string into path without containment/UUID validation. |
| Security: capabilities | **Partial** | Capabilities not split by window; floating controls inherit unneeded permissions. |
| Security: redaction | **Partial** | `#[instrument]` and debug logs may include titles, device names, full media paths. |
| Tests | **Missing** | No React, command integration, capture/recovery, E2E, or accepted benchmark evidence. |
| Packaging | **Missing** | FFmpeg/FFprobe not bundled via `externalBin`; no signing, updater, or release automation. |

---

## 3. Prioritized Flaw Register

### 3.1 P0 — data loss, security, and capture blockers

| # | Flaw | Affected modules | Why it blocks release |
| --- | ------ | ------------------ | ---------------------- |
| P0.1 | Active-segment crash recovery is not dependable: fragments become `validated` only after normal stop; no periodic independently finalized segment rollover. | `src-tauri/src/capture/**`, `recovery` | A force-quit during the first segment recovers nothing. |
| P0.2 | Window capture is desktop-crop, not true window capture; occlusion, movement, minimizing, mixed-DPI, and app-window exclusion are wrong. | `capture/windows`, `capture/metrics` | Product claims window/region recording but does not deliver it. |
| P0.3 | System audio uses DirectShow loopback devices, not WASAPI loopback. | `capture/audio` | Fails on many real machines; no reliable system audio. |
| P0.4 | Microphone and system audio are mixed during capture. | `capture/audio`, `media-core` | Editor cannot independently control required tracks; breaks V1 outcome 9. |
| P0.5 | Capture scales to a fixed profile size without preserving aspect ratio. | `capture/profiles`, `capture/session` | Distorts non-16:9 windows/regions. |
| P0.6 | Manifest writes are frequently ignored; state transitions are not authoritative; stop marks manifest complete before durable library insertion. | `src-tauri/src/state.rs`, `database` | Data loss / phantom recordings. |
| P0.7 | `delete_recovery_session` joins an IPC-supplied string into a directory path without UUID/containment validation. | `src-tauri/src/lib.rs` or equivalent, `path` helpers | Path traversal / destructive operation risk. |
| P0.8 | Recording deletion removes DB row first and ignores file-deletion failure; no project dependency or trash model. | `library`, `database` | Orphan files, broken projects, silent data loss. |
| P0.9 | Database migrations are not atomic; a pre-release migration drops recordings; project/upload tables lack constraints/indexes. | `src-tauri/src/database/**` | Upgrade data loss and orphan rows. |
| P0.10 | Timeline export creates inconsistent job IDs, does not persist jobs, cannot cancel, and can produce corrupt/short outputs. | `exports/**`, `media-core` | User gets broken MP4s or unrecoverable failures. |

### 3.2 P1 — functional blockers

| # | Flaw | Affected modules |
| --- | ------ | ------------------ |
| P1.1 | Titlebar recording flow starts capture immediately, bypassing the recorder panel countdown. | `apps/desktop/src/app/app-shell.tsx`, `features/recorder/new-recording-modal.tsx`, `features/recorder/recorder-panel.tsx` |
| P1.2 | Audio meter, library, recovery, diagnostics, and storage usage are fake or static. | `features/recorder/*`, `features/library/*`, `features/settings/*` |
| P1.3 | `timeline-view.tsx` is a hardcoded duplicate timeline; playback state does not control the video. | `features/editor/timeline-view.tsx`, `stores/timeline-store.ts` |
| P1.4 | Polished export UI is disconnected; functional export panel is not mounted. | `features/export/*` |
| P1.5 | Media preparation is manual; should run automatically after successful or recovered recordings. | `jobs`, `library`, `media` |
| P1.6 | Projects and storage surfaces are placeholders; no asset registry or complete domain. | `packages/domain`, `packages/contracts`, `features/storage/*` |
| P1.7 | TypeScript and Rust `RenderPlan` DTOs have drifted; IPC responses are not validated with Zod at runtime. | `packages/contracts`, `apps/desktop/src/lib/timeline.ts`, Rust DTOs |
| P1.8 | Editor history is unbounded; projects are regenerated with new IDs on every open. | `editor-core`, `stores/editor-store.ts` |
| P1.9 | `timeline-view.tsx` depends on the entire Zustand store object, causing repeated reloads. | `features/editor/timeline-view.tsx` |
| P1.10 | Prepare-job options are not persisted; duplicates allowed; cancellation can race completion. | `jobs` |

### 3.3 P2 — UX, performance, and engineering debt

| # | Flaw | Affected modules |
| --- | ------ | ------------------ |
| P2.1 | Built-in profiles always prioritize `libx264`; hardware encoders are not detected or recommended. | `capture/profiles`, `settings` |
| P2.2 | `ddagrab` downloads D3D11 frames to CPU before encoding, defeating zero-copy. | `capture/engines` |
| P2.3 | Library queries load every row; no pagination, virtualization, or indexing. | `features/library/*`, `database` |
| P2.4 | Heavy jobs are not coordinated with active capture; low-end machines can stall. | `jobs`, `capture` |
| P2.5 | Floating controls inherit unneeded `dialog`, `opener`, `global-shortcut`, and broad `core` permissions. | `src-tauri/capabilities/*.json` |
| P2.6 | Several loaded frontend Tauri plugins/permissions appear unused. | `tauri.conf.json`, `capabilities` |
| P2.7 | No React tests, command integration tests, media fixtures, E2E, or benchmark evidence. | Whole repo |
| P2.8 | FFmpeg/FFprobe are not bundled as Tauri `externalBin`; sidecar startup is unverified. | `src-tauri/Cargo.toml`, `tauri.conf.json`, build scripts |

---

## 4. Target Architecture and Data Flows

### 4.1 Process boundaries and ownership

```text
React UI (apps/desktop/src)
  │  Tauri commands (typed, validated, compact)
  │  Tauri events/channels (state, progress, compact status)
  ▼
Tauri Rust Core (apps/desktop/src-tauri/src)
  ├── Recorder state machine
  ├── Capture supervisor (display, window, region)
  ├── Audio supervisor (WASAPI mic + loopback)
  ├── Webcam supervisor (separate timestamped asset)
  ├── Session writer (periodic finalized segments)
  ├── SQLite persistence + migrations
  ├── Durable job scheduler (prepare, export, upload)
  ├── Media engine / FFmpeg-FFprobe sidecars
  ├── Project + asset registry
  ├── Storage provider adapters (local, S3, Drive)
  ├── Credential vault (Windows Credential Manager)
  ├── Tray, global shortcuts, notifications
  └── Diagnostics / redacted logging

Local filesystem
  ├── Immutable originals + segments
  ├── Proxies, thumbnails, waveforms, sprites
  ├── Projects (project.json + SQLite index)
  ├── Recovery manifests
  └── Export partials + finals

Cloud (optional, user-owned)
  ├── S3-compatible multipart
  └── Google Drive resumable
```

### 4.2 IPC and event rules

| Channel | Use | Never use for |
| --------- | ----- | --------------- |
| Tauri command | Start/stop, query, create job, validate path, CRUD | Continuous frame transfer, large logs, secrets |
| Tauri event/channel | Recording state, audio levels, progress %, compact errors | Raw frames, PCM, full FFmpeg logs, credentials |
| React state | UI selection, playhead, panels, interaction | File contents, frame data, credentials, raw paths |
| Rust background task | Capture, encoding, upload, proxy, render | Blocking the UI thread |
| SQLite | Metadata, project index, queue/resume state | Plaintext credentials, large binary media |
| OS credential vault | OAuth refresh, S3 keys | Project data or media files |

### 4.3 Capture pipeline

1. **Source selection** → Rust enumerates displays/windows/regions and validates device capabilities.
2. **Preflight** → disk-space check, encoder recommendation, profile validation, risky-profile warning.
3. **Setup → Countdown** → a cancellable Rust-owned state transition, triggered identically by UI, tray, hotkey, and floating controls.
4. **Capture** → hybrid engine per benchmark result; separate video, microphone, system audio, and webcam streams; shared monotonic timeline.
5. **Segmentation** → periodic independently finalized segments; each segment is self-validating with FFprobe on rollover.
6. **Stop/finalize** → flush current segment, mark `finalizing`, run integrity checks, insert into library, then mark `complete`; forced exit leaves a recoverable manifest.

### 4.4 Session and asset format

- **Originals** are immutable.
- **Session** = manifest + one or more finalized segment files + active (possibly unfinalized) segment.
- **Assets** are typed: `screen`, `microphone`, `system_audio`, `webcam`, `marker`, `caption`, `image`, `cursor_events`.
- **Projects** are `project.json` files + SQLite index; edits are metadata referencing asset IDs.
- **Derivatives** (proxy, thumbnail sprite, waveform) are versioned recipes and invalidated/rebuilt automatically.

### 4.5 Durable job system

A single scheduler owns `prepare`, `export`, and `upload` jobs:

- Persisted: kind, serialized options, priority, stage, attempts, outputs, cancellation token, restart policy.
- Resource throttling: low-end concurrency limits, pause derivatives during capture, deduplicate equivalent jobs.
- Atomic outputs: write to `.partial`, validate, then publish.
- One root event subscription in React; jobs drawer + toasts for progress/failure/success.

### 4.6 Render pipeline

- Rust resolves a `RenderPlan` from trusted project assets (never from frontend-supplied paths).
- Render DAG/filter plan handles trims, gaps, speed, separate mic/system gain/fades, webcam PiP/crop/shape, canvas, markers, captions, and cursor effects.
- Capability-driven presets: default H.264/AAC MP4; high-quality/60fps/GIF/vertical only when valid.
- Export writes to `.partial`, FFprobe-validates duration/streams, then atomically publishes.

### 4.7 Storage providers

- **Local folder** → copy with checksum, atomic destination handling.
- **S3-compatible** → multipart with persisted upload ID/part ETags, bounded parallelism, backoff, pause/resume/retry/cancel, abort cleanup, checksum verification.
- **Google Drive** → OAuth 2.0 Authorization Code + PKCE in system browser, state/nonce validation, refresh-token vault storage, resumable chunked uploads; resumable session URIs treated as secrets.

---

## 5. Phased Implementation Roadmap

The recorder-first critical path (Phases 0–3) blocks editor and cloud polish until capture, sync, recovery, and low-end benchmarks pass. No timeline, storage, or export refinement proceeds past design until those gates close.

### Phase 0 — Freeze Truth and Build the Verification Harness

**Goal:** Replace stale, unchecked interpretations with an audited status matrix and a reproducible test harness so every later phase has evidence.

| Work package | Dependencies | Affected files / new modules |
| -------------- | -------------- | ------------------------------ |
| Audit current state against the matrix in this document. | This roadmap | All source, specs, ADRs |
| Write missing feature specs and test plans: capture state machine, recovery/session format, project format, media jobs/render plan, storage contract, security/path policy, low-end benchmark. | — | `docs/specs/*`, `docs/test-plans/*` |
| Build synthetic-media fixture generator. | — | `tooling/fixtures/**` |
| Define baseline Windows 11 low-end machine and hardware matrix. | — | `docs/benchmarks/baseline-machine.md` |
| Capture baseline metrics before architectural changes: startup, CPU/GPU/memory, actual/dropped FPS, A/V drift, disk throughput, segment recovery, 30/60/120-minute stability. | Fixture generator, baseline machine | `docs/benchmarks/phase-0-baseline.md` |
| Add a red test or reproducible scenario for every P0 blocker. | — | Rust tests, integration tests |

**Acceptance criteria:**

- [ ] Current behavior and failures are reproducible on demand.
- [ ] Baseline capture/recovery/perf numbers are recorded for the existing prototype.
- [ ] Every P0 blocker has a failing test or recorded manual reproduction.
- [ ] No subsequent phase can claim success without evidence from the harness.

**Rollback / fallback:** No architectural changes yet; the only cost is documentation and fixtures.

---

### Phase 1 — Contract, IPC, Persistence, and Security Foundation

**Goal:** Make shared contracts authoritative, secure the path and command boundaries, and make the database migration-safe.

| Work package | Dependencies | Affected files / new modules |
| -------------- | -------------- | ------------------------------ |
| Make contracts authoritative and versioned: typed source enums, project/assets/export settings, media roles, capture metrics, durable jobs/uploads, complete render-plan DTOs. | Phase 0 | `packages/contracts/src/{recording,media,project,timeline,jobs,storage,errors}.ts` |
| Add `invokeValidated` and mirrored Rust validation at every command boundary; add cross-language golden fixtures. | Contracts | `apps/desktop/src/lib/ipc.ts`, Rust DTOs, `tooling/golden-fixtures/**` |
| Remove raw frontend-supplied media paths from render plans; use asset IDs; Rust resolves trusted paths. | Contracts | `packages/media-core/src/*`, Rust export code |
| Implement central UUID/path authorization policy: canonical containment, extension rules, one-time user-selected export destinations, symlink/reparse-point defenses, overwrite confirmation. | — | `src-tauri/src/path_policy.rs`, `src-tauri/src/validation.rs` |
| Split main/floating capabilities; remove unused `opener`, `global-shortcut`, `dialog`, and broad `core` permissions from windows that do not need them. | Security ADR | `src-tauri/capabilities/*.json`, `tauri.conf.json` |
| Replace ad-hoc migrations with transactional, forward-only, tested migrations; add uniqueness, FKs, indexes, busy timeout, integrity check, backup-before-migrate, startup reconciliation. | — | `src-tauri/src/database/migrations.rs` |
| Implement trash/restore/empty-trash and project-reference checks before physical deletion. | Database | `src-tauri/src/library/trash.rs`, `database` |
| Add graceful Tauri exit/close handling that prevents unsafe shutdown during capture/finalization and leaves a recoverable manifest if forced. | State machine | `src-tauri/src/lib.rs`, `src-tauri/src/state.rs` |

**Acceptance criteria:**

- [ ] Malformed IPC/path-traversal/destructive operations are rejected.
- [ ] Contracts round-trip across Rust/TypeScript and drift is caught in CI.
- [ ] Migrations and backup tests pass from every supported schema version.
- [ ] Capability files pass a least-privilege review.

**Rollback / fallback:** If any new contract breaks existing capture, keep the old DTO behind a versioned schema until capture is migrated.

---

### Phase 2 — Benchmark-Gated Hybrid Capture and Recovery Core

**Goal:** Make capture correct, recoverable, and low-end performant before any editor or cloud work.

| Work package | Dependencies | Affected files / new modules |
| -------------- | -------------- | ------------------------------ |
| Refactor capture around explicit traits/supervisors: source discovery, video capture, audio capture, encoder selection, session writing, metrics. | Phase 1 | `src-tauri/src/capture/{engine,source,session,metrics,profile}.rs` |
| Benchmark optimized FFmpeg D3D11 capture against Windows Graphics Capture/DXGI + Media Foundation for display/window/region. Select lowest-overhead engine per class with tested fallback. | Phase 0 baseline | `docs/benchmarks/capture-engines.md`, `src-tauri/src/capture/engines/**` |
| Add native WASAPI loopback for system audio and microphone capture with shared monotonic timeline; preserve separate tracks/streams. | Audio supervisor | `src-tauri/src/capture/audio/wasapi.rs` |
| Represent webcam as first-class separately timestamped asset; validate camera capabilities before start. | Contracts | `src-tauri/src/capture/webcam.rs` |
| Apply encoder detection/preflight to profiles; support zero-copy/hardware where filter graphs permit, conservative x264 fallback otherwise. | Profile engine | `src-tauri/src/capture/profiles.rs` |
| Preserve aspect ratio, virtual-desktop/mixed-DPI, color space, cursor, app-window exclusion, and display/window lifecycle changes. | Source supervisor | `src-tauri/src/capture/source.rs` |
| Replace pause-created pseudo-segments with periodic independently finalized recoverable segments; explicit finalizing/failed/recovery states; FFprobe integrity checks. | Session writer | `src-tauri/src/capture/session.rs` |
| Capture per-session metrics: requested/actual FPS, dropped/duplicated frames, encoder, CPU/GPU/memory, disk bytes, audio underruns, A/V drift. | Metrics | `src-tauri/src/capture/metrics.rs` |

**Acceptance criteria:**

- [ ] 30-minute 1080p30 and 120-minute fallback recordings pass on the baseline machine.
- [ ] True window/region/multi-monitor capture works; occlusion and DPI are correct.
- [ ] A/V drift and crash-loss budgets are met.
- [ ] Forced exit preserves every finalized segment.
- [ ] Benchmark results are recorded and gate engine selection.

**Rollback / fallback:** If a native engine is not stable, fall back to the current FFmpeg path with the new session/recovery model and document the gap.

---

### Phase 3 — Recorder, Preflight, Tray, and Floating-Control Integration

**Goal:** Make every recording start path consistent, truthful, and usable.

| Work package | Dependencies | Affected files / new modules |
| -------------- | -------------- | ------------------------------ |
| Consolidate duplicate modal/panel source configuration into one authoritative recording setup flow. | Contracts | `features/recorder/new-recording-modal.tsx`, `features/recorder/recorder-panel.tsx` |
| Make countdown a cancellable Rust-owned state transition; align titlebar, tray, global shortcut, and UI starts. | State machine | `apps/desktop/src/app/app-shell.tsx`, `src-tauri/src/state.rs` |
| Persist validated quick-start defaults; first shortcut opens setup rather than failing. | Settings | `src-tauri/src/settings.rs`, `stores/recorder-store.ts` |
| Add source previews, truthful device/capability states, real mic/system meters from compact events, disk/runtime estimates, risky-profile warnings, and device-recovery actions. | Phase 2 capture | `features/recorder/*`, `stores/recorder-store.ts` |
| Open/update/reposition floating controls; include timer, audio levels, marker, pause/resume, stop, error state. | Floating window | `features/floating-controls/**`, `src-tauri/src/window.rs` |
| Make tray labels/icons and shortcut availability reflect live state; conflict detection and persisted shortcut customization. | Shortcuts/tray | `src-tauri/src/tray.rs`, `src-tauri/src/shortcuts.rs` |
| Move blocking detection/benchmark/finalization off UI threads; add idempotency and rapid-action guards. | State machine | `src-tauri/src/commands.rs` |

**Acceptance criteria:**

- [ ] Every start entry point follows `setup → countdown → recording → finalizing → saved`.
- [ ] No fake data remains in recorder, tray, or floating controls.
- [ ] Device loss, hotkey conflict, low disk, and stop/finalization failures are actionable.
- [ ] 1080p30 workflow can be started and stopped from all four entry points without error.

**Rollback / fallback:** If floating controls cannot be made reliable, temporarily hide them and use tray + shortcuts as primary transport.

---

### Phase 4 — Durable Job Platform, Recovery UI, and Local Library

**Goal:** Replace ad-hoc job logic with a durable scheduler and make library/recovery real.

| Work package | Dependencies | Affected files / new modules |
| -------------- | -------------- | ------------------------------ |
| Replace prepare/export/upload-specific thread logic with one durable job scheduler. | Phase 1 jobs contract | `src-tauri/src/jobs/**` |
| Limit heavy concurrency for low-end systems, pause/throttle derivatives during recording, deduplicate jobs, clean partial outputs atomically. | Scheduler | `src-tauri/src/jobs/scheduler.rs` |
| Auto-enqueue probe/proxy/thumbnail/waveform after successful or recovered recordings; version derivative recipes and invalidate/rebuild. | Media | `src-tauri/src/media/derivatives.rs` |
| Mount one root event subscription and jobs drawer; show progress/ETA, cancel/retry, history, mandatory toasts. | Frontend | `features/jobs/**`, `stores/jobs-store.ts` |
| Connect real recovery scanner to a four-state recovery surface with preview, Recover, Export recovered, Delete, progress. | Recovery | `features/recovery/**`, `src-tauri/src/recovery.rs` |
| Remove library mocks; add paginated indexed search/sort/status/tag/collection queries, real thumbnails, disk usage, rename/duplicate/reveal/open/trash/restore, export/upload history, virtualization. | Library | `features/library/**`, `src-tauri/src/library/**` |
| Reconcile manifests, files, DB rows, derivatives, and jobs at startup. | Scheduler, DB | `src-tauri/src/lifecycle.rs` |

**Acceptance criteria:**

- [ ] A 60-minute recording becomes editable automatically without freezing the UI.
- [ ] Jobs restart safely after app crash.
- [ ] Recovery is proven by forced-exit tests.
- [ ] A 10k-record synthetic library remains responsive.

**Rollback / fallback:** If full jobs drawer is too heavy, start with a toast-only progress surface and add the drawer later.

---

### Phase 5 — Versioned Projects and the Real Proxy Editor

**Goal:** Make projects durable and the editor actually edit.

| Work package | Dependencies | Affected files / new modules |
| -------------- | -------------- | ------------------------------ |
| Complete project schema: asset registry, source roles, project version, tracks/clips/effects/captions/markers, canvas, export settings, checksums, migration metadata. | Phase 1 contracts | `packages/domain/src/project.ts`, `packages/contracts/src/project.ts` |
| Implement Rust project CRUD, atomic `project.json` writes, SQLite indexing, import/duplicate/rename/delete, autosave, backup snapshots, migration, relink. | Project schema | `src-tauri/src/projects/**` |
| Load saved projects; track dirty/saving/saved/error states; cap/coalesce command history. | Editor store | `stores/editor-store.ts`, `editor-core/src/history.ts` |
| Mount and consolidate existing modular timeline components; remove static duplicate timeline. | Timeline | `features/editor/**`, `features/editor/timeline-view.tsx` |
| Synchronize proxy playback with store and `requestAnimationFrame`; connect seek/timeupdate/play/pause, thumbnails, waveform, markers, camera preview. | Playback | `features/editor/playback.tsx`, `stores/timeline-store.ts` |
| Implement/finish trim, split, move, delete, range/ripple delete, speed, clip/track gain, fades, mute/solo/lock, camera crop/position/shape, captions, canvas, markers, undo/redo. | Editor commands | `packages/editor-core/src/commands.ts` |
| Virtualize time-window and tracks; dnd-kit with keyboard alternatives; keep drag state out of persisted project. | Timeline UI | `features/editor/track-lane.tsx`, `features/editor/timeline-ruler.tsx` |
| Add desktop shortcuts, selection/focus, screen-reader labels, reduced motion, four async states for project/media loading. | UX | `packages/ui`, `features/editor/*` |

**Acceptance criteria:**

- [ ] Close/reopen preserves edits.
- [ ] Undo/redo is deterministic.
- [ ] 60-minute project remains within interaction/frame budgets.
- [ ] Proxy playback matches edited time mapping.

**Rollback / fallback:** If full ripple-delete or speed changes are too risky, defer them behind a `v1.1` feature flag and ship a simpler trim/split/delete editor.

---

### Phase 6 — Accurate Durable Export and V1-Plus Studio Features

**Goal:** Replace the partial exporter and add recorder/editor adjacent V1-plus features.

| Work package | Dependencies | Affected files / new modules |
| -------------- | -------------- | ------------------------------ |
| Replace partial stream-copy exporter with validated render DAG/filter plan resolved from trusted assets. | Phase 5 project, Phase 1 render plan | `src-tauri/src/exports/render.rs`, `packages/media-core/src/render-plan.ts` |
| Render source trims, ordering/gaps, speed, separate mic/system gain/fades/mix, webcam PiP/crop/shape, canvas, markers, captions, cursor/click effects. | Render DAG | `src-tauri/src/exports/filters.rs` |
| Capture cursor position/click metadata during recording; apply effects at preview/export time, not in capture. | Capture metadata | `src-tauri/src/capture/cursor.rs` |
| Make export presets capability-driven and truthful; default H.264/AAC MP4. | Profiles | `features/export/presets.tsx` |
| Estimate size/disk, persist settings/history, support cancel/retry, `.partial` + FFprobe validation, atomic publish. | Export job | `src-tauri/src/exports/job.rs` |
| Consolidate two export UIs into one connected flow. | UI | `features/export/*` |
| Add V1-plus templates, screenshot capture/annotation, first-run onboarding, truthful diagnostics export. | Studio | `features/templates/*`, `features/screenshot/*`, `features/onboarding/*`, `features/diagnostics/*` |
| Defer AI transcription, smart zoom, silence/noise cleanup. | — | Documented in non-goals |

**Acceptance criteria:**

- [ ] Golden-media exports match timeline state within frame/audio tolerances.
- [ ] Cancellation leaves no published corrupt file.
- [ ] Low-end export never blocks recording controls or the UI.
- [ ] Templates, screenshot, onboarding, and diagnostics are wired and truthful.

**Rollback / fallback:** If full render DAG is not ready, ship an improved stream-copy exporter that honors simple trims/gaps only and document the limitation.

---

### Phase 7 — Local, S3-Compatible, and Google Drive Destinations

**Goal:** Make storage uploads safe, resumable, and optionally available without compromising local exports.

| Work package | Dependencies | Affected files / new modules |
| -------------- | -------------- | ------------------------------ |
| Define provider-neutral contracts in `packages/storage-core` and Rust traits/adapters. | Phase 1 storage contract | `packages/storage-core/src/*`, `src-tauri/src/storage/traits.rs` |
| Implement local-folder copy with checksum and atomic destination handling. | Storage | `src-tauri/src/storage/local.rs` |
| Implement storage profiles that persist only non-secret metadata and vault references. | Security | `src-tauri/src/storage/profiles.rs` |
| Implement S3 endpoint diagnostics and multipart with persisted upload ID/part ETags, bounded parallelism, backoff, pause/resume/retry/cancel, abort cleanup, checksum, app-restart recovery. | S3 | `src-tauri/src/storage/s3.rs` |
| Implement Google OAuth 2.0 Authorization Code + PKCE in system browser, state/nonce, refresh-token vault, resumable chunked uploads; resumable session URIs as vault data. | Drive | `src-tauri/src/storage/drive.rs`, `src-tauri/src/credentials.rs` |
| Integrate uploads into durable scheduler and storage UI; never remove/invalid local export on remote failure. | Jobs, UI | `features/storage/*`, `src-tauri/src/jobs/upload.rs` |

**Acceptance criteria:**

- [ ] 1 GB S3 and Drive uploads survive network interruption and app restart.
- [ ] Invalid credentials/permissions/quota/rate limits are actionable.
- [ ] Logs/SQLite/project files contain no credentials or bearer URLs.

**Rollback / fallback:** If OAuth/Drive is not ready at release time, ship S3 + local only and enable Drive behind a feature flag after security review.

---

### Phase 8 — UX, Accessibility, Privacy, Diagnostics, and Performance Hardening

**Goal:** Make the app feel like a modern, trustworthy desktop product.

| Work package | Dependencies | Affected files / new modules |
| -------------- | -------------- | ------------------------------ |
| Remove account/profile affordances that conflict with V1 non-goals; every visible control is connected or explicitly disabled with a reason. | UI sweep | `apps/desktop/src/app/*`, `features/settings/*` |
| Apply shared UI kit and tokens consistently; remove raw colors/emoji icons, hover-only actions, missing labels, false status claims, uncancellable waits. | UI kit | `packages/ui/**`, all features |
| Enforce skeleton → content \| empty \| error+retry for every async surface; disabled/pending/cancel states for mutations. | UX pattern | All features |
| Add keyboard navigation, focus management, accessible timeline alternatives, live progress announcements, contrast/reduced-motion. | a11y | `packages/ui`, `features/editor/*` |
| Add redacted structured logs with rotation/retention, local crash/session markers, user-inspectable diagnostics bundles, no telemetry by default, explicit opt-in for remote crash submission. | Privacy | `src-tauri/src/logging.rs`, `src-tauri/src/diagnostics.rs` |
| Profile startup, React rerenders, IPC frequency/payloads, SQLite queries, job scheduling, timeline frame budgets, asset loading, and capture/render coexistence; fix measured regressions. | Perf | `docs/benchmarks/perf-hardening.md` |

**Acceptance criteria:**

- [ ] Static accessibility review + keyboard/manual tests pass.
- [ ] Privacy redaction tests pass.
- [ ] Idle/capture/editor performance budgets are measured on baseline hardware.

**Rollback / fallback:** If a11y remediation is large, triage by severity and document a11y backlog for v1.1.

---

### Phase 9 — Packaging, CI, Installer, Updater, and Release Qualification

**Goal:** Bundle, sign, and release a verifiable Windows V1-plus installer.

| Work package | Dependencies | Affected files / new modules |
| -------------- | -------------- | ------------------------------ |
| Pin and bundle FFmpeg/FFprobe via Tauri `externalBin` with target-triple naming, checksums, licenses, build script, startup version verification. | Sidecars | `src-tauri/binaries/**`, `tauri.conf.json`, `src-tauri/Cargo.toml` |
| Expand tests: Rust state/recovery/DB/job/export/storage integration, contract golden fixtures, editor property/command tests, React Testing Library, WebdriverIO + Tauri WebDriver, synthetic media, forced-exit, clean VM. | All phases | `.github/workflows/*`, `tests/**` |
| Add dependency/license/security audits, secret scanning, artifact retention, SBOM, signed release provenance, benchmark comparison to CI. | Release | `.github/workflows/release.yml` |
| Configure MSI/NSIS metadata, file associations (if approved), code signing, signed updater manifests/public key, stable/beta channels, rollback policy, migration compatibility. | Packaging | `src-tauri/tauri.conf.json`, `src-tauri/windows/**`, release docs |
| Verify install/update/uninstall, tray/startup, sidecars, vault, recovery, clean user profile, restricted user, offline operation, Windows Defender/SmartScreen on clean VMs. | QA | `docs/qa/release-qualification.md` |

**Acceptance criteria:**

- [ ] Every final acceptance item has automated or recorded manual evidence.
- [ ] Security review is complete.
- [ ] Installer/updater/recovery/storage/hardware matrices pass.
- [ ] No open P0/P1 defects.

**Rollback / fallback:** If code signing is delayed, ship an unsigned test channel with explicit SmartScreen guidance and sign before stable release.

---

## 6. Cross-Cutting UX Quality Bar

Every feature added from this point forward must satisfy the following, regardless of which phase owns it:

1. **Four-state pattern** for every async surface: `skeleton → content | empty | error(+retry)`.
2. **Truthful capability-driven UI** — if the backend cannot do something, the control is disabled with a tooltip reason, never a fake success state.
3. **Mandatory feedback** — every background job ends in a toast or jobs-drawer entry; nothing completes silently.
4. **Desktop keyboard workflow** — global and local shortcuts, focus-visible, `Esc` and `Enter` behavior, tab order, `Ctrl+Z`/`Ctrl+Y` in editor.
5. **Reduced-motion support** — honor `prefers-reduced-motion`; no motion-only feedback.
6. **No hover-only functionality** — every action reachable by keyboard and touch.
7. **Icon-only buttons** use the shared `IconButton` primitive with `aria-label` and tooltip.
8. **No emoji icons** — `lucide-react` only.
9. **Design tokens only** — no raw hex/px literals outside `packages/ui/src/styles/theme.css`.
10. **Destructive safeguards** — trash before delete, project reference checks, explicit overwrite confirmation, undo where feasible.

---

## 7. Performance and Benchmark Plan

### 7.1 Baseline machine

Define and document in `docs/benchmarks/baseline-machine.md`:

- CPU, GPU, RAM, storage type.
- Windows 11 build, display scaling, monitor resolution.
- Microphone and webcam devices.
- Power plan and thermal behavior.

### 7.2 Capture matrix

| Scenario | Target | Fail threshold |
| ---------- | -------- | ---------------- |
| 1080p30 full display, 30 min | ≤ 5% frame drops, A/V drift ≤ 1 frame | > 5% drops or drift > 2 frames |
| 720p30 fallback, 120 min | ≤ 3% frame drops | > 5% drops |
| 1080p60 high-end option | ≤ 10% drops on baseline if enabled | disable if fails |
| Window capture (moving/minimized) | No black frames, correct occlusion | visible artifacts |
| Region capture (mixed-DPI) | Correct coordinates, no distortion | coordinate/scale errors |
| Webcam sidecar | A/V sync within 1 frame | > 2 frames drift |

### 7.3 Timeline and library scale tests

- 10,000 synthetic library records: load < 500 ms, sort/search < 100 ms, scroll 60 fps.
- 60-minute timeline: open < 2 s, seek < 100 ms, playback frame budget 16.6 ms (30 fps) / 33.3 ms (60 fps proxy).

### 7.4 Render and upload benchmarks

- 5-minute 1080p30 export on baseline: < 2× real time for simple trim, < 4× for full composited export.
- 1 GB upload resume: must survive app restart and network interruption; re-upload only missing parts.

### 7.5 Release thresholds

- 1080p30 on baseline must pass 30- and 120-minute tests with no data loss on forced exit.
- Editor interaction must remain above 30 fps during playback.
- Export must not block the UI or recording controls.

---

## 8. Security and Privacy Plan

| Concern | Requirement | Owner |
| --------- | ------------- | ------- |
| Path authorization | Every file path is canonicalized and contained within an allowed scope; UUID validation; symlink/reparse-point defenses; no raw IPC strings joined to paths. | Rust `path_policy` |
| Command validation | All Tauri command inputs validated with the same Zod/Rust schema; mirror validation on both sides. | Contracts + commands |
| Capabilities | Split by window: main, recorder, floating, editor, settings; least privilege; remove unused permissions. | `capabilities/*.json` |
| Credential vault | S3 keys and Google refresh tokens in Windows Credential Manager only; resumable session URIs treated as secrets; no plaintext in SQLite/logs. | `credentials.rs`, `storage` |
| OAuth | Google OAuth 2.0 Authorization Code + PKCE in system browser; state/nonce validation; loopback/custom callback review. | `storage/drive.rs` |
| Log redaction | `#[instrument]` and debug logs must not include window titles, device names, full media paths, credentials, or screen content. | `logging.rs`, `diagnostics.rs` |
| Diagnostics | User-inspectable, opt-in for remote submission, redacted, with rotation/retention. | `diagnostics.rs` |
| Updater | Signed manifests and public key; downgrade/rollback policy. | Phase 9 packaging |
| Destructive operations | Trash/restore, project reference checks, explicit confirmation, atomic cleanup. | `library/trash.rs` |

---

## 9. Testing and CI Strategy

### 9.1 Test layers

| Layer | Technology | What it covers |
| ------- | ------------ | ---------------- |
| Rust unit/integration | `cargo test` | State machine, path policy, DTO round-trips, database migrations, job scheduler, capture/recovery logic. |
| Contract golden fixtures | Cross-language JSON fixtures | Detect Rust/TypeScript DTO drift in CI. |
| Editor command property tests | TypeScript tests | Undo/redo determinism, project serialization, command history bounds. |
| React component tests | React Testing Library / Vitest | Four states, async surfaces, job drawer, export flow. |
| E2E | WebdriverIO + Tauri WebDriver on Windows | Recorder start/stop, library, editor, export, upload, forced exit, clean install. |
| Synthetic media | Fixture generator | Deterministic inputs for proxy, waveform, thumbnail, export validation. |
| Forced-exit / recovery | Scripted kill during capture | Segment recovery and manifest reconstruction. |
| Clean-VM installer test | Manual / CI runner | Install/update/uninstall, SmartScreen, offline operation, restricted user. |

### 9.2 CI gates

- `cargo fmt` and `cargo clippy -- -D warnings`.
- TypeScript typecheck and lint.
- Contract golden fixture diff check.
- Unit and integration test pass.
- Synthetic media export validation.
- Benchmark result comparison (regression detection).
- Dependency/license/security audit.
- Secret scanning.

---

## 10. Packaging and Release Plan

### 10.1 Sidecars

- FFmpeg and FFprobe bundled as Tauri `externalBin`.
- Target-triple naming (`ffmpeg-x86_64-pc-windows-msvc.exe`).
- Version and checksum verification at startup.
- License and attribution files included.
- Reproducible acquisition/build script.

### 10.2 Installer

- MSI and NSIS metadata.
- Code signing (deferred only if test channel).
- File associations (if approved by ADR).
- `tauri.conf.json` updater configuration.

### 10.3 Updater

- Signed manifests with public key pinned in the app.
- Stable and beta channels.
- Rollback policy for broken updates.

### 10.4 Release qualification

- SBOM and dependency license audit.
- Clean Windows 11 VM install/uninstall/update.
- Restricted-user and offline operation.
- Windows Defender / SmartScreen behavior documented.
- No P0/P1 defects; all release gates have evidence.

---

## 11. File and Module Impact Map

### 11.1 Existing areas to refactor (by phase)

| Phase | Areas | Representative existing patterns |
| ------- | ------- | ---------------------------------- |
| 0 | `docs/`, `tooling/` | Add specs, test plans, benchmark records, fixtures. |
| 1 | `apps/desktop/src/app/*` | Lifecycle-aware navigation, root event/job providers, remove placeholder account UI. |
| 1 | `apps/desktop/src/features/recorder/*`, `stores/recorder-store.ts` | Refactor to authoritative setup/countdown/preflight/meters/transport. |
| 1, 4 | `apps/desktop/src/features/library/*`, `stores/jobs-store.ts`, `lib/{library,media}.ts` | Real data, recovery, pagination, durable jobs, four states. |
| 5, 6 | `apps/desktop/src/features/editor/**`, `stores/{editor,timeline}-store.ts`, `lib/timeline.ts` | Saved projects, real playback/timeline, persistence/export. |
| 6, 7 | `apps/desktop/src/features/export/*`, `features/settings/*`, `features/storage/*` | Connected capability-driven export/settings/storage/diagnostics. |
| 1 | `packages/contracts/src/{recording,media,project,timeline,errors,storage,jobs}.ts` | Versioned complete DTOs and schemas. |
| 1, 5, 6, 7 | `packages/domain/src/*`, `packages/editor-core/src/*`, `packages/media-core/src/*`, `packages/storage-core/src/*` | Complete project/editor/render/storage models and tests. |
| 1, 3 | `apps/desktop/src-tauri/src/{lib,state,events,errors,shortcuts,tray,window}.rs` | Lifecycle, event envelopes, redaction, shortcuts/tray. |
| 2 | `src-tauri/src/capture/**` | Hybrid engines, separate A/V assets, segmentation, metrics, recovery. |
| 1, 4, 5, 6, 7 | `src-tauri/src/{database,jobs,media,exports,projects,storage,credentials}/**` | Migrations, durable scheduler, derivatives, accurate render/export. |
| 1, 9 | `src-tauri/capabilities/*.json`, `tauri.conf.json`, `Cargo.toml`, build scripts, CI workflows | Least privilege, sidecars, tests, packaging, updater. |

### 11.2 New implementation areas

| Area | Proposed modules | Notes |
| ------ | ------------------ | ------- |
| Capture | `src-tauri/src/capture/windows.rs`, `src-tauri/src/capture/audio/wasapi.rs`, `src-tauri/src/capture/webcam.rs`, `src-tauri/src/capture/metrics.rs`, `src-tauri/src/capture/session.rs`, `src-tauri/src/capture/profiles.rs` | Exact file names are proposals; confirm in each phase's spec/ADR. |
| Projects | `src-tauri/src/projects/**` | Atomic `project.json` + SQLite CRUD, autosave, snapshots. |
| Storage | `src-tauri/src/storage/{local,s3,drive}.rs`, `packages/storage-core/src/*` | Provider-neutral contracts + adapters. |
| Credentials | `src-tauri/src/credentials.rs` | Vault abstraction; no secrets in DB. |
| Path policy | `src-tauri/src/path_policy.rs` | Central containment and validation. |
| Diagnostics | `src-tauri/src/diagnostics.rs`, `src-tauri/src/logging.rs` | Redacted logs and user-exportable bundles. |
| Frontend | `features/recovery/*`, `features/jobs/*`, `features/projects/*`, `features/storage/*`, `features/onboarding/*`, `features/screenshot/*`, `features/diagnostics/*` | New feature folders in the existing `features/` convention. |
| Testing | `tests/**`, `tooling/fixtures/**`, `tooling/benchmarks/**` | Fixtures, E2E, benchmark scripts. |

**Note:** Exact file names inside new modules are proposals to confirm during each phase's required spec/ADR task. Do not make one giant cross-repository change.

---

## 12. Final V1-Plus Acceptance Checklist

### 12.1 Traceability to [project-plan.md](project-plan.md) V1 outcomes

| # | V1 outcome | Roadmap phase(s) | Release evidence required |
| --- | ------------ | ------------------ | --------------------------- |
| 1 | Installable Windows desktop app | 9 | Signed/exe MSI/NSIS tested on clean VM. |
| 2 | Display / window / region recording | 2, 3 | Benchmark matrix, forced-exit recovery, multi-DPI. |
| 3 | Microphone + system audio + webcam | 2 | Separate tracks, WASAPI loopback, webcam asset. |
| 4 | Tray, shortcuts, countdown, pause/resume, markers | 3 | Manual QA across all four entry points. |
| 5 | Crash/forced-exit recovery | 2, 4 | Forced-exit tests, 30/120 min. |
| 6 | Local library | 4 | 10k-record synthetic test, real thumbnails, pagination. |
| 7 | Proxy-based timeline editor | 5, 6 | Load/save/edit 60-minute project. |
| 8 | Trim, split, move, delete, ripple-delete, undo/redo | 5 | Golden project round-trip tests. |
| 9 | Audio and webcam PiP adjustment | 5, 6 | Render output matches timeline. |
| 10 | Basic cursor and canvas effects | 6 | Export validation. |
| 11 | Local MP4 export from original media | 6 | Golden media export, no corrupt partials. |
| 12 | Upload to local / S3 / Drive | 7 | 1 GB resume tests. |
| 13 | Resume interrupted cloud uploads | 7 | Network interruption + app restart. |
| 14 | Offline-first operation | All | No cloud dependency for capture/edit/export. |
| 15 | Reliable 1080p30 on baseline low-end PC | 2, 7, 9 | Benchmark report on named machine. |

### 12.2 V1-plus additions

- [ ] Recording/export templates (Phase 6).
- [ ] Screenshot capture and annotation (Phase 6).
- [ ] First-run onboarding (Phase 6).
- [ ] Truthful diagnostics export (Phase 6, 8).
- [ ] Performance and privacy hardening (Phase 8).

### 12.3 Hard release gates

- [ ] No open P0 or P1 flaws.
- [ ] All 15 V1 outcomes have evidence.
- [ ] Security review, capability audit, and path-policy review are complete.
- [ ] Privacy redaction tests pass.
- [ ] 1080p30 baseline benchmark passes 30- and 120-minute tests.
- [ ] Installer/updater tested on clean Windows 11 VM.
- [ ] Code signing and updater signing are in place or explicitly deferred to a test channel.

---

## 13. Risks, Considerations, and Next Action

### 13.1 Major risks

1. **Windows capture quality is hardware-sensitive.** The hybrid decision must be per capability/path, not an unconditional rewrite or unconditional preservation of FFmpeg.
2. **True independent mic/system tracks may require a new on-disk session/container model.** Resolve this before project/export contracts are frozen.
3. **Google OAuth, code signing, and updater require external credentials/infrastructure.** Implementation agents must not invent credentials or keys.
4. **Cloud and updater dependencies increase supply-chain scope.** Every new dependency requires an ADR, release-age review, license review, and bundle-size check.
5. **Existing prototype has many mocked surfaces.** There is a high risk of "demo-ware" pressure; this roadmap gates every polish phase behind recorder correctness.

### 13.2 Next action

1. Review and approve this roadmap.
2. Open Phase 0: create the benchmark/fixture harness and the missing specs/ADRs.
3. Do not start capture rewrites, timeline, S3, Google Drive, or packaging until Phase 0 and the capture specification are accepted.

---

## Document Control

- **Author:** Generated from [plan.md](plan.md) and [project-plan.md](project-plan.md).
- **Approved stack:** Tauri v2, Rust, React + TypeScript, Vite, Tailwind CSS, Bun, Turborepo, SQLite, FFmpeg/FFprobe.
- **Governance:** Any change to stack, Tauri capabilities, storage providers, or capture architecture requires an ADR and security review per [AGENTS.md](AGENTS.md).
