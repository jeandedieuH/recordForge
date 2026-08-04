# recordForge — Master Project Plan

> **Status:** Active foundation plan  
> **Primary objective:** Build a fast, reliable, local-first screen recorder and lightweight editor that performs well on low-end computers.  
> **Initial platform:** Windows 11  
> **Desktop stack:** Tauri v2, Rust, React, TypeScript, Vite, Tailwind CSS, SQLite, FFmpeg  
> **Optional storage:** Local filesystem, S3-compatible storage, Google Drive  


recordForge is intentionally being built **recorder-first**: reliable capture, A/V sync, recovery, responsive editing, and trustworthy exports come before cloud-sharing features. The product remains fully useful offline; cloud destinations are optional copies of completed local exports.

***

## 1. Product Definition

### 1.1 Vision

recordForge is a desktop screen-recording application for developers, educators, product teams, support teams, and creators who need to:

1. Record a display, application window, or selected region.
2. Capture microphone, system audio, and optional webcam.
3. Make practical edits without needing a heavy professional editor.
4. Export a polished local video.
5. Optionally upload the exported file to their own S3-compatible storage or Google Drive.

### 1.2 Product promise

> Press one shortcut, record reliably, make essential edits quickly, export locally, and retain ownership of every recording.

### 1.3 Inspiration

| Product direction | What recordForge adopts |
|---|---|
| Loom-style workflow | Fast capture, global shortcuts, screen/camera/microphone recording, concise recording controls |
| Cap-style workflow | Local-first recording, creator-friendly visual polish, storage ownership |
| recordForge differentiation | Low-end performance, crash recovery, local-first architecture, user-owned storage destinations, agent-friendly engineering process |

### 1.4 V1 non-goals

The following are deliberately out of scope until the desktop recorder is stable:

- recordForge-hosted share links
- Public web video pages
- User accounts and workspaces
- Comments and reactions
- Cloud collaboration
- Viewer analytics
- Billing and subscriptions
- Hosted transcription
- HLS/adaptive video streaming
- macOS and Linux production support
- Full Premiere/DaVinci-style editing features

***

## 2. Guiding Principles

### 2.1 Local-first

- Recording, editing, exporting, recovery, and project management must work offline.
- Local media is the source of truth.
- Uploads are optional copies of completed exports.
- The app must never require a recordForge backend to function.

### 2.2 Native-first media

- Rust owns native capture, audio, filesystem access, encoding coordination, credentials, and media jobs.
- React owns user interface and interaction only.
- Raw video frames and audio buffers must never pass through React state, Tauri commands, or Tauri events.

### 2.3 Low-end performance

- Default recording target: 1080p at 30 fps.
- Low-end fallback: 720p at 30 fps.
- Use hardware encoders when supported.
- Use proxy media for editing.
- Use original recordings only for final export.
- Keep expensive effects out of the real-time capture path.

### 2.4 Non-destructive editing

- Original recordings are immutable.
- Timeline edits exist as metadata in `project.json` and local SQLite.
- Final video is rendered only during export.
- Undo/redo must work through explicit, reversible timeline commands.

### 2.5 Privacy and ownership

- No automatic uploads.
- Storage credentials remain on the local machine in the operating-system credential vault.
- No telemetry by default.
- Crash diagnostics must be opt-in and redact sensitive data.

### 2.6 Agent-ready development

- Every feature starts with a written specification and acceptance criteria.
- Coding agents work on small, bounded tasks.
- Capture, performance, security, and destructive storage operations require human review.
- An agent cannot claim work complete without passing relevant automated checks and supplying evidence.

***

## 3. Target Users

| User | Primary job |
|---|---|
| Developer | Record bug reports, coding walkthroughs, API demos, and release notes |
| Educator | Record software tutorials and course lessons |
| Product manager | Explain product requirements and feedback asynchronously |
| Support engineer | Create visual troubleshooting guides |
| Sales/demo creator | Record product demos and walkthroughs |
| Solo creator | Produce polished local screen recordings without cloud lock-in |

***

## 4. Technical Decisions

### 4.1 Approved stack

| Area | Decision | Purpose |
|---|---|---|
| Desktop framework | Tauri v2 | Desktop windowing, lifecycle, security permissions, IPC, packaging |
| Native language | Rust | Capture, audio, media jobs, local filesystem, security-sensitive operations |
| UI | React + TypeScript | Recorder, library, timeline, settings, export experience |
| Bundler | Vite | Fast frontend builds and development workflow |
| Styling | Tailwind CSS | Consistent desktop UI and efficient iteration |
| Package manager | Bun | Dependency management, scripts, workspaces |
| Monorepo | Turborepo + Bun workspaces | Shared packages and cached CI tasks |
| Local database | SQLite | Projects, local media index, settings, recovery/upload queues |
| Database access | Drizzle ORM or direct Rust SQLite layer | Structured persistence and migration management |
| Video processing | FFmpeg + FFprobe | Proxies, thumbnails, waveforms, final rendering, export |
| State management | Zustand | Local UI state and editor interaction state |
| Validation | Zod | Shared frontend request/domain validation |
| Audio visualization | Wavesurfer.js | Waveforms, regions, markers |
| Timeline virtualization | TanStack Virtual | Efficient timeline and media-library rendering |
| Drag interactions | dnd-kit | Timeline clip and layout interactions |
| Storage | Local folders, S3-compatible APIs, Google Drive | User-owned export destinations |

Tauri’s command model is appropriate for React-to-Rust requests, while asynchronous events/channels should be used only for compact job progress or status notifications—not large media payloads. [v2.tauri](https://v2.tauri.app/develop/calling-rust/)

### 4.2 Architecture decision

```text
React UI
   │
   │ Tauri commands, channels, compact events
   ▼
Tauri Rust Core
   ├── Recorder state machine
   ├── Native capture and audio
   ├── FFmpeg/FFprobe job supervision
   ├── Local SQLite and project persistence
   ├── Credential-vault access
   ├── Storage upload queue
   └── Tray, hotkeys, notifications, updater
        │
        ├── Local recordings/projects
        ├── S3-compatible storage
        └── Google Drive
```

### 4.3 Communication rules

| Channel | Allowed use | Forbidden use |
|---|---|---|
| Tauri command | Start recording, stop recording, query devices, create export job | Continuous frame transfer |
| Tauri event/channel | Recording state, audio levels, progress percentages, compact errors | Raw frames, PCM audio, full FFmpeg logs |
| React state | UI selection, playhead, panels, timeline interaction state | File contents, frame data, filesystem credentials |
| Rust background task | Capture, encoding, uploads, proxy jobs, rendering | Blocking UI thread |
| SQLite | Metadata, project index, queue/resume metadata | Plaintext cloud credentials |
| OS keychain/vault | OAuth refresh tokens, S3 access keys | Project data or media files |

***

## 5. Repository Structure

```text
recordForge/
├── AGENTS.md
├── README.md
├── package.json
├── turbo.json
├── bun.lock
│
├── apps/
│   └── desktop/
│       ├── AGENTS.md
│       ├── src/                         # React application
│       │   ├── app/
│       │   ├── components/
│       │   ├── features/
│       │   │   ├── recorder/
│       │   │   ├── library/
│       │   │   ├── editor/
│       │   │   ├── export/
│       │   │   ├── storage/
│       │   │   └── settings/
│       │   ├── hooks/
│       │   ├── lib/
│       │   ├── stores/
│       │   └── styles/
│       │
│       └── src-tauri/
│           ├── AGENTS.md
│           ├── capabilities/
│           ├── binaries/                # FFmpeg per platform
│           ├── icons/
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
│   ├── contracts/                       # Shared Zod/API DTO schemas
│   ├── domain/                          # Project and timeline models
│   ├── editor-core/                     # Pure timeline command engine
│   ├── media-core/                      # FFmpeg job specifications
│   ├── storage-core/                    # Provider-neutral contracts
│   ├── ui/                              # Shared components/design tokens
│   └── config/                          # TS, lint, Tailwind configuration
│
├── docs/
│   ├── adr/
│   ├── architecture/
│   ├── specs/
│   ├── test-plans/
│   ├── benchmarks/
│   └── agent-tasks/
│
├── tooling/
│   ├── ffmpeg/
│   ├── fixtures/
│   └── scripts/
│
└── .github/
    └── workflows/
```

***

## 6. Core Product Modules

### 6.1 Recorder

The recorder is the highest-priority module.

#### Required capabilities

- Full-display capture
- Application-window capture
- User-selected region capture
- Multiple monitor selection
- Microphone capture
- System-audio capture
- Optional webcam capture
- Countdown before recording
- Pause and resume
- Stop recording
- Marker insertion during recording
- Global shortcuts
- Tray/menu-bar status
- Floating recording toolbar
- Encoder capability detection
- Low-end performance profile
- Crash recovery

#### Recorder state machine

```text
idle
  ↓
selecting-source
  ↓
configuring
  ↓
countdown
  ↓
recording
  ↔ paused
  ↓
finalizing
  ↓
completed

Any state
  ↓
failed
  ↓
recovering
  ↓
completed | recovery-required
```

```ts
type RecorderState =
  | "idle"
  | "selecting-source"
  | "configuring"
  | "countdown"
  | "recording"
  | "paused"
  | "finalizing"
  | "completed"
  | "failed"
  | "recovering"
  | "recovery-required";
```

#### Global shortcuts

| Action | Default shortcut |
|---|---|
| Start/stop recording | `Ctrl + Shift + R` |
| Pause/resume | `Ctrl + Shift + P` |
| Insert marker | `Ctrl + Shift + M` |
| Toggle microphone | `Ctrl + Shift + U` |
| Toggle webcam | `Ctrl + Shift + C` |
| Capture screenshot | `Ctrl + Shift + S` |

Register recording shortcuts in Rust so they can work even when the main application window is hidden. Tauri provides a global-shortcut plugin with Rust and JavaScript integration. [docs](https://docs.rs/crate/tauri-plugin-global-shortcut/latest)

### 6.2 Native capture

#### Platform order

| Priority | Platform | Capture approach | Status |
|---|---|---|---|
| 1 | Windows 10 | FFmpeg `ddagrab` with `gdigrab` bounds fallback; DirectShow optional audio/webcam inputs | Implemented baseline |
| 2 | macOS 14+ | ScreenCaptureKit | Future |
| 3 | Linux | PipeWire | Experimental future |

#### Windows V1 capture requirements

- Enumerate displays and windows.
- Capture a selected display.
- Capture a selected application window.
- Capture a user-selected region.
- Capture system audio through an available DirectShow loopback/virtual device in the current baseline.
- Capture microphone audio through DirectShow in the current baseline.
- Native WASAPI loopback and independent audio assets remain a follow-up.
- Support optional webcam input.
- Maintain monotonic capture timestamps.
- Write recoverable local media segments.
- Provide user-readable permission/device errors.

#### Capture interface

```rust
pub trait CaptureEngine: Send + Sync {
    fn list_sources(&self) -> Result<Vec<CaptureSource>, CaptureError>;

    fn start(
        &mut self,
        config: RecordingConfig,
    ) -> Result<RecordingSession, CaptureError>;

    fn pause(
        &mut self,
        session_id: &str,
    ) -> Result<(), CaptureError>;

    fn resume(
        &mut self,
        session_id: &str,
    ) -> Result<(), CaptureError>;

    fn stop(
        &mut self,
        session_id: &str,
    ) -> Result<RecordingResult, CaptureError>;
}
```

### 6.3 Recording output and recovery

**Implemented Windows baseline:** The UI start path now prepares a UUID session and durable manifest before capture. Rust owns the countdown/start/cancel boundary, minimizes the main window, and creates the floating controls and capture-boundary windows. FFmpeg writes fragmented MP4 segments into the session directory; stop validates and atomically publishes `output.mp4`, inserts an idempotent SQLite library row, and caches FFprobe metadata.

Do not write one giant recording file during capture. Write recoverable segments.

```text
recordForge Library/
└── 2026-08-02-recording-001/
    ├── session.json
    ├── source/
    │   ├── video-00001.m4s
    │   ├── video-00002.m4s
    │   ├── audio-00001.m4s
    │   └── audio-00002.m4s
    ├── recovery/
    │   └── recording-state.json
    └── logs/
        └── capture.log
```

#### Recovery rules

1. Persist a session manifest before capture starts.
2. Mark each finalized segment as complete atomically and flush critical files.
3. On startup, scan the sessions directory from the Library view for incomplete sessions.
4. Include physical fragmented `seg_*.mp4` files when a force-quit happened before the manifest saw a finalized fragment.
5. Validate candidate segments and the recovered output before presenting it as a recording.
6. Rebuild into a temporary output and atomically publish the final MP4.
7. Insert by `session_id` so recovery retries cannot duplicate library rows.
8. Offer **Recover**, **Export recovered file**, and **Delete**.
9. Never silently delete recoverable media.

Periodic segment rollover is still planned for long recordings so a hard kill has a bounded maximum loss window.

Fragmented MP4-style recording is suitable for recovery because media is stored as independently completed fragments; FFmpeg supports creating fragments at keyframes. [stackoverflow](https://stackoverflow.com/questions/8616855/how-to-output-fragmented-mp4-with-ffmpeg)

### 6.4 Media pipeline

```text
Capture/import
  ↓
FFprobe metadata
  ↓
Proxy generation
  ↓
Thumbnail generation
  ↓
Waveform peak extraction
  ↓
Timeline editing
  ↓
FFmpeg render plan
  ↓
Final export
  ↓
Optional storage upload
```

#### Background jobs

| Job | Input | Output |
|---|---|---|
| Probe | Recording/import | Codec, duration, fps, audio streams, dimensions |
| Proxy | Original recording | 540p or 720p MP4 for editor playback |
| Thumbnails | Proxy/original | Filmstrip or indexed thumbnail frames |
| Waveform | Audio stream | Compact waveform peak data |
| Render | Project JSON + originals | Exported video |
| Upload | Finished export | Remote S3/Drive file |
| Cleanup | User-approved stale derivatives | Disk-space recovery |

#### FFmpeg responsibilities

Use FFmpeg for:

- Proxy generation
- Thumbnail extraction
- Audio normalization and mixing
- Scaling and cropping
- Webcam composition
- Canvas background/padding/corner effects
- Caption burn-in
- Final MP4/WebM/GIF export
- Hardware-encoder execution where available

FFmpeg supports hardware-accelerated workflows, but available acceleration methods depend on OS, GPU, drivers, build configuration, codec, and filters; recordForge must detect and test capabilities rather than assume they exist. [ffmpeg](https://ffmpeg.org/ffmpeg.html)

### 6.5 Hardware encoder policy

#### Encoder priority

1. NVIDIA NVENC
2. Intel Quick Sync Video
3. AMD AMF
4. Windows Media Foundation encoder
5. CPU x264 fallback

#### Quality profiles

| Profile | Resolution | FPS | Encoder behavior |
|---|---:|---:|---|
| Low-impact | 1280 × 720 | 30 | Hardware preferred; conservative bitrate |
| Balanced | 1920 × 1080 | 30 | Default profile |
| Smooth demo | 1920 × 1080 | 60 | Available only after capability test |
| High quality | Source resolution up to 1440p | 30 | Higher bitrate, hardware preferred |
| Camera only | 1920 × 1080 | 30 | Optimized for video messages |

#### First-launch preflight

The app must evaluate:

- CPU model and logical cores
- Available RAM
- GPU model and driver availability
- Supported encoders
- Available disk space
- Display configuration
- Webcam availability
- Microphone availability
- System-audio availability
- Encoder test success/failure

The preflight selects a conservative default profile. Users can override it, but the app should clearly flag risky configurations.

### 6.6 Local library

The library is a local database-backed index of recordings and projects.

#### Required features

- Grid/list recording view
- Search by title
- Sort by date, duration, size, and status
- Tags
- Folders/collections
- Recording state badges
- Recovery items
- Export history
- Storage upload status
- Reveal in file manager
- Open project
- Duplicate project
- Delete with confirmation
- Disk-usage visibility

#### Local filesystem layout

```text
recordForge/
├── Library/
│   └── {project-id}/
│       ├── source/
│       ├── proxies/
│       ├── derived/
│       ├── exports/
│       ├── project.json
│       └── manifest.json
├── Backups/
├── Diagnostics/
└── app.db
```

### 6.7 Timeline editor

The V1 editor is a practical finalization tool, not a general-purpose nonlinear editor.

#### V1 tracks

| Track | Purpose |
|---|---|
| Screen video | Main screen capture |
| Webcam video | Picture-in-picture camera |
| Microphone audio | Voice track |
| System audio | System/application sound |
| Captions | Imported or generated captions |
| Markers | User markers and chapter markers |
| Effects | Cursor and visual effects |

#### V1 actions

- Trim clip start/end
- Split clip
- Move clip
- Delete clip/range
- Ripple delete
- Adjust clip speed
- Mute/unmute track
- Adjust clip audio gain
- Add audio fade in/out
- Resize/reposition webcam PiP
- Set canvas background
- Set padding, rounded corners, and shadow
- Add marker
- Add captions
- Apply cursor highlight
- Apply click ring
- Undo/redo

#### Timeline performance rules

- Use proxy files for playback.
- Use original files only for final render.
- Virtualize clips, thumbnails, markers, and library items.
- Render only visible timeline elements.
- Use `requestAnimationFrame` for playhead rendering.
- Keep drag/resize interaction state outside persisted project data.
- Generate waveform peaks once and cache them.
- Do not decode video frames in React repeatedly.

TanStack Virtual supports horizontal and vertical virtualization, making it appropriate for long timelines and large local libraries.  Wavesurfer.js provides interactive waveforms and region overlays suitable for audio markers and selection UI. [tanstack](https://tanstack.com/virtual/latest/docs/introduction)

#### Project model

```ts
type recordForgeProject = {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  canvas: CanvasSettings;
  assets: MediaAsset[];
  tracks: TimelineTrack[];
  markers: Marker[];
  exportSettings: ExportSettings;
};

type TimelineTrack = {
  id: string;
  kind: "screen" | "camera" | "audio" | "captions" | "effects";
  name: string;
  muted: boolean;
  locked: boolean;
  clips: TimelineClip[];
};

type TimelineClip = {
  id: string;
  assetId: string;
  startMs: number;
  durationMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  speed: number;
  transform?: ClipTransform;
  effects?: ClipEffect[];
};
```

#### Command model

```ts
type TimelineCommand =
  | { type: "clip.trim"; clipId: string; edge: "start" | "end"; timeMs: number }
  | { type: "clip.split"; clipId: string; timeMs: number }
  | { type: "clip.move"; clipId: string; trackId: string; startMs: number }
  | { type: "range.delete"; startMs: number; endMs: number; ripple: boolean }
  | { type: "clip.volume"; clipId: string; gainDb: number }
  | { type: "marker.add"; timeMs: number; label: string }
  | { type: "canvas.update"; settings: Partial<CanvasSettings> };
```

Timeline-domain logic belongs in `packages/editor-core` and must be unit-tested independently from React.

### 6.8 Export

#### Export presets

| Preset | Output |
|---|---|
| Fast share | 1080p, 30 fps, H.264/AAC |
| Balanced | 1080p, 30 fps, optimized bitrate |
| Smooth demo | 1080p, 60 fps when supported |
| High quality | Up to 1440p, 30 fps |
| Archive | High-bitrate source-quality MP4 |
| GIF snippet | Short duration, reduced resolution |
| Vertical social | 1080 × 1920 reframed output |

#### Export requirements

- Background, cancellable job
- Render to temporary output
- Validate output through FFprobe
- Atomically move completed file to destination
- Keep original media unchanged
- Show progress, current stage, elapsed time, estimated remaining time
- Show encoder selected
- Allow low-impact render mode
- Allow reveal/open after completion

### 6.9 Storage destinations

Storage is optional and must never block local use.

#### Provider priority

1. Local folder export
2. S3-compatible object storage
3. Google Drive
4. Future: recordForge-hosted publishing and share links

#### Storage rules

- Local media remains canonical.
- Upload only validated completed exports.
- Do not stream capture output directly to cloud storage in V1.
- Persist upload state in SQLite.
- Store secrets only in the OS credential vault.
- Support pause, resume, retry, cancellation, and connection testing.
- Do not delete local exports after successful upload unless the user explicitly requests cleanup.

#### Storage-provider interface

```rust
pub trait StorageProvider: Send + Sync {
    async fn validate_connection(&self) -> Result<StorageHealth, StorageError>;

    async fn create_upload(
        &self,
        input: CreateUploadInput,
    ) -> Result<UploadSession, StorageError>;

    async fn upload_part(
        &self,
        session: &UploadSession,
        part: UploadPart,
    ) -> Result<UploadedPart, StorageError>;

    async fn resume_upload(
        &self,
        session: &UploadSession,
    ) -> Result<UploadProgress, StorageError>;

    async fn complete_upload(
        &self,
        session: &UploadSession,
    ) -> Result<RemoteAsset, StorageError>;

    async fn cancel_upload(
        &self,
        session: &UploadSession,
    ) -> Result<(), StorageError>;
}
```

#### S3-compatible storage

Support:

- AWS S3
- Cloudflare R2
- Backblaze B2 S3 API
- MinIO
- Wasabi
- DigitalOcean Spaces
- Hetzner-compatible S3 endpoints
- Other compatible providers

Use multipart upload for large exports. S3 multipart upload divides a file into parts that can be uploaded independently and then assembled when the upload is completed. [docs.aws.amazon](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)

```ts
type S3StorageProfile = {
  id: string;
  name: string;
  provider: "s3";
  endpoint?: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle?: boolean;
  accessKeySecretRef: string;
  secretKeySecretRef: string;
};
```

#### Google Drive

Use Google OAuth in the system browser, then store tokens in the OS credential vault.

Google Drive resumable uploads are appropriate for large videos and interrupted networks: they use an initial session URI, followed by resumable `PUT` uploads. [developers.google](https://developers.google.com/workspace/drive/api/guides/manage-uploads)

```ts
type GoogleDriveProfile = {
  id: string;
  provider: "google-drive";
  accountEmail: string;
  rootFolderId: string;
  refreshTokenSecretRef: string;
};
```

#### Upload job model

```ts
type UploadJob = {
  id: string;
  providerProfileId: string;
  projectId: string;
  exportId: string;
  localPath: string;
  remotePath: string;
  state:
    | "queued"
    | "preparing"
    | "uploading"
    | "paused"
    | "retrying"
    | "completed"
    | "failed"
    | "cancelled";
  bytesUploaded: number;
  totalBytes: number;
  resumeData?: Record<string, unknown>;
  retryCount: number;
  lastError?: string;
};
```

***

## 7. User Experience

### 7.1 Recording flow

1. User presses a global shortcut.
2. The source-selection overlay opens.
3. User chooses display, window, or region.
4. User selects microphone, system audio, webcam, and quality profile.
5. User starts a countdown.
6. Recording begins.
7. A small floating toolbar shows timer, audio level, marker, pause, and stop.
8. User stops the recording.
9. recordForge finalizes segments and opens the recording in the library.
10. Proxy/thumbnails/waveform generation starts in the background.
11. User can export immediately or open the editor.

### 7.2 Editing flow

1. User opens a project.
2. recordForge loads local proxy media, thumbnails, and waveform peaks.
3. User trims unwanted sections, splits clips, adjusts audio, and repositions webcam.
4. User applies basic visual effects.
5. User selects an export preset.
6. The export runs in a background job.
7. User reveals the local file or uploads it to a configured destination.

### 7.3 Storage flow

1. User completes a local export.
2. User selects **Upload to destination**.
3. recordForge validates the storage profile.
4. A resumable background upload starts.
5. The app persists upload state locally.
6. User can pause, cancel, retry, or resume after restart.
7. The app displays the remote destination path and provider URL when available.

***

## 8. Performance Requirements

### 8.1 Baseline target machine

Define and acquire one reference low-end Windows machine before feature work proceeds.

Suggested baseline:

- Windows 11
- Intel integrated graphics
- 8 GB RAM
- Entry-level or older quad-core CPU
- SSD with limited free capacity
- 1080p display
- Built-in microphone and webcam

### 8.2 Performance targets

| Metric | Target |
|---|---:|
| Idle application memory | Under 200 MB excluding OS webview overhead |
| Recorder UI CPU overhead | Under 5% without webcam |
| Default recording | 1080p at 30 fps |
| Low-end fallback | 720p at 30 fps |
| Recording start after shortcut | Under 2 seconds |
| Proxy timeline playback | 30 fps where proxy supports it |
| Timeline interaction | Responsive with 60-minute recording |
| Crash recovery | Preserve finalized segments |
| Export execution | Background, cancellable, non-blocking |
| Storage upload | Resumable after network interruption/app restart |

### 8.3 Required recording metrics

Every capture session should record local diagnostic metrics:

```ts
type RecordingMetrics = {
  sessionId: string;
  profile: string;
  durationMs: number;
  requestedFps: number;
  actualFps?: number;
  droppedFrames?: number;
  videoBitrate?: number;
  encoder: string;
  averageCpuPercent?: number;
  peakMemoryMb?: number;
  diskBytesWritten: number;
  audioVideoDriftMs?: number;
};
```

### 8.4 Performance policy

- Prefer lowering resolution over lowering below 30 fps for tutorials.
- Disable expensive live effects on weak hardware.
- Apply cursor smoothing, blur, smart zoom, and some visual effects at export time.
- Use lower-resolution proxies when available memory is limited.
- Pause or throttle rendering when recording begins.
- Warn users before recording if disk space is insufficient.

***

## 9. Security and Privacy

### 9.1 Tauri permissions

- Use narrow Tauri capability files.
- Allow only approved filesystem locations.
- Keep shell access Rust-owned.
- Do not expose arbitrary command execution to React.
- Require ADR approval for capability expansion.
- Require a security review for new plugins.

Tauri v2 uses a capability-based security model, so permissions should be explicitly scoped rather than broadly exposed to the frontend. [smithery](https://smithery.ai/skills/funnyhust/tauri-v2)

### 9.2 Credentials

| Credential | Storage location |
|---|---|
| S3 access key | OS credential vault |
| S3 secret key | OS credential vault |
| Google OAuth refresh token | OS credential vault |
| Local database reference | SQLite only as opaque vault reference |
| Project file | Never contains secrets |
| Logs | Must redact secrets and signed URLs |

### 9.3 Logging policy

Never log:

- Raw access keys
- Refresh tokens
- Signed URLs
- Full local media paths in remote diagnostics
- User media contents
- Screen content
- Audio transcripts
- OAuth authorization codes

Use structured Rust logs through `tracing`, with user-redactable diagnostics exports.

### 9.4 Telemetry

- Disabled by default
- Crash reports require opt-in
- No uploaded media or recording content
- No raw file names in telemetry
- User can inspect diagnostics before manually sharing them

***

## 10. Testing Strategy

### 10.1 Test layers

| Layer | Tooling | Coverage |
|---|---|---|
| Rust units | `cargo test` | Capture state machine, media jobs, storage jobs, recovery |
| Rust quality | `cargo fmt`, `cargo clippy` | Formatting and lint compliance |
| TypeScript units | Vitest | Timeline commands, Zod schemas, state logic |
| React components | React Testing Library | UI behavior and forms |
| Desktop E2E | WebDriver/WebdriverIO or Playwright strategy | App launch and end-to-end workflows |
| Media fixtures | FFmpeg/FFprobe | Rendering, metadata, proxy and output validation |
| Hardware benchmarks | Reference devices | CPU, memory, frame drops, sync, disk I/O |
| Manual QA | Hardware matrix | Device behavior and native edge cases |

Tauri supports Rust/JavaScript testing and has WebDriver-oriented options for desktop end-to-end testing. [jonaskruckenberg.github](https://jonaskruckenberg.github.io/tauri-docs-wip/development/testing.html)

### 10.2 Required test scenarios

#### Capture

- Start/stop recording
- Pause/resume recording
- Microphone-only recording
- System-audio-only recording
- Mic plus system audio
- Webcam plus screen capture
- Single display
- Multi-monitor display selection
- Window capture
- Region capture
- Device unplug during recording
- Sleep/lock-screen behavior
- Low disk-space warning
- Encoder fallback
- Force quit during recording
- Long recording: 30 min, 60 min, 120 min

#### Recovery

- Forced application termination
- Process crash
- Power-loss simulation
- Interrupted finalization
- Corrupted segment
- Missing segment
- Recoverable and unrecoverable session behavior

#### Timeline

- Trim clip
- Split clip
- Move clip
- Ripple delete
- Undo/redo
- Webcam PiP transform
- Audio gain and fades
- Long timeline virtualization
- Proxy playback
- Export matching timeline state

#### Storage

- Invalid S3 endpoint
- Invalid credentials
- Wrong bucket permission
- Multipart upload
- Interrupted S3 upload
- App restart during upload
- Google OAuth cancellation
- Google token expiration
- Google resumable upload interruption
- Upload cancellation
- Local export retained after remote failure

***

## 11. Coding-Agent Operating Model

### 11.1 Agent roles

| Agent | Responsibility |
|---|---|
| Planning agent | Breaks specs into tasks, identifies dependencies and risks |
| Rust/Tauri agent | Commands, state, permissions, tray, hotkeys, local persistence |
| Capture agent | Native Windows capture, audio, timestamps, recovery |
| Media agent | FFmpeg/FFprobe jobs, proxies, waveform, thumbnails, exports |
| React agent | Recorder UI, library, timeline, settings, export UI |
| Storage agent | S3 and Google Drive adapters, resumable queue |
| QA agent | Tests, fixtures, benchmark reports, regression coverage |
| Security reviewer | Capability review, credential handling, path validation, logging |

### 11.2 Mandatory workflow

1. Agent reads the nearest `AGENTS.md`.
2. Agent reads the relevant specification and ADR.
3. Agent produces a task plan before implementation for non-trivial work.
4. Human approves the plan.
5. Agent changes only the agreed file scope.
6. Agent runs required tests/checks.
7. Agent reports changed files, validation evidence, limitations, and follow-up work.
8. Human reviews the diff before merge.

### 11.3 Root AGENTS.md requirements

The root `AGENTS.md` must state:

- Product summary
- Approved stack
- V1 scope and non-goals
- Architectural boundaries
- Commands to install, run, lint, typecheck, and test
- Security rules
- Rules for adding dependencies
- Rules for changing Tauri capabilities
- Completion-report format

`AGENTS.md` is designed to give coding agents project-specific setup, conventions, testing instructions, and security context; nested files can refine instructions per module. [agents](https://agents.md/)

### 11.4 Agent guardrails

- Do not allow agents access to production credentials.
- Do not allow agents to access private recordings.
- Use test S3 buckets and a test Google account.
- Do not run coding agents as administrator/root.
- Use isolated branches or worktrees.
- Do not let agents concurrently modify `capture`, `media`, `contracts`, or `editor-core`.
- Require human approval for native dependencies, CI changes, signing, updater configuration, permission changes, and deletion logic.
- Require regression tests for bug fixes.

***

## 12. Documentation Plan

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
│
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
│
├── test-plans/
│   ├── capture-test-matrix.md
│   ├── recovery-test-plan.md
│   ├── media-export-test-plan.md
│   ├── storage-test-plan.md
│   └── low-end-performance-plan.md
│
├── benchmarks/
│   └── baseline-device-results.md
│
└── agent-tasks/
    ├── milestone-a-foundation.md
    ├── milestone-b-capture-spike.md
    ├── milestone-c-recorder-mvp.md
    ├── milestone-d-editor-mvp.md
    └── milestone-e-storage.md
```

***

## 13. Roadmap

### Phase 0 — Foundation

**Target duration:** 1–2 weeks

#### Deliverables

- Turborepo and Bun workspace
- Tauri v2, React, Vite, TypeScript, Tailwind setup
- Root and nested `AGENTS.md`
- Rust and TypeScript linting/testing
- CI pipeline
- Shared contracts package
- Logging and error model
- Initial Tauri capability configuration
- SQLite initialization and migrations
- Architecture decision records
- Basic tray/menu and app shell

#### Exit criteria

- Fresh clone builds successfully.
- One documented command runs development mode.
- One documented command runs all checks.
- CI validates linting, typechecking, and tests.
- Agent instructions are committed and reviewed.

***

### Phase 1 — Native Capture Spike

**Target duration:** 2 weeks

#### Deliverables

- Windows display enumeration
- Full-display capture
- Capture configuration model
- H.264 encoder test
- Hardware encoder detection
- CPU fallback
- Segment manifest format
- Force-quit recovery prototype
- Minimal React recording-status view
- Benchmark command and report template

#### Exit criteria

- 30-minute 1080p30 recording completes on the baseline low-end device.
- Video is playable.
- A/V drift is within the defined tolerance.
- Capture survives normal stop and forced-quit recovery.
- CPU, memory, disk-write, FPS/drop, and sync measurements are recorded.

> Do not begin advanced UI, timeline, storage, or sharing work until this phase is accepted.

***

### Phase 2 — Recorder MVP

**Target duration:** 4–6 weeks

#### Deliverables

- Full display, application window, and region selection
- Microphone and system audio
- Optional webcam
- Global shortcuts
- Tray application behavior
- Floating recording controls
- Countdown
- Marker insertion
- Pause/resume
- Library index
- Local recording metadata
- Recovery UI
- Basic trim
- Local MP4 export
- Device and encoder diagnostics

#### Exit criteria

- A user can record, pause, stop, recover, trim, and export offline.
- The default profile works on the baseline low-end device.
- Common capture errors are understandable and actionable.
- The app can be used daily for development tutorials or bug reports.

***

### Phase 3 — Media Preparation

**Target duration:** 3–4 weeks

#### Deliverables

- FFprobe metadata extraction
- Proxy generation
- Thumbnail generation
- Waveform peak extraction
- Background job framework
- Job progress/cancellation
- SQLite queue persistence
- Disk-space estimates
- Media derivative cleanup policy

#### Exit criteria

- A 60-minute recording opens without freezing the application.
- Editor playback uses proxy media.
- All generated derivative media can be recreated from original files.
- Jobs recover safely after app restart.

***

### Phase 4 — Timeline Editor MVP

**Target duration:** 5–7 weeks

#### Deliverables

- Timeline domain model
- Timeline command engine
- Undo/redo
- Virtualized timeline UI
- Playhead/seek/zoom controls
- Trim, split, move, delete, ripple delete
- Microphone/system-audio controls
- Webcam PiP placement/crop/resize
- Marker/chapter track
- Basic captions track
- Export render-plan generator
- Final original-quality export

#### Exit criteria

- A user can edit a 60-minute recording without severe UI lag.
- Timeline operations are covered by unit tests.
- Final export accurately matches the timeline.
- Export can run without blocking the rest of the app.

***

### Phase 5 — Studio Polish

**Target duration:** 3–4 weeks

#### Deliverables

- Cursor size/highlight
- Click-ring effect
- Canvas background
- Padding, border radius, shadows
- Webcam border/shape options
- Export presets
- Screenshot capture and annotation
- Recording templates: tutorial, demo, bug report, lesson
- Keyboard editing shortcuts
- Improved first-run onboarding
- Installer, updater, and diagnostics UX

#### Exit criteria

- recordForge produces professional-looking tutorial/demo exports.
- The common workflow requires minimal configuration.
- Users can understand and resolve common device, storage, or disk issues.

***

### Phase 6 — Storage Destinations

**Target duration:** 2–4 weeks

#### Deliverables

- Local-folder destination adapter
- S3-compatible storage profiles
- S3 multipart upload
- Upload queue with pause/resume/retry/cancel
- OS credential-vault integration
- Google OAuth browser flow
- Google Drive folder selection
- Google Drive resumable upload
- Upload status UI
- Connection diagnostics

#### Exit criteria

- A user uploads a 1 GB MP4 to S3-compatible storage.
- The upload can be interrupted and resumed.
- The user can restart the app and resume the upload.
- A user uploads to Google Drive with resumable upload behavior.
- Local export remains available regardless of upload result.

***

## 14. Definition of Done for V1

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

***

## 15. Deferred Roadmap

After V1 reliability and real-user validation, evaluate these initiatives separately:

### Hosted sharing

- recordForge account system
- Web dashboard
- Public/unlisted/password-protected links
- Browser viewer
- Viewer comments and reactions
- Workspace collaboration
- Viewer analytics
- Hosted R2/object storage
- Video access policies

### AI features

- Local or opt-in cloud transcription
- Captions
- Transcript-based editing
- Chapter suggestions
- Automatic summaries
- Title suggestions
- Highlight clip suggestions
- Silence detection/removal suggestions

### Additional platforms

- macOS through ScreenCaptureKit
- Linux through PipeWire
- Cross-platform installer and signing pipelines
- Platform-specific benchmark matrix

### Advanced editor features

- Smart zoom
- Blur/redaction masks
- Keyframe animations
- Advanced templates
- More video/audio tracks
- Advanced captions
- Audio cleanup
- Green-screen/background removal

***

## 16. Immediate Start Checklist

1. Create the `recordForge` Turborepo with Bun workspaces.
2. Scaffold the Tauri v2 + React + Vite + Tailwind desktop app.
3. Commit `AGENTS.md` at root, desktop, and Rust-core levels.
4. Create the Phase 0 architecture documents and ADRs.
5. Define the shared project, recording, error, and job schemas.
6. Add Rust logging, typed Tauri commands, and secure capability files.
7. Add baseline CI checks.
8. Acquire and document the low-end baseline Windows test machine.
9. Start the Windows full-display capture technical spike.
10. Do not begin timeline, S3, Google Drive, or hosted-sharing implementation until capture reliability is accepted.