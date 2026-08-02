<!-- markdownlint-disable-file MD024 -->

# recordForge — Comprehensive Development Plan

> **Purpose:** Turn the recordForge product plan into an executable, phase-by-phase engineering roadmap.  
> **Audience:** Developers, coding agents, reviewers, and future maintainers.  
> **Status:** Draft — aligned with `project-plan.md`.  

---

## 1. Project Overview

recordForge is a **local-first, low-end-friendly desktop screen recorder** with a lightweight editor. It is built for Windows 11 first, using Tauri v2 (Rust) for native operations and React + TypeScript for the UI.

### Core Promise

Press one shortcut, record reliably, make essential edits quickly, export locally, and retain ownership of every recording.

### Why This Plan Exists

This document translates the high-level product vision into concrete engineering tasks. It is meant to guide day-to-day development, sprint planning, and agent-driven implementation. It should be updated as the project evolves.

---

## 2. Engineering Goals

### Primary Goals

1. Build a stable screen recorder that works on low-end Windows 11 hardware.
2. Keep all recording, editing, and exporting operations local-first.
3. Use Rust for native/media code and React only for UI.
4. Deliver a working V1 before adding cloud, sharing, or advanced editing features.
5. Make the codebase safe for coding agents to contribute to in small, bounded tasks.

### Success Metrics

| Metric | Target |
|---|---|
| Recording start after shortcut | < 2 seconds |
| Default recording | 1080p at 30 fps |
| Low-end fallback | 720p at 30 fps |
| Idle app memory | < 200 MB (excluding webview overhead) |
| Timeline responsiveness | Smooth with 60-minute recordings |
| Crash recovery | Preserves finalized segments |
| Export | Background, cancellable, non-blocking |
| Uploads | Resumable after interruption or restart |

---

## 3. Approved Technology Stack

| Area | Choice | Notes |
|---|---|---|
| Desktop shell | Tauri v2 | Windowing, IPC, tray, shortcuts, packaging, updater |
| Native code | Rust | Capture, audio, media jobs, filesystem, security |
| Frontend | React + TypeScript | UI only; no media frames through state |
| Bundler | Vite | Fast dev builds |
| Styling | Tailwind CSS | Consistent design system |
| Package manager | Bun | Dependency and workspace management |
| Monorepo | Turborepo + Bun workspaces | Shared packages, cached CI |
| Local DB | SQLite | Metadata, projects, queues, settings |
| ORM / DB layer | Drizzle ORM (TS) or direct Rust SQLite | Migrations and structured persistence |
| Media processing | FFmpeg + FFprobe | Proxies, thumbnails, waveforms, export |
| State management | Zustand | UI and editor interaction state |
| Validation | Zod | Shared schemas for commands and forms |
| Audio waveform | Wavesurfer.js | Waveform display and regions |
| Virtualization | TanStack Virtual | Long timelines and large libraries |
| Drag & drop | dnd-kit | Timeline clip interactions |
| Storage | Local / S3-compatible / Google Drive | Optional user-owned destinations |

---

## 4. Repository Layout

```text
recordForge/
├── AGENTS.md                    # Agent operating rules
├── README.md
├── dev-plan.md                  # This file
├── package.json
├── turbo.json
├── bun.lock
│
├── apps/
│   └── desktop/                 # Tauri desktop app
│       ├── src/                 # React + TypeScript UI
│       │   ├── app/
│       │   ├── components/
│       │   ├── features/        # recorder, library, editor, export, storage, settings
│       │   ├── hooks/
│       │   ├── lib/
│       │   ├── stores/
│       │   └── styles/
│       └── src-tauri/           # Rust backend
│           ├── capabilities/
│           ├── binaries/        # FFmpeg per platform
│           ├── src/
│           │   ├── commands/
│           │   ├── capture/
│           │   ├── diagnostics/
│           │   ├── events/
│           │   ├── exports/
│           │   ├── media/
│           │   ├── projects/
│           │   ├── storage/
│           │   ├── database/
│           │   ├── state.rs
│           │   ├── errors.rs
│           │   └── lib.rs
│           ├── Cargo.toml
│           └── tauri.conf.json
│
├── packages/
│   ├── contracts/               # Shared Zod / DTO schemas
│   ├── domain/                  # Project and timeline models
│   ├── editor-core/             # Pure timeline command engine
│   ├── media-core/              # FFmpeg job specifications
│   ├── storage-core/            # Provider-neutral storage contracts
│   ├── ui/                      # Shared components and design tokens
│   └── config/                  # TS, lint, Tailwind, tooling config
│
├── docs/
│   ├── adr/                     # Architecture decision records
│   ├── architecture/
│   ├── specs/                   # Feature specifications
│   ├── test-plans/
│   ├── benchmarks/
│   └── agent-tasks/             # Per-milestone agent task bundles
│
├── tooling/
│   ├── ffmpeg/                  # FFmpeg packaging helpers
│   ├── fixtures/                # Test media
│   └── scripts/                 # Build and CI scripts
│
└── .github/workflows/           # CI/CD
```

---

## 5. Development Phases

Each phase has a clear goal, deliverables, exit criteria, and a list of concrete engineering tasks. Phases are sequential; the next phase starts only when the previous phase is accepted.

### Phase 0 — Foundation

**Goal:** Create a working, testable monorepo and the basic app shell.  
**Estimated Duration:** 1–2 weeks  
**Priority:** Critical — everything depends on this.

#### Deliverables

- [ ] Turborepo + Bun workspace with `apps/desktop` and `packages/*`
- [ ] Tauri v2 app with Vite, React, TypeScript, and Tailwind CSS
- [ ] Root and nested `AGENTS.md` files
- [ ] Rust and TypeScript lint/format/test scripts
- [ ] CI pipeline for lint, typecheck, format, and unit tests
- [ ] Shared `contracts` package with Zod schemas
- [ ] Rust logging (`tracing`) and shared error model
- [ ] Initial Tauri capability configuration (narrow permissions)
- [ ] SQLite schema and migration setup
- [ ] First ADRs committed
- [ ] Basic tray, menu, and window shell

#### Engineering Tasks

| # | Task | Notes |
|---|---|---|
| 0.1 | Initialize Turborepo + Bun workspace | Configure root scripts and `turbo.json` |
| 0.2 | Scaffold Tauri v2 desktop app | Use official Tauri + Vite + React template |
| 0.3 | Configure Tailwind CSS | Add design tokens for desktop density |
| 0.4 | Configure TypeScript | Strict mode, path aliases, workspace references |
| 0.5 | Configure Rust tooling | `rustfmt`, `clippy`, workspace Cargo |
| 0.6 | Write root `AGENTS.md` | Product summary, stack, commands, security rules |
| 0.7 | Write nested `AGENTS.md` | `apps/desktop` and `src-tauri` specifics |
| 0.8 | Set up GitHub Actions CI | Lint, typecheck, format, unit tests |
| 0.9 | Create `packages/contracts` | Shared Zod schemas for commands and DTOs |
| 0.10 | Set up SQLite schema | Migrations for projects, recordings, jobs, uploads |
| 0.11 | Add `tracing` logging in Rust | Structured, redaction-ready logs |
| 0.12 | Define error model | `recordForgeError` union, user-facing messages |
| 0.13 | Add Tauri capability file | Minimum required scope; ADR for expansion |
| 0.14 | Build app shell | Window, tray icon, basic menu, splash / loading state |

#### Exit Criteria

- Fresh clone builds and runs with one command.
- One documented command runs development mode.
- One documented command runs all checks.
- CI passes lint, typecheck, format, and tests.
- `AGENTS.md` is committed and reviewed.

---

### Phase 1 — Native Capture Spike

**Goal:** Prove that reliable Windows 11 screen capture is possible on low-end hardware.  
**Estimated Duration:** 2 weeks  
**Priority:** Critical — do not proceed to UI or editor until this is accepted.

#### Deliverables

- [ ] Display and window enumeration
- [ ] Full-display capture prototype
- [ ] Recording configuration model
- [ ] H.264 encoder tests (hardware and CPU fallback)
- [ ] Hardware encoder detection
- [ ] Segment manifest format
- [ ] Force-quit recovery prototype
- [ ] Minimal React recording-status view
- [ ] Benchmark command and report template

#### Engineering Tasks

| # | Task | Notes |
|---|---|---|
| 1.1 | Research Windows Graphics Capture API | Choose between WGC, DXGI, or Media Foundation |
| 1.2 | Enumerate displays and windows | Rust module in `src-tauri/capture` |
| 1.3 | Build full-display capture | Capture to H.264 fragments |
| 1.4 | Capture WASAPI microphone audio | Synchronize with video timestamps |
| 1.5 | Capture WASAPI system audio | Loopback capture |
| 1.6 | Write segment manifest | `session.json` + per-fragment metadata |
| 1.7 | Implement recovery scanner | On startup, detect and validate incomplete sessions |
| 1.8 | Test force-quit recovery | Simulate crash, verify segments survive |
| 1.9 | Detect hardware encoders | NVENC, QSV, AMF, WMF |
| 1.10 | Benchmark encoder options | CPU, memory, FPS, drops, A/V drift |
| 1.11 | Add minimal status UI | Show recording state, timer, errors |
| 1.12 | Add benchmark report CLI | JSON output for comparison |

#### Exit Criteria

- 30-minute 1080p30 recording completes on the baseline low-end device.
- Output video is playable with A/V drift within tolerance.
- Recording survives normal stop and forced-quit recovery.
- CPU, memory, disk write, FPS/drop, and sync metrics are captured.

---

### Phase 2 — Recorder MVP

**Goal:** Build the full recording workflow: selection, audio, webcam, shortcuts, tray, recovery, and basic export.  
**Estimated Duration:** 4–6 weeks  
**Priority:** Critical.

#### Deliverables

- [ ] Full display, window, and region selection UI
- [ ] Microphone and system audio capture
- [ ] Optional webcam overlay
- [ ] Global shortcuts
- [ ] Tray application behavior
- [ ] Floating recording controls
- [ ] Countdown before recording
- [ ] Marker insertion
- [ ] Pause / resume
- [ ] Library index
- [ ] Local recording metadata
- [ ] Recovery UI
- [ ] Basic trim
- [ ] Local MP4 export
- [ ] Device and encoder diagnostics

#### Engineering Tasks

| # | Task | Notes |
|---|---|---|
| 2.1 | Source selection overlay | Display / window / region picker |
| 2.2 | Recording config form | Audio, webcam, profile selection |
| 2.3 | Global shortcut registration | Rust-owned, works when app is hidden |
| 2.4 | Tray icon and menu | Status, start/stop, show/hide, quit |
| 2.5 | Floating toolbar | Timer, audio level, pause, stop, marker |
| 2.6 | Countdown overlay | Configurable 3-2-1 |
| 2.7 | Marker insertion | Write marker metadata during recording |
| 2.8 | Pause/resume logic | Keep segments consistent across pause |
| 2.9 | Library database model | Recordings, status, duration, size |
| 2.10 | Library grid/list view | Search, sort, tags, delete, reveal |
| 2.11 | Recovery UI | Detect, preview, export, delete recovered sessions |
| 2.12 | Basic trim function | Trim start/end of a recording |
| 2.13 | Simple MP4 export | Single profile, direct from original |
| 2.14 | Device / encoder diagnostics | Show user what is available and recommended |

#### Exit Criteria

- A user can record, pause, stop, recover, trim, and export offline.
- Default profile works on the baseline low-end device.
- Capture errors are clear and actionable.
- The app is usable for daily tutorials or bug reports.

---

### Phase 3 — Media Preparation

**Goal:** Make long recordings open and play smoothly in the editor.  
**Estimated Duration:** 3–4 weeks  
**Priority:** Critical for editor usability.

#### Deliverables

- [ ] FFprobe metadata extraction
- [ ] Proxy generation (lower-resolution MP4)
- [ ] Thumbnail generation
- [ ] Waveform peak extraction
- [ ] Background job framework
- [ ] Job progress and cancellation
- [ ] SQLite queue persistence
- [ ] Disk-space estimates
- [ ] Media derivative cleanup policy

#### Engineering Tasks

| # | Task | Notes |
|---|---|---|
| 3.1 | FFprobe metadata parser | Duration, fps, dimensions, audio streams, codec |
| 3.2 | Proxy generation job | 540p or 720p MP4 for editing |
| 3.3 | Thumbnail extraction | Filmstrip or indexed frames |
| 3.4 | Waveform peak extraction | Compact audio peak data, cached |
| 3.5 | Background job framework | Rust job queue, progress events |
| 3.6 | Job progress UI | Progress bars, stage names, cancel button |
| 3.7 | Persist job state in SQLite | Resume after restart |
| 3.8 | Disk-space estimator | Pre-flight and ongoing estimates |
| 3.9 | Derivative cleanup policy | Recreate-able files, user approval |
| 3.10 | Job cancellation | Clean up partial files safely |

#### Exit Criteria

- A 60-minute recording opens without freezing.
- Editor playback uses proxy media.
- Derivative files can be recreated from originals.
- Jobs resume safely after app restart.

---

### Phase 4 — Timeline Editor MVP

**Goal:** Build a practical, proxy-based non-destructive editor.  
**Estimated Duration:** 5–7 weeks  
**Priority:** Critical for V1.

#### Deliverables

- [ ] Timeline domain model
- [ ] Timeline command engine with undo/redo
- [ ] Virtualized timeline UI
- [ ] Playhead, seek, and zoom controls
- [ ] Trim, split, move, delete, ripple delete
- [ ] Microphone / system audio controls
- [ ] Webcam PiP placement, crop, resize
- [ ] Marker / chapter track
- [ ] Basic captions track
- [ ] Export render-plan generator
- [ ] Final original-quality export

#### Engineering Tasks

| # | Task | Notes |
|---|---|---|
| 4.1 | Timeline domain model | Tracks, clips, markers, canvas settings |
| 4.2 | Command engine in `packages/editor-core` | Pure TypeScript, unit tested |
| 4.3 | Undo/redo stack | Reversible commands |
| 4.4 | Virtualized timeline canvas | TanStack Virtual for clips and rulers |
| 4.5 | Playhead and seek | `requestAnimationFrame` driven |
| 4.6 | Zoom and time ruler | Pannable, scalable |
| 4.7 | Trim / split / move / delete | Core editing commands |
| 4.8 | Ripple delete | Shift adjacent clips |
| 4.9 | Track controls | Mute, solo, lock, volume, gain, fade |
| 4.10 | Webcam PiP transform | Position, size, crop, shape |
| 4.11 | Markers and chapters | Add, edit, remove, navigate |
| 4.12 | Captions track | Import or manually add captions |
| 4.13 | Export render plan | Convert timeline to FFmpeg command plan |
| 4.14 | Final export job | Use original media, background, cancellable |

#### Exit Criteria

- A user can edit a 60-minute recording without severe UI lag.
- Timeline operations are covered by unit tests.
- Final export accurately matches the timeline.
- Export runs without blocking the rest of the app.

---

### Phase 5 — Studio Polish

**Goal:** Add visual polish, templates, shortcuts, and distribution readiness.  
**Estimated Duration:** 3–4 weeks  
**Priority:** Important for differentiation.

#### Deliverables

- [ ] Cursor size and highlight effect
- [ ] Click-ring effect
- [ ] Canvas background options
- [ ] Padding, border radius, shadow
- [ ] Webcam border and shape options
- [ ] Export presets UI
- [ ] Screenshot capture and annotation
- [ ] Recording templates (tutorial, demo, bug report, lesson)
- [ ] Keyboard editing shortcuts
- [ ] First-run onboarding
- [ ] Installer, updater, and diagnostics UX

#### Engineering Tasks

| # | Task | Notes |
|---|---|---|
| 5.1 | Cursor effects pipeline | Cursor highlight, click ring, size |
| 5.2 | Canvas background options | Color, gradient, image, blur |
| 5.3 | Padding / border radius / shadow | Post-export compositing |
| 5.4 | Webcam styling | Border, rounded, shape masks |
| 5.5 | Export presets | Fast share, balanced, smooth, high quality, archive, GIF, vertical |
| 5.6 | Screenshot capture | Global shortcut + annotation |
| 5.7 | Recording templates | Preconfigure settings per use case |
| 5.8 | Keyboard shortcut map | Editing shortcuts, customizable later |
| 5.9 | Onboarding flow | Permissions, preflight, first recording |
| 5.10 | Installer and updater | MSI/NSIS, Tauri updater, signing prep |
| 5.11 | Diagnostics export | Opt-in, redacted, user-inspected |

#### Exit Criteria

- recordForge produces professional-looking tutorial and demo exports.
- Common workflows require minimal configuration.
- Users can resolve common device, storage, and disk issues.

---

### Phase 6 — Storage Destinations

**Goal:** Add optional upload to user-owned destinations without blocking local use.  
**Estimated Duration:** 2–4 weeks  
**Priority:** Important, but only after V1 local workflow is stable.

#### Deliverables

- [ ] Local-folder destination adapter
- [ ] S3-compatible storage profiles
- [ ] S3 multipart upload
- [ ] Upload queue with pause / resume / retry / cancel
- [ ] OS credential-vault integration
- [ ] Google OAuth browser flow
- [ ] Google Drive folder selection
- [ ] Google Drive resumable upload
- [ ] Upload status UI
- [ ] Connection diagnostics

#### Engineering Tasks

| # | Task | Notes |
|---|---|---|
| 6.1 | Storage provider trait | Rust trait in `src-tauri/storage` |
| 6.2 | Local folder adapter | Copy and validate output |
| 6.3 | S3 profile model | Endpoint, region, bucket, path-style, secret refs |
| 6.4 | OS credential vault integration | Windows Credential Manager |
| 6.5 | S3 multipart upload | Resume, retry, cancel, parts tracked |
| 6.6 | Google OAuth PKCE flow | Open system browser, handle redirect |
| 6.7 | Store Google refresh token | In OS credential vault |
| 6.8 | Google Drive resumable upload | Session URI, chunked PUT |
| 6.9 | Upload queue persistence | SQLite + background task |
| 6.10 | Upload status UI | Progress, pause, resume, retry, cancel |
| 6.11 | Connection diagnostics | Test credentials and reachability |

#### Exit Criteria

- A user uploads a 1 GB MP4 to S3-compatible storage.
- Upload can be interrupted and resumed.
- Upload resumes after app restart.
- A user uploads to Google Drive with resumable behavior.
- Local export remains available regardless of upload result.

---

## 6. Definition of Done for V1

recordForge V1 is complete when a user can:

1. Install the Windows desktop application.
2. Record a display, application window, or selected region.
3. Capture microphone, system audio, and optional webcam.
4. Use tray controls, global shortcuts, countdown, pause/resume, and markers.
5. Recover completed portions of a recording after a crash or forced exit.
6. Browse recordings through a local library.
7. Open a proxy-based timeline editor.
8. Trim, split, move, delete, ripple-delete, and undo/redo edits.
9. Adjust audio and webcam PiP.
10. Apply basic cursor and canvas effects.
11. Export a final local MP4 from original-quality media.
12. Upload a completed export to a local folder, S3-compatible storage, or Google Drive.
13. Resume interrupted cloud uploads.
14. Work completely offline except for explicitly requested cloud uploads.
15. Complete the default 1080p30 workflow reliably on the agreed baseline low-end PC.

---

## 7. Development Workflow

### 7.1 Mandatory Workflow for All Contributors

1. Read the nearest `AGENTS.md`.
2. Read the relevant spec and ADR.
3. Produce a task plan for non-trivial work.
4. Get human approval for the plan.
5. Change only the agreed file scope.
6. Run required tests and checks.
7. Report changed files, validation evidence, limitations, and follow-up work.
8. Human reviews the diff before merge.

### 7.2 Branch Strategy

- `main` is the release branch. It is always green on CI.
- Use feature branches: `feature/phase-X-short-description`.
- Avoid long-lived branches.
- Require human review for changes to `capture`, `media`, `contracts`, or `editor-core`.

### 7.3 Coding Standards

- TypeScript: strict mode, interfaces preferred over types, no enums, functional components, named exports.
- Rust: `cargo fmt` and `clippy` must pass.
- React: minimize `use client`, `useEffect`, and `setState`; prefer server components where applicable; wrap client components in `Suspense`.
- Tailwind: use design tokens, mobile-first, responsive.
- Error handling: guard clauses, early returns, user-friendly messages.
- Comments: add comments on non-obvious implementation decisions; do not over-comment.

### 7.4 Pull Request Checklist

- [ ] Code compiles and builds.
- [ ] Lint and format checks pass.
- [ ] TypeScript and Rust type checks pass.
- [ ] Unit tests added or updated.
- [ ] No `console.log`, `.only`, `debugger`, or leftover `TODO`.
- [ ] No secrets or credentials in code.
- [ ] Tauri capabilities reviewed if changed.
- [ ] Security and destructive operations reviewed.

---

## 8. Testing Strategy

### 8.1 Test Layers

| Layer | Tooling | Coverage |
|---|---|---|
| Rust units | `cargo test` | State machine, media jobs, storage, recovery |
| Rust quality | `cargo fmt`, `cargo clippy` | Formatting and lint |
| TypeScript units | Vitest | Timeline commands, Zod schemas, state logic |
| React components | React Testing Library | UI behavior and forms |
| Desktop E2E | WebDriver / Playwright | App launch and workflows |
| Media fixtures | FFmpeg / FFprobe | Rendering, metadata, proxy validation |
| Hardware benchmarks | Reference devices | CPU, memory, drops, sync, disk I/O |
| Manual QA | Hardware matrix | Device and native edge cases |

### 8.2 Critical Test Scenarios

#### Capture

- Start/stop, pause/resume.
- Microphone-only, system-audio-only, both.
- Webcam plus screen.
- Single and multi-monitor selection.
- Window and region capture.
- Device unplug during recording.
- Sleep/lock behavior.
- Low disk-space warning.
- Encoder fallback.
- Force quit during recording.
- Long recordings: 30 min, 60 min, 120 min.

#### Recovery

- Forced app termination.
- Process crash.
- Power-loss simulation.
- Interrupted finalization.
- Corrupted or missing segments.
- Recoverable vs unrecoverable behavior.

#### Timeline

- Trim, split, move, ripple delete.
- Undo/redo.
- Webcam PiP transform.
- Audio gain and fades.
- Long timeline virtualization.
- Proxy playback.
- Export matching timeline state.

#### Storage

- Invalid S3 endpoint and credentials.
- Wrong bucket permissions.
- Multipart upload and interruption.
- App restart during upload.
- Google OAuth cancellation and token expiration.
- Resumable upload interruption.
- Upload cancellation.
- Local export retained after remote failure.

---

## 9. Performance Requirements

### 9.1 Baseline Target Machine

- Windows 11
- Intel integrated graphics
- 8 GB RAM
- Entry-level or older quad-core CPU
- SSD with limited free capacity
- 1080p display
- Built-in microphone and webcam

### 9.2 Performance Targets

| Metric | Target |
|---|---:|
| Idle memory | < 200 MB |
| Recorder UI CPU | < 5% without webcam |
| Default recording | 1080p at 30 fps |
| Low-end fallback | 720p at 30 fps |
| Recording start after shortcut | < 2 seconds |
| Proxy playback | 30 fps |
| 60-minute timeline | Responsive |
| Crash recovery | Preserve finalized segments |
| Export | Background, cancellable |
| Upload | Resumable after interruption/restart |

### 9.3 Performance Policy

- Prefer lowering resolution over dropping below 30 fps.
- Disable expensive live effects on weak hardware.
- Apply cursor smoothing, blur, and smart zoom at export time.
- Use lower-resolution proxies when memory is limited.
- Pause rendering when recording starts.
- Warn users before recording if disk space is insufficient.

---

## 10. Security and Privacy

### 10.1 Tauri Permissions

- Use narrow capability files.
- Allow only approved filesystem locations.
- Keep shell access Rust-owned.
- Do not expose arbitrary command execution to React.
- Require ADR approval for capability expansion.
- Require security review for new plugins.

### 10.2 Credentials

| Credential | Storage Location |
|---|---|
| S3 access key | OS credential vault |
| S3 secret key | OS credential vault |
| Google OAuth refresh token | OS credential vault |
| Local database reference | SQLite as opaque vault reference |
| Project file | Never contains secrets |
| Logs | Redact secrets and signed URLs |

### 10.3 Logging Policy

Never log:

- Raw access keys
- Refresh tokens
- Signed URLs
- Full local media paths in remote diagnostics
- User media contents
- Screen content
- Audio transcripts
- OAuth authorization codes

### 10.4 Telemetry

- Disabled by default.
- Crash reports require opt-in.
- No uploaded media or recording content.
- No raw file names in telemetry.
- User can inspect diagnostics before sharing.

---

## 11. Documentation Plan

Create and maintain the following documentation:

```text
docs/
├── adr/
│   ├── 001-tauri-rust-react.md
│   ├── 002-windows-first.md
│   ├── 003-local-first-storage.md
│   ├── 004-ffmpeg-sidecar-policy.md
│   ├── 005-project-format.md
│   ├── 006-security-capabilities.md
│   └── 007-agent-development-workflow.md
├── specs/
│   ├── 001-product-scope-v1.md
│   ├── 002-recording-state-machine.md
│   ├── 003-capture-contract.md
│   ├── 004-media-pipeline.md
│   ├── 005-project-file-format.md
│   ├── 006-timeline-domain-model.md
│   ├── 007-storage-provider-contract.md
│   ├── 008-security-and-capabilities.md
│   └── 009-performance-benchmark.md
├── test-plans/
│   ├── capture-test-matrix.md
│   ├── recovery-test-plan.md
│   ├── media-export-test-plan.md
│   ├── storage-test-plan.md
│   └── low-end-performance-plan.md
├── benchmarks/
│   └── baseline-device-results.md
└── agent-tasks/
    ├── milestone-a-foundation.md
    ├── milestone-b-capture-spike.md
    ├── milestone-c-recorder-mvp.md
    ├── milestone-d-editor-mvp.md
    └── milestone-e-storage.md
```

### Documentation Rules

- Every ADR must explain the decision, alternatives considered, and consequences.
- Every spec must include acceptance criteria and file scope.
- Every test plan must include reproduction steps and expected results.
- Keep `AGENTS.md` synchronized with the latest stack, commands, and rules.

---

## 12. Risk Management

### 12.1 High-Risk Items

| Risk | Impact | Mitigation |
|---|---|---|
| Windows capture API limitations | High | Spike first; have fallback to DXGI/MF |
| A/V sync drift on low-end hardware | High | Monotonic timestamps, constant testing |
| Hardware encoder unreliability | High | Capability detection + CPU fallback |
| FFmpeg legal/bundling issues | Medium | Use sidecar, provide attribution |
| SQLite corruption on crash | Medium | WAL mode, frequent checkpoints, backups |
| Cloud credential security | High | OS vault only, never in code or project files |
| Long timeline UI performance | Medium | Virtualization, proxy media, debounced events |

### 12.2 Contingencies

- If Windows Graphics Capture is unsuitable, fall back to DXGI desktop duplication.
- If hardware encoders fail, default to x264 with a clear low-end warning.
- If FFmpeg bundling is problematic, require a user-provided sidecar with download instructions.
- If timeline performance lags, reduce default proxy resolution and defer effects.

---

## 13. Release Checklist for V1

- [ ] All V1 features implemented and tested.
- [ ] Low-end baseline machine benchmarks pass.
- [ ] Security review completed.
- [ ] CI is green for 14 consecutive days.
- [ ] No outstanding high-priority bugs.
- [ ] Documentation is complete and reviewed.
- [ ] Installer and updater tested on clean Windows 11 machine.
- [ ] Crash recovery tested with real forced exits.
- [ ] Telemetry opt-in flow reviewed.
- [ ] Code signed (if certificate available) or unsigned installer documented.

---

## 14. Immediate Next Steps

1. Create the Turborepo with Bun workspaces.
2. Scaffold the Tauri v2 + React + Vite + Tailwind desktop app.
3. Commit root, desktop, and Rust `AGENTS.md` files.
4. Write the Phase 0 ADRs and specs.
5. Define shared schemas for project, recording, errors, and jobs.
6. Add Rust logging, typed Tauri commands, and secure capability files.
7. Add baseline CI checks.
8. Acquire and document the low-end baseline Windows test machine.
9. Begin the Windows full-display capture technical spike.
10. Do not begin timeline, S3, Google Drive, or hosted-sharing implementation until capture reliability is accepted.

---

## 15. Deferred Roadmap

After V1 reliability and real-user validation, evaluate these separately:

### Hosted Sharing (post-V1)

- recordForge accounts and web dashboard.
- Public/unlisted/password-protected share links.
- Browser viewer.
- Comments, reactions, workspace collaboration.
- Viewer analytics.
- Hosted object storage and access policies.

### AI Features (post-V1)

- Local or opt-in cloud transcription.
- Captions and transcript-based editing.
- Chapter, summary, title, and highlight suggestions.
- Silence detection and removal suggestions.

### Additional Platforms (post-V1)

- macOS via ScreenCaptureKit.
- Linux via PipeWire.
- Cross-platform installer and signing pipelines.

### Advanced Editor (post-V1)

- Smart zoom, blur/redaction masks.
- Keyframe animations.
- Advanced templates and multi-track audio.
- Audio cleanup and green-screen effects.

---

## 16. How to Update This Plan

- Update phase tasks, exit criteria, and risks as work progresses.
- Add new phases only after V1 is accepted.
- Mark completed tasks with `[x]` and add a completion date.
- When a major decision changes, update the relevant ADR and this plan.
- When adding dependencies, follow the rules in `AGENTS.md`.

---

*Generated from `project-plan.md` for recordForge.*
