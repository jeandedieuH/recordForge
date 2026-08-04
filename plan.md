# recordForge End-to-End Improvement Roadmap

Create a repository-root, implementation-ready roadmap that takes the current React/Tauri prototype to a performant, reliable, secure, local-first Windows V1-plus release without changing product code.

## Summary

The requested deliverable is `end-to-end improvement-plan.md` in the repository root. It will be an evidence-based engineering roadmap rather than a rewrite of `project-plan.md`: it will classify what is already real, identify deceptive or incomplete implementations, define the target architecture, sequence all backend/frontend integration work, and attach measurable acceptance and release gates to every phase.

The approved scope is **V1 Plus**, the approved capture direction is **benchmark-gated hybrid**, and both **S3-compatible storage and Google Drive remain V1 release requirements**. AI transcription, smart zoom, silence removal, hosted sharing, accounts, collaboration, and non-Windows production support remain post-V1 unless required only as an architectural extension point.

## Locked Product and Architecture Decisions

- Preserve the local-first promise: capture, recovery, library, projects, editing, and export work completely offline.
- Keep raw frames and PCM out of React, IPC payloads, and Zustand; Rust owns native/media/security-sensitive work.
- Treat local originals as immutable source-of-truth assets; edits are versioned project metadata.
- Use capability and benchmark results—not UI assumptions—to choose recording and export encoders.
- Benchmark the current FFmpeg `ddagrab` path against Windows Graphics Capture/DXGI + WASAPI/Media Foundation candidates. Select the lowest-overhead reliable engine per source/hardware class and keep a tested fallback.
- Use FFmpeg/FFprobe as bundled, pinned Rust-supervised sidecars for media preparation and final rendering even if capture becomes partly native.
- Keep both S3 multipart and Google Drive resumable uploads optional at runtime but release-blocking for the project-plan V1 definition.
- Do not introduce a recordForge-hosted backend, mandatory telemetry, user accounts, or hosted media.

## Evidence-Based Current-State Assessment

### Substantially real, but not yet production-proven

- Tauri startup, app state, tray, three global shortcuts, custom window chrome, SQLite initialization, structured errors/logging, and a narrow command surface.
- Windows display/window enumeration and FFmpeg-based display/region/window-crop capture.
- Basic start/pause/resume/stop, markers, separate webcam sidecar capture, library insertion, and recovery manifests.
- FFprobe metadata, proxy, thumbnail sprite, waveform generation, durable prepare-job rows, progress events, and cancellation scaffolding.
- Zod contracts, a pure TypeScript timeline command engine, render-plan scaffolding, Zustand stores, and a shared UI kit.

### Partially connected or misleading

- The titlebar recording flow starts capture immediately and bypasses the recorder panel countdown (`src/app/app-shell.tsx`, `features/recorder/new-recording-modal.tsx`, `features/recorder/recorder-panel.tsx`).
- The audio meter is random data, the library falls back to fake recordings, recovery is a static banner, diagnostics claim unmeasured readiness, storage usage is fake, and settings expose invalid/mismatched profile descriptions.
- The real timeline components and command engine exist, but `timeline-view.tsx` renders a separate static timeline with hardcoded resolution, timecode, tracks, and webcam PiP. Playback state does not control the video element.
- The polished export screen is disconnected; its presets and encoder controls do not reach the backend. The smaller functional export panel is not mounted.
- Media preparation is manual after recording even though the product flow requires automatic background preparation.
- Projects and storage surfaces are placeholders; the projects table and upload table have no complete domain or command layer.

### Critical correctness, reliability, performance, and security blockers

- Active-segment crash recovery is not dependable: fragments become `validated` only after normal stop, recovery only concatenates validated fragments, and no periodic independently finalized segment rollover exists. A force-quit during the first segment can recover nothing.
- Window capture is a crop of the current desktop rectangle, not true window capture; occlusion, movement, minimizing, mixed-DPI coordinates, and app-window exclusion are not correctly handled.
- Built-in profiles always prioritize `libx264`; detected/recommended hardware encoders are not applied. The `ddagrab` path downloads D3D11 frames to CPU memory before encoding, defeating zero-copy goals.
- Native WASAPI now captures microphone and system-audio loopback into separate WAV assets and muxes separate audio streams; live meters and first-class manifest/library/project asset registration remain incomplete. Webcam files are not represented as first-class assets in the manifest/library/project model.
- Capture scales every source to a fixed profile size without preserving aspect ratio, so non-16:9 windows/regions can be distorted.
- Manifest writes are frequently ignored; state transitions such as countdown/finalizing/failed are not authoritative; normal stop marks the manifest complete before durable library insertion is guaranteed.
- `delete_recovery_session` joins an IPC-provided string into a directory path before recursive deletion without UUID/containment validation. Export destinations and other file paths also need a central path policy.
- Recording deletion removes the database row first, ignores file-deletion failure, has no project dependency checks or trash model, and leaves related jobs/metadata/derivatives without enforced foreign-key cleanup.
- Database migrations are not wrapped as an atomic migration series; a pre-release migration drops recordings; project/upload tables lack complete constraints and indexes; library queries load every row.
- Prepare-job options are not persisted, duplicate jobs are allowed, cancellation can race completion, and heavy jobs are not coordinated with active capture.
- Timeline export creates inconsistent job IDs, does not persist export jobs, cannot cancel them, ignores most of the TypeScript render plan, uses keyframe-limited stream-copy trims, and does not preserve gaps, speed, canvas, separate audio, overlays, captions, or effects.
- TypeScript and Rust `RenderPlan` DTOs have materially drifted. IPC wrappers use compile-time casts but do not validate runtime responses with Zod.
- Project contracts omit an asset registry and export settings. Timeline creation invents a camera track for every screen recording and points it at the screen asset.
- Editor history is unbounded; projects are regenerated with new IDs on every open and are never saved/autosaved.
- `timeline-view.tsx` depends on the entire Zustand store object in its load effect, allowing repeated reloads as store state changes.
- No desktop React tests, command integration tests, media fixtures, capture/recovery tests, E2E harness, or accepted low-end benchmark evidence exists.
- FFmpeg/FFprobe are not bundled through Tauri `externalBin`; installer signing, updater, release automation, diagnostics export, database backup, and clean-machine verification are absent.
- Capabilities should be split by window; the floating controls currently inherit dialogs, opener, global-shortcut, and broad core permissions they do not need. Several loaded frontend plugins/permissions appear unused.
- `#[instrument]` and command debug logging can include window titles, device names, and full media paths; diagnostics export needs an explicit redaction boundary.

## Target Deliverable Structure

The root document will contain all of the following sections.

1. **Executive summary and completion definition** — current maturity, V1-plus scope, explicit non-goals, and the meaning of “almost complete.”
2. **Current-state capability matrix** — requirement-by-requirement classification as working, partial, static/mock, missing, or hardware-unverified.
3. **Prioritized flaw register** — P0 data-loss/security/capture blockers, P1 functional blockers, P2 UX/performance debt, with exact affected modules.
4. **Target architecture and data flows** — process boundaries, IPC/event rules, capture pipeline, session format, durable job system, project/asset model, render pipeline, and storage providers.
5. **Phased implementation roadmap** — ordered work packages, dependencies, affected files/new modules, acceptance criteria, test evidence, and rollback/fallback decisions.
6. **Cross-cutting UX quality bar** — modern desktop behavior, accessibility, keyboard workflow, four async states, toasts/job drawer, truthful capability-driven UI, and reduced-motion behavior.
7. **Performance and benchmark plan** — baseline machine, capture matrix, A/V sync/drop metrics, timeline/library scale tests, render/upload benchmarks, and release thresholds.
8. **Security/privacy plan** — path authorization, command validation, capability split, vault usage, OAuth PKCE, log redaction, diagnostics opt-in, updater signatures, and destructive-operation safeguards.
9. **Testing and CI strategy** — Rust units/integration, contract fixtures, React component tests, WebdriverIO/Tauri WebDriver E2E, synthetic media fixtures, forced-exit tests, clean-VM installer tests, and hardware/manual QA.
10. **Packaging and release plan** — pinned FFmpeg sidecars, licenses/hashes, MSI/NSIS, signing, updater, SBOM/dependency auditing, release channels, migration/backup checks, and rollback.
11. **File/module impact map** — existing files to refactor and proposed directories/files, grouped by phase.
12. **Final V1-plus acceptance checklist** — direct traceability to all 15 project-plan V1 outcomes plus the selected V1-plus additions.

## Roadmap to Encode in the Root Document

### Phase 0 — Freeze Truth and Build the Verification Harness

- Replace the stale unchecked `dev-plan.md` interpretation with an audited status matrix; do not delete either existing plan.
- Write missing feature specs and test plans before high-risk implementation: capture/state machine, recovery/session format, project format, media jobs/render plan, storage contract, security/path policy, and low-end benchmark.
- Establish a reproducible synthetic-media fixture generator and a named baseline Windows 11 machine/hardware matrix.
- Capture baseline results for the current implementation before architectural changes: startup latency, CPU/GPU/memory, actual/dropped FPS, A/V drift, disk throughput, segment recovery, and 30/60/120-minute stability.
- Add a red test or reproducible scenario for every P0 blocker before changing the affected path.
- Gate: current behavior and failures are reproducible; no subsequent phase can claim success without evidence from the harness.

### Phase 1 — Contract, IPC, Persistence, and Security Foundation

- Make shared contracts authoritative and versioned: typed source enums, project/assets/export settings, separate media roles, capture metrics, durable jobs/uploads, and complete render-plan DTOs.
- Add `invokeValidated`/event validation in the frontend and mirrored Rust validation at every command boundary; add cross-language golden fixtures to detect DTO drift in CI.
- Remove duplicate/conflicting output paths and raw frontend-supplied media paths from render plans; use asset IDs and let Rust resolve trusted paths.
- Introduce a central UUID/path authorization policy with canonical containment checks, extension rules, one-time user-selected export destinations where appropriate, symlink/reparse-point defenses, and explicit overwrite confirmation.
- Split main/floating capabilities and remove unused opener/global-shortcut/dialog permissions from windows that do not need them.
- Replace ad-hoc migrations with transactional, tested, forward-only migrations; add uniqueness, foreign keys, indexes, busy timeout, integrity checks, backup-before-migrate, and startup reconciliation.
- Implement trash/restore/empty-trash semantics and project reference checks before physical deletion.
- Add graceful Tauri exit/close handling that prevents unsafe shutdown while capture/finalization is active and leaves a recoverable manifest if forced.
- Gate: malformed IPC/path traversal/destructive operations are rejected; contracts round-trip across Rust/TS; migration and backup tests pass from every supported schema version.

### Phase 2 — Benchmark-Gated Hybrid Capture and Recovery Core

- Refactor capture around explicit traits/supervisors for source discovery, video capture, audio capture, encoder selection, session writing, and metrics.
- Benchmark optimized FFmpeg D3D11 capture against Windows Graphics Capture/DXGI + Media Foundation for display/window/region cases. Use true Windows window capture where desktop cropping fails semantics; retain tested fallbacks.
- Add native WASAPI loopback for system audio and microphone capture with a shared monotonic timeline; preserve microphone and system audio as separate editable tracks/streams.
- Represent webcam as a first-class separately timestamped asset and validate camera capabilities before start.
- Apply actual encoder detection/preflight recommendations to profiles; support zero-copy/hardware paths where filter graphs permit and conservative x264 fallback otherwise.
- Preserve aspect ratio, virtual-desktop/mixed-DPI coordinates, color space, cursor visibility choices, app-window exclusion, and display/window lifecycle changes.
- Replace pause-created pseudo-segments with periodic independently finalized recoverable segments (format chosen by forced-power-loss tests), durable manifests, explicit finalizing/failed/recovery states, and FFprobe integrity checks.
- Capture local per-session metrics including requested/actual FPS, dropped/duplicated frames, encoder, CPU/GPU/memory, disk bytes, audio underruns, and A/V drift.
- Gate: 30-minute 1080p30 and 120-minute fallback recordings pass on the baseline machine; true window/region/multi-monitor capture works; A/V drift and crash-loss budgets are met; forced exit preserves every finalized segment.

### Phase 3 — Recorder, Preflight, Tray, and Floating-Control Integration

- Consolidate the duplicate modal/panel source configuration into one authoritative recording setup flow.
- Make countdown a cancellable Rust-owned state transition so titlebar, tray, global shortcut, and UI starts behave identically.
- Persist validated quick-start defaults and make the first shortcut open setup rather than fail silently.
- Add source previews, truthful device/capability states, real microphone/system meters from compact events, disk-space/runtime estimates, risky-profile warnings, and permission/device recovery actions.
- Automatically open/update/reposition the floating controls; include timer, both audio levels, marker, pause/resume, stop, and error state.
- Make tray labels/icons and shortcut availability reflect live state; add conflict detection and persisted shortcut customization for the project-plan shortcut set.
- Move blocking detection/benchmark/finalization operations off event/UI threads; add idempotency and rapid-action guards.
- Gate: every start entry point follows setup → countdown → recording → finalizing → saved; no fake data remains; device loss, hotkey conflicts, low disk, and stop/finalization failures are actionable.

### Phase 4 — Durable Job Platform, Recovery UI, and Local Library

- Replace prepare/export/upload-specific thread logic with one durable job scheduler that persists kind, serialized options, priority, stage, attempts, cancellation, outputs, and restart policy.
- Limit resource-heavy concurrency for low-end systems, pause/throttle derivatives/exports during recording, deduplicate equivalent jobs, and clean partial outputs atomically.
- Auto-enqueue probe/proxy/thumbnail/waveform after successful or recovered recordings; version derivative recipes and invalidate/rebuild stale artifacts.
- Mount one root event subscription and jobs drawer; show progress/ETA where reliable, cancel/retry, history, and mandatory completion/failure toasts.
- Connect the real recovery scanner to a four-state recovery surface with preview/metadata, Recover, Export recovered file, Delete, progress, and no silent deletion.
- Remove library mocks and logging of full records/paths. Add paginated indexed search/sort/status/tag/collection queries, real thumbnails, disk usage, rename/duplicate/reveal/open/trash/restore, export/upload history, and virtualization.
- Reconcile manifests, files, DB rows, derivatives, and jobs at startup so partial commits cannot orphan valid media.
- Gate: a 60-minute recording becomes editable automatically without freezing; jobs restart safely; recovery is proven by forced exits; a 10k-record synthetic library remains responsive.

### Phase 5 — Versioned Projects and the Real Proxy Editor

- Complete the project schema with asset registry, source roles, project version, tracks/clips/effects/captions/markers, canvas, export settings, checksums, and migration metadata.
- Implement Rust project CRUD, atomic `project.json` writes, SQLite indexing, import/duplicate/rename/delete, autosave, backup snapshots, migration, and missing-media relink.
- Load saved projects rather than rebuilding random timelines on every open; track dirty/saving/saved/error states and cap/coalesce command history.
- Mount and consolidate the existing modular timeline components; remove the static duplicate timeline.
- Synchronize proxy video/audio playback with the store and `requestAnimationFrame`; connect seek/timeupdate/play/pause, thumbnails, cached waveform peaks, markers, and camera preview.
- Implement/finish trim handles, split, move, delete, range/ripple delete, speed, clip/track gain, fades, mute/solo/lock, camera crop/position/shape, captions import/manual editing, canvas changes, marker editing, and undo/redo.
- Virtualize time-window content and large tracks; use dnd-kit with keyboard alternatives and keep transient drag state out of persisted project data.
- Add desktop shortcuts, selection/focus semantics, screen-reader labels, reduced motion, and four states for project/media loading.
- Gate: close/reopen preserves edits; undo/redo is deterministic; a 60-minute project remains within interaction/frame budgets; proxy playback matches edited time mapping.

### Phase 6 — Accurate Durable Export and V1-Plus Studio Features

- Replace the partial stream-copy exporter with a validated render DAG/filter plan that Rust resolves from trusted project assets.
- Render source trims, ordering/gaps, speed changes, separate mic/system audio gain/fades/mix, webcam PiP/crop/shape/border, canvas background/padding/radius/shadow, markers/chapters, imported/manual captions, and cursor/click effects.
- Capture cursor position/click metadata during recording and apply highlight/ring/size styling at preview/export time rather than in the real-time capture path.
- Make export presets capability-driven and truthful; default to broadly compatible H.264/AAC MP4, with high-quality/60fps/GIF/vertical options only when valid.
- Estimate size/disk use, persist export settings/history, support cancel/retry/restart-from-clean-state, write to `.partial`, FFprobe-validate A/V duration/streams, then atomically publish the final file.
- Consolidate the two export UIs into one connected flow with destination picker, preset details, advanced settings, progress, cancellation, completion toast, reveal, and upload action.
- Add V1-plus templates, screenshot capture/annotation, first-run onboarding, and truthful diagnostics export; defer AI transcription/smart zoom/noise cleanup.
- Gate: golden-media exports match timeline state frame/audio tolerances; cancellation leaves no published corrupt file; low-end export never blocks recording controls or the UI.

### Phase 7 — Local, S3-Compatible, and Google Drive Destinations

- Define provider-neutral contracts in `packages/storage-core` and Rust traits/adapters; keep all networking and credentials in Rust.
- Implement local-folder copy with checksum/atomic destination handling.
- Implement storage profiles that persist only non-secret metadata and Windows Credential Manager references.
- Add S3 endpoint diagnostics and multipart upload with persisted upload ID/part ETags, bounded parallelism, exponential backoff/jitter, pause/resume/retry/cancel, abort cleanup, checksum verification, and app-restart recovery.
- Add Google OAuth 2.0 Authorization Code + PKCE in the system browser with state/nonce validation, loopback/custom callback review, refresh-token vault storage, token refresh/revocation, folder selection, and resumable chunked uploads. Treat resumable session URIs as secrets/vault data.
- Integrate uploads into the durable scheduler and storage UI without ever removing or invalidating the local export on remote failure.
- Gate: 1 GB S3 and Drive uploads survive network interruption and app restart; invalid credentials/permissions/quota/rate limits are actionable; logs/SQLite/project files contain no credentials or bearer URLs.

### Phase 8 — UX, Accessibility, Privacy, Diagnostics, and Performance Hardening

- Remove account/profile affordances that conflict with V1 non-goals and ensure every visible control is connected or explicitly disabled with a reason.
- Apply the shared UI kit and tokens consistently; remove raw component colors/emoji icons, hover-only actions, inaccessible custom dialogs, missing labels, false status claims, and uncancellable waits.
- Enforce skeleton → content | empty | error+retry for every async surface, plus disabled/pending/cancel states for mutations.
- Add keyboard navigation, focus management, accessible timeline alternatives, live progress announcements, contrast/reduced-motion audits, and no hover-only functionality.
- Add redacted structured logs with rotation/retention, local crash/session markers, user-inspectable diagnostics bundles, no telemetry by default, and explicit opt-in for any remote crash submission.
- Profile startup, React rerenders, IPC frequency/payloads, SQLite queries, job scheduling, timeline frame budgets, asset loading, and capture/render coexistence; fix measured regressions rather than speculative micro-optimizations.
- Gate: static accessibility review plus keyboard/manual tests pass; privacy redaction tests pass; idle/capture/editor performance budgets are measured on baseline hardware.

### Phase 9 — Packaging, CI, Installer, Updater, and Release Qualification

- Pin and bundle FFmpeg/FFprobe using Tauri external binaries with target-triple naming, checksums, licenses/attribution, reproducible acquisition/build script, and startup version verification.
- Expand tests: Rust state/recovery/DB/job/export/storage integration tests, contract golden fixtures, editor property/command tests, React Testing Library, WebdriverIO + Tauri WebDriver on Windows, synthetic media validation, and hardware/manual matrix.
- Add dependency/license/security audits, secret scanning, artifact retention, SBOM, signed release provenance, and benchmark result comparison to CI/release workflows.
- Configure MSI/NSIS metadata, file associations if approved, code signing, signed updater manifests/public key, stable/beta channels, rollback policy, and migration compatibility.
- Verify install/update/uninstall, tray/startup behavior, sidecars, vault, recovery, clean user profile, restricted user, offline operation, and Windows Defender/SmartScreen behavior on clean Windows 11 VMs.
- Gate: every final acceptance item has automated or recorded manual evidence; security review is complete; installer/updater/recovery/storage/hardware matrices pass; no P0/P1 defects remain.

## Planned File and Module Impact to Name Explicitly

### Existing areas to refactor

- `apps/desktop/src/app/*` — lifecycle-aware navigation, root event/job providers, remove placeholders/non-goal account UI.
- `apps/desktop/src/features/recorder/*` and `src/stores/recorder-store.ts` — authoritative setup/countdown/preflight/meters/transport.
- `apps/desktop/src/features/library/*`, `src/stores/jobs-store.ts`, and `src/lib/{library,media}.ts` — real data, recovery, pagination, durable jobs, four states.
- `apps/desktop/src/features/editor/**`, `src/stores/{editor,timeline}-store.ts`, and `src/lib/timeline.ts` — saved projects, real playback/timeline, persistence/export.
- `apps/desktop/src/features/export/*` and `features/settings/*` — connected capability-driven export/settings/storage/diagnostics.
- `packages/contracts/src/{recording,media,project,timeline,errors}.ts` — versioned complete DTOs and schemas.
- `packages/domain/src/*`, `packages/editor-core/src/*`, `packages/media-core/src/*`, `packages/storage-core/src/*` — complete project/editor/render/storage models and tests.
- `apps/desktop/src-tauri/src/{lib,state,events,errors,shortcuts,tray}.rs` — lifecycle, event envelopes, redaction, shortcuts/tray.
- `src-tauri/src/capture/**` — hybrid engines, separate A/V assets, segmentation, metrics, recovery.
- `src-tauri/src/{database,jobs,media,exports}/**` — migrations, durable scheduler, derivatives, accurate render/export.
- `src-tauri/capabilities/*.json`, `src-tauri/tauri.conf.json`, `Cargo.toml`, desktop/root package scripts, and CI workflows — least privilege, sidecars, tests, packaging, updater.

### New implementation areas the root plan will propose

- Rust modules for `capture/windows`, `capture/audio`, `capture/metrics`, `projects`, `storage`, `credentials`, `diagnostics`, and centralized `path_policy`/validation.
- Frontend features/stores for projects, recovery, storage profiles/uploads, root jobs drawer, onboarding, and screenshot annotation.
- Missing specs, test plans, benchmark records, media fixture tooling, desktop component/E2E tests, and release workflow files.

The root plan will state that exact file names inside new modules are proposals to confirm during each phase's required spec/ADR task, not permission to make one giant cross-repository change.

## Files to Modify for This Request

- `end-to-end improvement-plan.md` — create in the repository root after plan approval.

No application source, tests, configuration, existing plan, ADR, or dependency file will be modified as part of this request.

## Verification of the Roadmap Document

- [ ] Every `project-plan.md` V1 capability and explicit non-goal is traceable to a roadmap phase and final acceptance check.
- [ ] Selected V1-plus additions are clearly separated from deferred AI/hosted/advanced work.
- [ ] Every critical flaw found in the current backend/frontend is either assigned to a phase or explicitly justified as deferred.
- [ ] Every phase includes dependencies, affected modules, concrete deliverables, measurable acceptance criteria, automated tests, and hardware/manual evidence where static testing is insufficient.
- [ ] The recorder-first critical path blocks editor/cloud polish until capture, sync, recovery, and low-end benchmarks pass.
- [ ] The plan distinguishes implemented, partial, mocked/static, missing, and hardware-unverified behavior so it does not duplicate work or claim false completeness.
- [ ] The document includes a file impact map, risk register, test matrix, security/privacy gates, performance budgets, release gates, and a definition of “almost complete.”
- [ ] No code implementation is performed.

## Risks and Considerations

- Static review cannot prove Windows capture quality, A/V sync, hardware encoder stability, or power-loss recovery; the roadmap therefore makes benchmark/hardware gates blocking.
- The current FFmpeg capture prototype may pass some hardware classes and fail others. The hybrid decision must be per capability/path, not an unconditional rewrite or unconditional preservation.
- True independent mic/system tracks and frame-accurate editing may require changing the on-disk session/container model; this must be resolved before project/export contracts are frozen.
- Google OAuth requires a user-owned Google Cloud app registration and release configuration. Windows code signing and updater publication likewise require external credentials/infrastructure that implementation agents must not invent.
- Cloud and updater dependencies increase supply-chain and security scope; dependency choice requires an ADR, release-age review, license review, and bundle-size check.
- Existing uncommitted work could not be inspected because shell access was denied; the final document will be based on the readable workspace state and will not alter source files.