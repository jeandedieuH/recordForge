# recordForge — macOS and Linux Production Improvement Plan

> **Status:** Draft — implementation-ready roadmap; no production implementation changes are included in this document.
> **Owner:** Desktop capture and media engineering
> **Scope:** Make the macOS and Linux desktop targets truthful, functional, testable, and releasable without regressing Windows.
> **Primary outcome:** A user can select a real source and real audio devices, record valid media, recover from interruption, edit the result, and export it on each supported platform.

---

## 1. Executive decision

The current `macos-and-linux-versions` branch contains useful platform scaffolding, packaging configuration, and compile coverage, but it must not be treated as production macOS/Linux support yet.

The following paths are still synthetic or disconnected from the recorder:

- macOS ScreenCaptureKit discovery and streaming.
- macOS CoreAudio device discovery and audio capture.
- Linux display/source discovery.
- Linux ALSA/PulseAudio/PipeWire audio capture.
- macOS/Linux cursor position, buttons, shapes, and topology.
- Cross-platform audio selection in the recording session.
- Platform-specific hardware encoder selection.

The immediate production goal is therefore **not** to add more platform labels to the UI. It is to replace every synthetic path with a real adapter, or to expose a truthful unsupported state when the operating system cannot provide the requested capability.

### 1.1 Current evidence

The current branch compiles successfully on Windows, macOS, and Ubuntu in GitHub Actions, but its capture tests can pass without capturing real frames or samples. The test workers currently create empty or synthetic media, and the non-Windows audio worker writes silence. The current CI result is therefore a compilation and infrastructure signal, not proof of runtime parity.

The existing ADR should be considered **partially implemented** until the gates in this plan pass:

- [ADR 014: Cross-Platform macOS and Linux Expansion](docs/adr/014-cross-platform-macos-linux.md)
- [End-to-End Improvement Roadmap](end-to-end%20improvement-plan.md)
- [Repository operating guide](AGENTS.md)

---

## 2. Goals and non-goals

### 2.1 Goals

1. Preserve the working Windows capture path while moving shared code behind platform-neutral interfaces.
2. Implement real display, window, region, microphone, system-audio, webcam, and cursor behavior for the declared platform matrix.
3. Keep raw video frames and PCM buffers inside native Rust/platform capture and media implementations; never send them through React, Zustand, Tauri IPC, or Tauri events.
4. Use one monotonic recording timeline for screen, microphone, system audio, webcam, and cursor metadata.
5. Make permissions, device loss, missing drivers, unsupported desktop sessions, and unavailable encoders explicit and recoverable.
6. Make all automated tests distinguish between deterministic fake adapters and real hardware integration tests.
7. Build and package architecture-correct macOS Intel, macOS Apple Silicon, and Linux x86_64 artifacts.
8. Prove crash recovery, A/V synchronization, and low-end performance with measurable thresholds.

### 2.2 Non-goals

- Replacing FFmpeg as the media-processing sidecar.
- Adding hosted sharing, accounts, collaboration, or mandatory telemetry.
- Sending raw capture data to the frontend for rendering.
- Promising capabilities that the operating system deliberately withholds, especially arbitrary global cursor data on Wayland.
- Supporting every Linux distribution or compositor in the first production release.
- Creating a universal macOS binary unless the release decision explicitly selects that strategy.

---

## 3. Supported platform matrix

The matrix below is the proposed release contract. A capability is not considered supported merely because its Rust module compiles; it must pass the relevant runtime and recovery gates.

| Platform      | Architecture  | Desktop/session baseline | Screen/display                            | Window                                                | Region                                            | Microphone                       | System audio                  | Webcam       | Cursor telemetry                                        |
| ------------- | ------------- | ------------------------ | ----------------------------------------- | ----------------------------------------------------- | ------------------------------------------------- | -------------------------------- | ----------------------------- | ------------ | ------------------------------------------------------- |
| Windows 10/11 | x86_64        | Desktop Duplication/GDI  | Supported today; re-verify after refactor | Existing crop semantics must remain documented/tested | Supported                                         | WASAPI                           | WASAPI loopback               | DirectShow   | Native position/buttons/shapes                          |
| macOS 12.3+   | Apple Silicon | macOS ScreenCaptureKit   | Real SCK stream                           | SCK window filter                                     | SCK display filter/crop                           | CoreAudio                        | ScreenCaptureKit audio stream | AVFoundation | CoreGraphics/SCK metadata with documented limits        |
| macOS 12.3+   | Intel x86_64  | Same as Apple Silicon    | Same behavior and acceptance thresholds   | Same                                                  | Same                                              | Same                             | Same                          | Same         | Same                                                    |
| Linux         | x86_64        | X11 baseline             | X11/XRandR or FFmpeg x11grab              | X11 implementation or explicit unsupported state      | X11 geometry                                      | PipeWire/PulseAudio/ALSA adapter | PipeWire/Pulse monitor source | V4L2         | X11 cursor adapter                                      |
| Linux         | x86_64        | Wayland baseline         | xdg-desktop-portal + PipeWire             | Portal-supported app/window selection where available | Portal-supported region selection where available | PipeWire/PulseAudio adapter      | PipeWire/Pulse monitor source | V4L2         | Portal/native cursor metadata or truthful degraded mode |

If a particular Linux compositor or desktop environment cannot satisfy a capability, the UI must show that capability as unavailable before recording starts. It must never return a fake display, fake device, zero-position cursor, or silent audio track while reporting success.

---

## 4. Current-state capability register

| Area                          | Current state                                                                               | Production gap                                                                | Priority |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------- |
| macOS source enumeration      | Hard-coded display data in the ScreenCaptureKit module                                      | Query actual shareable displays/windows and preserve native IDs               | P0       |
| macOS screen recording        | SCK worker creates an empty video placeholder; recorder uses a generic AVFoundation command | Stream real frames and honor display/window/region selection                  | P0       |
| macOS microphone/system audio | CoreAudio worker writes silence and is not used by `capture/session.rs`                     | Implement CoreAudio/SCK audio adapters and wire them into the recorder        | P0       |
| Linux source enumeration      | Single hard-coded 1920×1080 display                                                         | Enumerate real X11/Wayland sources and device capabilities                    | P0       |
| Linux screen recording        | Hard-coded `:0.0` X11 input                                                                 | Use session environment or portal/PipeWire; support real geometry             | P0       |
| Linux audio                   | Non-Windows WASAPI fallback writes silence; no Linux audio backend                          | Implement PipeWire/PulseAudio/ALSA selection and capture                      | P0       |
| Cursor telemetry              | macOS/Linux position, button, shape, and topology values are placeholders                   | Implement OS adapters and degraded-mode policy                                | P1       |
| Webcam                        | AVFoundation/V4L2 command paths exist                                                       | Validate formats, permissions, disconnects, and device IDs                    | P1       |
| Hardware encoders             | VideoToolbox is probed but not in default recording priority; VAAPI is absent               | Platform-aware encoder catalog and filter graphs                              | P1       |
| Permission handling           | macOS plist keys exist; Linux portal flow is absent                                         | Preflight, request, denial, retry, and diagnostics                            | P0       |
| Session integration           | `ActiveAudioCapture` is typed as WASAPI and always starts WASAPI                            | Replace with platform-neutral track interface                                 | P0       |
| Recovery                      | Shared recovery logic exists but real native tracks are not represented consistently        | Recover every finalized track and report incomplete tracks                    | P0       |
| CI                            | Windows, macOS, and Ubuntu compile/test jobs exist                                          | Add explicit Intel macOS, desktop-session, bundle, and runtime smoke coverage | P1       |
| Release                       | Release matrix has one generic `macos-latest` entry                                         | Decide separate versus universal macOS artifacts and validate sidecars        | P1       |

---

## 5. Architectural principles

### 5.1 One deep capture module behind a small interface

The recorder should not contain repeated `cfg` branches for every platform operation. Put the seam in the capture subsystem and keep platform complexity behind adapters.

Recommended internal interfaces:

```text
SourceProvider
  enumerate_sources() -> Result<Vec<CaptureSource>>
  refresh_source(source_id) -> Result<SourceSnapshot>
  check_permissions(request) -> Result<PermissionState>

VideoCaptureAdapter
  start_video(StartVideoRequest) -> Result<RunningVideoTrack>

AudioCaptureAdapter
  enumerate_devices() -> Result<Vec<AudioDevice>>
  start_audio(StartAudioRequest) -> Result<RunningAudioTrack>

CursorTelemetryAdapter
  check_health() -> CursorTelemetryHealth
  start_cursor(StartCursorRequest) -> Result<RunningCursorTelemetry>

EncoderCatalog
  probe() -> Result<Vec<EncoderInfo>>
  select(request) -> Result<SelectedEncoder>

SidecarProvider
  resolve_ffmpeg() -> Result<ResolvedSidecar>
  resolve_ffprobe() -> Result<ResolvedSidecar>
```

These are internal Rust interfaces. Their interface must include more than method signatures: source/device ID lifetime, permission requirements, timestamp origin, output ownership, stop behavior, error semantics, and whether a capability is unavailable or merely temporarily failing.

Use concrete platform adapters rather than exposing native framework types to the session coordinator. The production adapters should be selected at compile time where practical, with a small runtime capability layer for desktop-session and driver differences.

### 5.2 Production adapters and test adapters are different

- `WindowsCaptureAdapter`, `MacosCaptureAdapter`, `LinuxX11CaptureAdapter`, and `LinuxWaylandCaptureAdapter` interact with the operating system.
- `FakeCaptureAdapter` is allowed only in unit/integration tests and must be explicitly named as fake.
- No production fallback may use test-pattern video, silence, default fake devices, or a zero-coordinate cursor.
- If a platform capability is unavailable, return a typed `Unsupported` or `PermissionDenied` result and let the UI present an actionable state.

### 5.3 Track contract

Every running track must expose:

- `started_at: Instant` on the shared session clock.
- `request_stop()` that is non-blocking where possible.
- `stop()` that joins/flushes and returns track statistics.
- Output path or native writer handle owned by Rust.
- Actual format, sample rate, channel layout, frame rate, and encoder.
- Drop/underrun/error counters.
- Whether the track is complete, partial-but-recoverable, or failed.

The recorder session should own a collection of platform-neutral tracks. `ActiveAudioCapture` must not contain WASAPI-specific types.

### 5.4 Data contract changes

Replace stringly typed cross-platform values where they affect correctness:

- `CaptureSource.kind` should become a validated discriminated value.
- Device IDs should be opaque, namespaced by backend, and never assumed to be numeric or stable across reboots unless the backend guarantees it.
- Include `platform`, `backend`, `native_id`, `permission_state`, and `capabilities` in source/device snapshots.
- Record the selected backend and encoder in the manifest.
- Preserve enough metadata to explain a degraded recording during recovery.

Shared Zod contracts and Rust DTOs must be updated together with cross-language fixtures.

---

## 6. Target capture data flow

```text
React setup UI
  │  compact validated commands: enumerate, preflight, start, stop
  ▼
Rust recorder coordinator
  ├── SourceProvider ─────────────── display/window/region snapshot
  ├── Permission coordinator ─────── OS permission state/request
  ├── VideoCaptureAdapter ────────── encoded video track
  ├── AudioCaptureAdapter(s) ─────── microphone and system tracks
  ├── Webcam adapter ──────────────── separate timestamped camera track
  ├── CursorTelemetryAdapter ──────── metadata/events only
  ├── EncoderCatalog ──────────────── selected encoder/filter graph
  └── SessionWriter ───────────────── manifest, checkpoints, metrics
          │
          ├── immutable video/audio/camera assets
          ├── cursor telemetry assets
          ├── recovery manifest
          └── compact progress/state events

FFmpeg/FFprobe and native framework APIs remain behind Rust-owned adapters.
```

No raw sample buffers cross the React/Tauri boundary. Tauri events may publish state, progress, drop counts, permission changes, and user-facing error codes only.

---

## 7. Phased implementation roadmap

### Phase 0 — Freeze truth and establish the verification harness

### Phase 0 objectives

- Prevent synthetic behavior from being mistaken for support.
- Define the exact OS/session/hardware matrix before adding dependencies.
- Establish red tests and reproducible smoke commands before implementation.

### Phase 0 work items

- [ ] Change ADR 014 status to `Accepted — Partially implemented` until all production gates pass.
- [ ] Add a platform capability matrix to diagnostics and the release checklist.
- [ ] Record the supported macOS deployment target precisely: ScreenCaptureKit requires macOS 12.3 or newer.
- [ ] Decide the Linux release baseline: X11, Wayland, or both; supported desktop environments; PipeWire/PulseAudio requirements; V4L2 requirements.
- [ ] Define the macOS artifact strategy: separate Intel/Apple Silicon installers or a universal app.
- [ ] Add a test-plan document or section for real hardware/manual validation.
- [ ] Add a `NoSyntheticProductionFallback` policy test or code-review gate that rejects test-pattern/silence fallback in production adapters.
- [ ] Add deterministic fake adapters for unit tests so tests do not depend on the host OS.
- [ ] Capture baseline Windows recording metrics before refactoring.

### Phase 0 exit criteria

- Every declared capability has an owner, adapter, test level, permission requirement, and fallback policy.
- Existing synthetic tests are renamed or isolated so their scope is obvious.
- A real-device smoke-test checklist exists for macOS and Linux.

### Phase 0 dependencies

None. This phase must happen before native implementation work.

---

### Phase 1 — Contract, interface, and session refactor

### Phase 1 objectives

Create the seam that allows native platform implementations to be added without spreading platform conditionals through the recorder, commands, UI, and recovery code.

### Phase 1 work items

- [ ] Introduce platform-neutral source, device, permission, track, and capture-stat structures.
- [ ] Split `capture/source.rs` into shared source types and platform source providers.
- [ ] Replace `ActiveAudioCapture { kind: WasapiCaptureKind, session: WasapiCaptureSession }` with a platform-neutral audio track interface.
- [ ] Keep the current Windows WASAPI implementation behind the new interface without changing Windows behavior.
- [ ] Add typed errors for `Unsupported`, `PermissionDenied`, `DeviceUnavailable`, `InvalidSource`, `DriverUnavailable`, `EncoderUnavailable`, and `TrackStartFailed`.
- [ ] Make `RecordingManifest` persist platform/backend/capability/encoder metadata.
- [ ] Make `RecordingConfig` validate source and device IDs against a preflight snapshot rather than only checking that strings are present.
- [ ] Add Zod validation for all new command responses and events.
- [ ] Add unit tests for source/device ID mapping, lifecycle ordering, cleanup after partial startup, and unsupported capability behavior.
- [ ] Ensure failed audio startup cannot leave a running screen process or an apparently completed session.

### Phase 1 exit criteria

- Windows unit and integration tests pass unchanged or with intentional contract updates.
- The session coordinator has no direct WASAPI/CoreAudio/Linux-specific types.
- A fake adapter can run a complete start → pause/resume → stop → recovery test.
- No production path creates synthetic media when a native adapter is unavailable.

### Phase 1 dependencies

Phase 0.

---

### Phase 2 — Production macOS screen capture

### Phase 2 objectives

Implement real display, window, and region capture on macOS using ScreenCaptureKit, with source selection and permission handling that match the UI.

### Recommended implementation

Use a small native binding layer around the macOS ScreenCaptureKit framework. Evaluate maintained Rust Objective-C bindings against the macOS 12.3 deployment target; if they do not provide the required APIs safely, use a narrowly scoped Swift/Objective-C bridge compiled as part of the Tauri target. The bridge must expose only the capture operations needed by Rust and must not expose arbitrary Objective-C invocation to the frontend.

### Phase 2 work items

- [ ] Implement `SCShareableContent` discovery for displays, applications, and windows.
- [ ] Filter out recordForge-owned windows and apply stable source metadata.
- [ ] Map `SCDisplay`, `SCRunningApplication`, and `SCWindow` IDs to opaque `CaptureSource` IDs.
- [ ] Convert display point dimensions, pixel dimensions, scale factors, origin, and display arrangement correctly.
- [ ] Implement `SCContentFilter` for display, window, and region capture.
- [ ] Implement `SCStreamConfiguration` for requested dimensions, frame interval, pixel format, cursor policy, and excluded windows.
- [ ] Implement `SCStreamOutput` handling for video sample buffers on a dedicated queue.
- [ ] Choose and document the native frame sink:
  - preferred option: native VideoToolbox/AVAssetWriter path if it can produce recoverable fragmented output;
  - alternative: a Rust-owned native frame bridge to a supervised FFmpeg/native encoder path.
- [ ] Preserve the shared monotonic origin from the recorder coordinator.
- [ ] Handle stream start errors, permission denial, source disappearance, display sleep, and window closure.
- [ ] Ensure stopping drains the stream and finalizes the media container before the track reports success.
- [ ] Keep AVFoundation as a deliberate fallback only if it can honor the selected source. Never silently replace a selected window or region with the default camera/screen.
- [ ] Add explicit macOS permission preflight and request flow for screen recording.

### Phase 2 tests

- [ ] Unit-test source ID mapping and point-to-pixel coordinate conversion with Retina and mixed-scale fixtures.
- [ ] Unit-test display/window/region filter construction using fake shareable-content data.
- [ ] Run a real macOS smoke test that records a known moving visual pattern and verifies a non-empty, decodable video stream with expected dimensions and duration.
- [ ] Verify display selection, window selection, region selection, excluded recordForge windows, cursor policy, stop/finalization, and permission denial.
- [ ] Run the test on Apple Silicon and Intel macOS.

### Phase 2 exit criteria

- The output file contains real captured frames and passes FFprobe validation.
- A selected window or region is not replaced by the default AVFoundation input.
- Screen permission denial produces a recoverable UI error with a retry path.
- The same source-selection contract works on Intel and Apple Silicon.

### Phase 2 dependencies

Phase 1 and the native binding spike from Phase 0.

---

### Phase 3 — Production macOS audio, webcam, and cursor capture

### Phase 3 objectives

Implement real microphone/system-audio tracks and cursor metadata, then connect them to the macOS screen timeline.

### Phase 3 audio work items

- [ ] Enumerate actual CoreAudio devices using stable device IDs, names, input channel counts, nominal sample rates, and default-device state.
- [ ] Implement microphone capture using an AudioUnit or another supported CoreAudio input path.
- [ ] Use ScreenCaptureKit audio sample buffers for system audio where the selected capture filter and OS version permit it.
- [ ] Define behavior when system audio is unavailable or the app lacks screen-recording permission.
- [ ] Convert native sample formats to the project WAV/PCM contract without dropping timestamps.
- [ ] Track audio underruns, discontinuities, device removal, and sample-rate changes.
- [ ] Preserve separate microphone and system-audio assets; never merge them prematurely.
- [ ] Align tracks by the shared monotonic clock, then trim/pad only during finalization.
- [ ] Remove or quarantine the current CoreAudio silence worker.

### Webcam work items

- [ ] Keep AVFoundation webcam capture separate from screen capture.
- [ ] Use the AVFoundation device unique ID where available rather than relying only on enumeration indexes.
- [ ] Validate requested frame rate and resolution against supported camera formats before starting.
- [ ] Handle camera permission denial, camera busy, disconnect, and format negotiation failure.
- [ ] Record the actual selected camera ID and negotiated format in the manifest.

### Cursor work items

- [ ] Implement position capture using a supported CoreGraphics event/location API.
- [ ] Implement button-state capture only where macOS permissions and APIs make it reliable.
- [ ] Define whether accessibility permission is required for button/global input state.
- [ ] Implement standard cursor shape mapping where possible; otherwise use a documented standard-pointer fallback with `ShapesUnavailable` health.
- [ ] Convert macOS coordinate origin and Retina scaling into the capture source coordinate space.
- [ ] Make `check_cursor_capture_health()` actually test the selected adapter instead of unconditionally returning healthy.
- [ ] Never write `(0, 0)` as a successful cursor sample when the position is unavailable.

### Phase 3 tests and exit criteria

- [ ] Real microphone smoke test verifies a non-silent signal or known test tone and correct sample rate/channels.
- [ ] Real system-audio smoke test verifies a known playback signal appears in the system track.
- [ ] Verify microphone-only, system-only, both, and neither configurations.
- [ ] Verify A/V drift over 30 minutes is within the agreed threshold.
- [ ] Verify cursor movement and click events are represented correctly where permissions allow.
- [ ] Verify graceful degraded mode when cursor shape/buttons are unavailable.
- [ ] Verify camera capture and camera disconnect recovery.

### Phase 3 dependencies

Phase 1 and Phase 2. System audio depends on the ScreenCaptureKit permission and stream design.

---

### Phase 4 — Linux X11 production baseline

### Phase 4 objectives

Deliver a real Linux x86_64 X11 path before adding Wayland complexity. X11 support must use the session environment and real display topology rather than fixed values.

### Phase 4 source and video work items

- [ ] Detect and validate the active `DISPLAY` value; do not hard-code `:0.0`.
- [ ] Enumerate displays and geometry using XRandR/X11 or a trusted native provider.
- [ ] Preserve negative origins and multi-monitor arrangements in virtual-desktop coordinates.
- [ ] Enumerate windows through an X11/EWMH-compatible provider and record window IDs, titles, geometry, and visibility.
- [ ] Decide whether true window capture requires XComposite or whether initial X11 release explicitly limits window capture to a documented crop mode.
- [ ] Implement region capture using validated geometry and the selected display.
- [ ] If FFmpeg `x11grab` is used, verify the bundled sidecar contains the input device and pass the real display string and geometry.
- [ ] Hide or natively capture the cursor according to the cursor adapter policy.
- [ ] Handle X server loss, display changes, minimized windows, and invalid geometry.

### Phase 4 audio work items

- [ ] Prefer a PipeWire adapter when PipeWire is available.
- [ ] Support PulseAudio-compatible sources for common desktop environments, including monitor sources for system audio.
- [ ] Provide ALSA capture as a documented fallback for microphones where the device is directly exposed.
- [ ] Enumerate actual sources/sinks/monitor sources with stable opaque IDs.
- [ ] Validate that a requested source is an input/monitor before starting it.
- [ ] Capture microphone and system audio into independent tracks.
- [ ] Record backend, source name, sample format, rate, and underrun statistics.
- [ ] Fail clearly when a source is unavailable rather than producing silence.

### Webcam and cursor work items

- [ ] Enumerate V4L2 nodes and filter to nodes that support video capture, avoiding metadata-only nodes.
- [ ] Probe supported camera formats and negotiate a valid frame size/rate.
- [ ] Handle `/dev/video*` permissions and device removal.
- [ ] Implement X11 cursor position through a supported X11/XInput/XFixes path.
- [ ] Implement click state/events only when the selected X11 integration can provide them reliably.
- [ ] Store X11 display topology and coordinate transforms in cursor metadata.

### Phase 4 tests and exit criteria

- [ ] Run an X11 test job with a deterministic virtual display for geometry/source/provider tests.
- [ ] Run a real X11 smoke test on a Linux desktop or dedicated runner.
- [ ] Verify real video content, display selection, multi-monitor offsets, region geometry, and window behavior.
- [ ] Verify microphone, Pulse/PipeWire monitor, and ALSA fallback behavior separately.
- [ ] Verify V4L2 camera capture with at least one supported format.
- [ ] Verify device-loss and permission-denial errors are actionable.

### Phase 4 dependencies

Phase 1. Audio backend selection may require a dependency spike before implementation.

---

### Phase 5 — Linux Wayland and portal/PipeWire support

### Phase 5 objectives

Support modern Linux desktop sessions without bypassing Wayland security controls.

### Phase 5 work items

- [ ] Detect Wayland through the session environment and compositor capabilities.
- [ ] Integrate `org.freedesktop.portal.ScreenCast` for user-approved screen/application/region selection.
- [ ] Handle portal session creation, source selection, restore tokens where supported, PipeWire node negotiation, and session teardown.
- [ ] Consume the selected PipeWire stream inside the Rust-owned capture adapter or through a verified FFmpeg `pipewire` input path.
- [ ] Validate that the bundled FFmpeg sidecar has the required PipeWire input before advertising the backend.
- [ ] Map portal/PipeWire coordinates and scale factors into the shared source model.
- [ ] Define the window/region capability matrix per portal/compositor rather than claiming universal support.
- [ ] Integrate PipeWire audio sources and monitor sources with the same device contract used by X11.
- [ ] Implement camera access using V4L2 or the appropriate desktop permission mechanism.
- [ ] Define cursor behavior explicitly:
  - use portal cursor metadata or include the native cursor in the captured stream where available;
  - otherwise mark cursor telemetry unavailable and do not synthesize coordinates;
  - disable custom cursor replacement when its source data is not trustworthy.
- [ ] Handle user cancellation, portal denial, compositor restart, PipeWire node loss, and screen lock.

### Phase 5 tests and exit criteria

- [ ] Run integration tests on at least one GNOME/Wayland environment and one additional supported compositor where practical.
- [ ] Verify portal prompts and denial behavior manually.
- [ ] Verify display/application/region selection produces the selected content.
- [ ] Verify system audio and microphone tracks are real and independently synchronized.
- [ ] Verify the degraded cursor policy is visible in diagnostics and does not create misleading telemetry.
- [ ] Verify a Wayland failure never silently falls back to a fake display or X11 `:0.0`.

### Phase 5 dependencies

Phase 4 for shared Linux source/audio contracts; portal/PipeWire spike from Phase 0.

---

### Phase 6 — Platform-aware encoder catalog and FFmpeg integration

### Phase 6 objectives

Make encoder detection, recording selection, export settings, and filter graphs agree on what the current platform can actually execute.

### Phase 6 work items

- [ ] Split the encoder catalog into platform candidates and runtime-probed capabilities.
- [ ] Add macOS VideoToolbox recording priority only on macOS after a real probe succeeds.
- [ ] Add Linux `h264_vaapi` and validate the render node, pixel formats, driver, and permissions before selecting it.
- [ ] Retain Linux NVENC/QSV only when the actual driver and FFmpeg probe succeed.
- [ ] Keep `libx264` as the universal fallback and report when hardware acceleration was unavailable.
- [ ] Add platform-specific filter graphs, including required `hwupload`, `format`, and device options for VAAPI.
- [ ] Do not mark an encoder available based solely on its name appearing in `ffmpeg -encoders`; run a short initialization/encode probe.
- [ ] Apply one encoder policy to recording, proxy generation, and export, with codec-specific option validation.
- [ ] Ensure the selected encoder is recorded in the manifest and diagnostics.
- [ ] Add tests for unavailable drivers, unsupported pixel formats, hardware initialization failure, and fallback to software.

### Sidecar and packaging work items

- [ ] Keep Tauri `externalBin` entries generic and verify that target-triple-suffixed files are staged as Tauri expects.
- [ ] Make the FFmpeg setup script accept an explicit target when building universal or cross-target artifacts.
- [ ] Validate each sidecar with `-version`, `-devices`, `-filters`, and required encoder/input checks on the target runner.
- [ ] Verify execute permissions on macOS/Linux sidecars after extraction and packaging.
- [ ] Include required license/attribution metadata and pinned source checksums.
- [ ] Add architecture checks with `file`, `lipo -info`, or equivalent before publishing artifacts.

### Phase 6 exit criteria

- A hardware encoder is never selected unless a real initialization probe passes.
- A failed hardware path falls back to a tested software path with a visible diagnostic reason.
- macOS VideoToolbox and Linux VAAPI are covered by platform-specific tests and manual smoke runs.

### Phase 6 dependencies

Phases 2–5 for the real capture formats and platform device requirements.

---

### Phase 7 — Recorder session, synchronization, and recovery integration

### Phase 7 objectives

Connect all production adapters to one durable session lifecycle and guarantee useful recovery after interruption.

### Phase 7 work items

- [ ] Wire the selected platform adapters into `capture/session.rs`.
- [ ] Start screen, audio, webcam, and cursor tracks from one shared timeline origin.
- [ ] Start independent microphone and system-audio tracks without blocking one another unnecessarily.
- [ ] On partial startup failure, stop every already-started track and persist a failed/recoverable manifest.
- [ ] On normal stop, stop sources, flush encoders, finalize tracks, FFprobe every asset, align durations, and only then mark the session complete.
- [ ] On pause/resume, create independently recoverable segments with explicit segment ownership and offsets.
- [ ] Persist actual track metadata, backend errors, dropped frames, audio underruns, and permission state.
- [ ] Make recovery repair WAV/container metadata and retain every finalized valid track.
- [ ] Ensure a silent real-world input is distinguishable from a synthetic silence fallback; no fallback may be reported as a successful capture.
- [ ] Add device-loss behavior: stop or mark the affected track incomplete, notify the user, and preserve other valid tracks.
- [ ] Verify cursor telemetry health affects export behavior; unavailable data must not create a fake overlay.

### Phase 7 exit criteria

- A normal recording produces decodable video, microphone/system audio, webcam, and cursor assets as requested.
- A failed optional track is reported without corrupting the screen track.
- A forced exit preserves all finalized segments and produces an actionable recovery result.
- A/V drift remains within the agreed budget over the long-run test.

### Phase 7 dependencies

Phases 1–6.

---

### Phase 8 — UI, diagnostics, and permission truthfulness

### Phase 8 objectives

Make the UI accurately reflect platform capability and make failure recovery understandable.

### Phase 8 work items

- [ ] Replace fake/default audio devices with real enumerated devices or an explicit empty/error state.
- [ ] Show platform/backend and permission status before enabling Start.
- [ ] Add actionable links/instructions for macOS screen, microphone, camera, and accessibility permissions.
- [ ] Add Linux session/backend diagnostics: X11/Wayland, display, portal, PipeWire/PulseAudio, V4L2, and render-node availability.
- [ ] Show whether cursor telemetry is full, degraded, or unavailable.
- [ ] Expose selected encoder and fallback reason without exposing secrets or raw media paths.
- [ ] Ensure every async device/capability surface implements loading, content, empty, and error-with-retry states.
- [ ] Ensure denied permission, disconnected device, and unsupported compositor states are not represented as successful default devices.
- [ ] Keep platform-specific shortcut labels correct while avoiding platform-specific assumptions in recording behavior.
- [ ] Add completion/failure feedback for permission requests, capture startup, device loss, and finalization.

### Phase 8 exit criteria

- Users can determine why a capability is unavailable before starting.
- No UI label claims native support unless the backend capability probe confirms it.
- All background capture failures produce a visible error or jobs-drawer entry.

### Phase 8 dependencies

Phases 1–7.

---

### Phase 9 — CI, integration testing, packaging, and release qualification

### 9.1 CI matrix

Update `.github/workflows/ci.yml` and `.github/workflows/release-desktop.yml` to validate the actual release matrix:

- [ ] Windows x86_64.
- [ ] macOS Apple Silicon using an explicit arm64-capable runner.
- [ ] macOS Intel using `macos-15-intel` or the currently supported Intel label.
- [ ] Ubuntu/Linux x86_64.
- [ ] X11 source/audio smoke environment.
- [ ] Wayland portal/PipeWire smoke environment, using a dedicated/self-hosted runner if hosted runners cannot provide a reliable desktop session.

Every platform job should include:

- [ ] Rust format and clippy checks.
- [ ] TypeScript typecheck, lint, format, and tests.
- [ ] Platform-specific Rust compilation.
- [ ] FFmpeg sidecar architecture and capability checks.
- [ ] Unit tests with fake adapters.
- [ ] Integration tests that do not require a physical desktop.
- [ ] Real desktop smoke tests where the runner can grant permissions and provide a display/audio session.
- [ ] Full `tauri build` or equivalent bundle validation, not only `cargo build --release`.

### 9.2 Test layers

#### Pure unit tests

- Source/device ID parsing and namespacing.
- Coordinate transforms, Retina scaling, negative monitor origins, and crop bounds.
- Audio sample conversion and WAV finalization.
- Timeline alignment and drift calculations.
- Encoder candidate selection and fallback rules.
- Permission-state transitions.
- Manifest/recovery state machine.

#### Fake-adapter integration tests

- Start/stop ordering.
- Optional-track failure and cleanup.
- Pause/resume segmentation.
- Forced-exit recovery.
- Device loss.
- No-synthetic-fallback policy.
- Cross-language contract fixtures.

#### Real macOS tests

- Display/window/region capture.
- Screen permission denial and re-request.
- Real microphone and system audio.
- Camera permission/device capture.
- VideoToolbox initialization.
- Intel and Apple Silicon architecture checks.
- Cursor movement/click/shape behavior or documented degraded mode.

#### Real Linux tests

- X11 display/window/region capture.
- Wayland portal/PipeWire capture.
- Microphone and system monitor sources through PipeWire/PulseAudio/ALSA as applicable.
- V4L2 camera capture and device permissions.
- VAAPI probe and software fallback.
- Cursor support and Wayland degraded behavior.

### 9.3 Media assertions

A capture test must not stop at “file exists.” It should verify, as applicable:

- FFprobe can open every requested output.
- Video stream has expected codec, dimensions, frame rate, and non-zero duration.
- Audio stream has expected sample rate/channels and valid duration.
- Audio content is not unintentionally constant zero data when a known signal is being played.
- Multiple tracks have independent roles and matching timeline metadata.
- Cursor telemetry contains changing coordinates when the test moves the cursor, or explicitly reports unavailable.
- Stop/finalization leaves no orphan process.
- Recovery can open every finalized asset after simulated interruption.

### 9.4 Release artifacts

- [ ] Decide and document separate versus universal macOS artifacts.
- [ ] If separate: clearly name Intel and Apple Silicon artifacts and publish both.
- [ ] If universal: build and validate both native app binaries and sidecars, then combine only through a reproducible `lipo`/universal process.
- [ ] Verify DMG/app, DEB/AppImage, and Windows bundles on clean machines or clean VM images.
- [ ] Verify runtime sidecar resolution from installed resource directories.
- [ ] Verify signatures, updater metadata, public-key configuration, and artifact checksums.
- [ ] Retain test logs and FFmpeg capability reports with release evidence.

### Phase 9 exit criteria

- All required jobs pass on the exact release commit.
- Both macOS architectures have a tested artifact or the universal artifact passes architecture inspection.
- Linux X11 and the declared Wayland support level pass their smoke gates.
- No release artifact contains synthetic capture behavior.

### Phase 9 dependencies

Phases 0–8.

---

## 8. Platform implementation details and decisions

### 8.1 macOS decisions

- ScreenCaptureKit is the primary display/window/region implementation.
- ScreenCaptureKit is also the preferred system-audio source when the selected stream supports audio.
- CoreAudio is the microphone/device implementation.
- AVFoundation remains the webcam implementation and may be a narrowly scoped screen fallback only when source selection is explicit and verified.
- macOS privacy permission denial must be surfaced before the recording command starts.
- The app must support both `aarch64-apple-darwin` and `x86_64-apple-darwin`.
- A macOS “native” label must not be emitted by a module that only writes placeholders or calls a generic default FFmpeg input.

### 8.2 Linux decisions

- X11 is the first Linux implementation because it permits direct display/window topology queries and predictable test environments.
- Wayland must use the desktop portal and PipeWire rather than attempting to bypass compositor security.
- PipeWire is the preferred modern audio/session backend; PulseAudio compatibility and ALSA are explicit fallbacks with capability detection.
- V4L2 remains the webcam backend, with actual capture-node capability checks.
- VAAPI is selected only after both FFmpeg and the render device/driver pass a real probe.
- Wayland cursor telemetry is capability-dependent. If the compositor/portal does not provide trustworthy cursor data, native cursor inclusion or disabled custom cursor rendering is preferable to fake telemetry.
- Linux x86_64 is the initial release architecture. ARM Linux is deferred until sidecars, dependencies, and performance are deliberately added.

### 8.3 Cross-platform fallback policy

Fallback order must be capability-driven and recorded:

```text
requested capability
  ├── permission denied       -> actionable PermissionDenied
  ├── backend unavailable     -> try documented compatible backend
  ├── all backends unavailable -> Unsupported/DeviceUnavailable
  └── capture starts          -> persist selected backend and actual format
```

The following are prohibited in production:

- Returning a fake 1920×1080 display.
- Returning a fake “Default Microphone” or “System Audio” device.
- Writing silence as a substitute for a requested real audio track.
- Incrementing a frame counter without writing captured frames.
- Recording `(0, 0)` cursor samples while reporting healthy telemetry.
- Falling back from a selected window/region to an unrelated default device.

---

## 9. Synchronization and quality budgets

Set final thresholds during Phase 0, then enforce them in Phase 7 and Phase 9. The following are proposed starting budgets:

| Metric                     | Proposed gate                                                              |
| -------------------------- | -------------------------------------------------------------------------- |
| 1080p30 recording duration | 30 minutes on each declared desktop baseline without unrecoverable failure |
| Long-run recording         | 120 minutes using the tested fallback path                                 |
| A/V drift                  | ≤ 40 ms over 30 minutes; investigate any monotonic drift                   |
| Video drops                | < 1% under the agreed baseline workload; report actual counts              |
| Audio underruns            | Zero unrecovered underruns in a normal 30-minute run                       |
| Stop finalization          | All requested tracks FFprobe-valid before success state                    |
| Crash recovery             | Every finalized segment recoverable after forced process termination       |
| Startup                    | Permission/device/encoder failure reported within the startup timeout      |
| Memory                     | No unbounded buffer growth; record peak RSS in the baseline report         |
| Disk safety                | Preflight estimate plus active low-disk cancellation/recovery path         |

The budgets must be measured separately for hardware and software encoding and for X11 versus Wayland where both are supported.

---

## 10. Security and privacy requirements

- [ ] Keep raw frames and PCM in Rust/native capture paths only.
- [ ] Validate every source/device identifier before passing it to native APIs or FFmpeg.
- [ ] Treat device names and window titles as untrusted display data; do not use them as shell command strings.
- [ ] Keep FFmpeg invocation argument-based; never construct a shell command line.
- [ ] Keep Tauri capabilities narrow; native screen/audio permissions are not a reason to add arbitrary filesystem or shell permissions.
- [ ] Do not log raw media, audio samples, credentials, complete OAuth tokens, or unnecessary absolute paths.
- [ ] Redact device/source details in exported diagnostics where they can identify private applications or hardware.
- [ ] Ensure permission requests and portal handles are not persisted as secrets.
- [ ] Preserve the updater signature and sidecar integrity requirements.
- [ ] Test denial and partial-permission states as security and correctness cases, not only UX cases.

---

## 11. Proposed module/file impact map

The exact names may change during the design spike, but responsibilities should remain localized.

### Existing modules to refactor

- `apps/desktop/src-tauri/src/capture/session.rs`
  - Replace WASAPI-specific session ownership with platform-neutral track interfaces.
- `apps/desktop/src-tauri/src/capture/source.rs`
  - Keep shared source DTOs and delegate enumeration to platform providers.
- `apps/desktop/src-tauri/src/capture/audio/mod.rs`
  - Become the audio adapter seam and platform selector.
- `apps/desktop/src-tauri/src/capture/audio/wasapi.rs`
  - Preserve Windows implementation behind the shared interface.
- `apps/desktop/src-tauri/src/capture/audio/coreaudio.rs`
  - Replace synthetic worker with real CoreAudio implementation or remove it until ready.
- `apps/desktop/src-tauri/src/capture/screencapturekit.rs`
  - Replace synthetic discovery/stream worker with native bindings and writer.
- `apps/desktop/src-tauri/src/capture/ffmpeg.rs`
  - Split command construction by validated backend/source rather than fixed platform branches.
- `apps/desktop/src-tauri/src/capture/devices.rs`
  - Add real Linux audio/source capability enumeration and camera validation.
- `apps/desktop/src-tauri/src/capture/cursor_v2.rs`
  - Delegate OS reads to cursor adapters and report real health.
- `apps/desktop/src-tauri/src/capture/encoder.rs`
  - Add platform-aware candidates and actual hardware probes.
- `apps/desktop/src-tauri/src/capture/manifest.rs`
  - Persist backend, permission, format, and degraded-state metadata.
- `apps/desktop/src-tauri/src/capture/recovery.rs`
  - Recover multiple platform-specific track types consistently.
- `apps/desktop/src-tauri/src/capture/config.rs`
  - Validate capability-aware source/device selections.
- `apps/desktop/src-tauri/src/commands/recording.rs`
  - Return truthful capability/permission errors and validated DTOs.
- `.github/workflows/ci.yml`
  - Add architecture/session/runtime gates.
- `.github/workflows/release-desktop.yml`
  - Add explicit Intel/ARM release strategy and artifact checks.
- `tooling/ffmpeg/setup.mjs`
  - Add explicit target support and sidecar capability verification.
- `apps/desktop/src-tauri/tauri.conf.json` and `Info.plist`
  - Keep package metadata aligned with the final permission and artifact strategy.

### Proposed new implementation areas

```text
apps/desktop/src-tauri/src/capture/
  platform.rs              # platform capability and adapter selection
  traits.rs                # small internal interfaces and track contracts
  permissions.rs           # normalized permission states and errors
  source_provider.rs       # shared source-provider seam
  audio/
    mod.rs                 # shared audio contract
    wasapi.rs              # Windows adapter
    macos.rs               # CoreAudio/SCK adapter
    linux.rs               # PipeWire/PulseAudio/ALSA adapter
  video/
    mod.rs                 # shared video contract
    windows.rs             # Windows adapter/fallbacks
    macos.rs               # ScreenCaptureKit adapter
    linux_x11.rs           # X11 adapter
    linux_wayland.rs       # portal/PipeWire adapter
  cursor/
    mod.rs                 # shared cursor contract
    windows.rs
    macos.rs
    linux_x11.rs
    linux_wayland.rs
  native/
    macos_bridge/          # only if bindings require a small bridge
    linux_portal/          # portal/PipeWire integration if not delegated to a crate
```

The goal is locality: a macOS framework change should stay in the macOS adapter and its focused tests, not require edits across the session coordinator, UI, and every media command.

---

## 12. Risks and decisions requiring explicit approval

| Decision                     | Options                                                                                  | Recommended default                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| macOS native binding         | Maintained Rust Objective-C bindings; Swift/Objective-C bridge; FFmpeg-only limited path | Spike bindings first; use a narrow bridge if required                          |
| macOS video writer           | Native VideoToolbox/AVAssetWriter; native capture feeding FFmpeg                         | Prefer native writer if recoverability and integration are proven              |
| Linux screen scope           | X11 only; X11 + Wayland portal                                                           | Ship X11 first, then portal-backed Wayland with explicit capability limits     |
| Linux audio backend          | Native PipeWire; FFmpeg Pulse/PipeWire; ALSA fallback                                    | PipeWire/Pulse adapter with ALSA microphone fallback                           |
| Wayland cursor               | Portal metadata; native cursor in stream; disable custom cursor                          | Prefer trustworthy native/portal cursor; otherwise degrade explicitly          |
| macOS distribution           | Separate Intel/ARM installers; universal app                                             | Separate artifacts initially; universal only with reproducible sidecar process |
| Native versus FFmpeg webcam  | Native framework; FFmpeg device input                                                    | Keep FFmpeg initially, but validate device IDs/formats and lifecycle           |
| Unsupported feature behavior | Hide feature; disable with explanation; fail at start                                    | Disable before start and provide permission/backend remediation                |
| CI hardware                  | Hosted runners; self-hosted physical machines                                            | Hosted compile/unit gates plus dedicated runtime hardware for release          |

No implementation phase should silently resolve one of these decisions by adding another placeholder.

---

## 13. Definition of done

The macOS/Linux expansion is production-ready only when all of the following are true:

### Functional

- [ ] Real display capture works on macOS and Linux for the declared session types.
- [ ] Selected window and region behavior is honored or explicitly marked unsupported.
- [ ] Real microphone and system-audio tracks are captured independently.
- [ ] Webcam capture works with permission and device-loss handling.
- [ ] Cursor behavior is accurate or clearly degraded without fake telemetry.
- [ ] Pause/resume, stop, recovery, editing, and export work with all requested track combinations.

### Correctness and reliability

- [ ] A/V drift and dropped-frame budgets pass.
- [ ] Every successful recording passes FFprobe validation.
- [ ] Forced-exit recovery preserves all finalized assets.
- [ ] Device/permission/backend failures clean up processes and produce actionable errors.
- [ ] No production path writes synthetic video/audio as a success result.

### Security and privacy

- [ ] IPC and device/source inputs are validated.
- [ ] Tauri capabilities remain least-privilege.
- [ ] Logs and diagnostics are redacted.
- [ ] Native permission denial paths are tested.
- [ ] Sidecars are pinned, architecture-correct, executable, and integrity-checked.

### Testing and release

- [ ] Unit, fake-adapter, platform compile, and real hardware smoke suites pass.
- [ ] macOS Intel and Apple Silicon artifacts are both validated.
- [ ] Linux X11 and the declared Wayland support level are validated.
- [ ] Full Tauri bundles are built and inspected on target runners.
- [ ] Clean-machine installation and first-run permission flows pass.
- [ ] ADR 014, README claims, diagnostics, and release notes match the measured capability matrix.

---

## 14. Suggested execution order

```text
Phase 0: truth + harness + decisions
    ↓
Phase 1: platform-neutral contracts and session seam
    ├── Phase 2: macOS ScreenCaptureKit video
    │      ↓
    │   Phase 3: macOS audio/webcam/cursor
    └── Phase 4: Linux X11 video/audio/camera/cursor
           ↓
        Phase 5: Linux Wayland portal/PipeWire

Phases 2–5
    ↓
Phase 6: encoder, sidecar, and package qualification
    ↓
Phase 7: session/recovery integration
    ↓
Phase 8: truthful UI and diagnostics
    ↓
Phase 9: CI, hardware QA, and release qualification
```

Windows should remain green after every phase. The first production milestone should be a **real macOS recording vertical slice** and a **real Linux X11 recording vertical slice**, each with screen + microphone + stop/finalize + FFprobe validation. Wayland and advanced cursor support should then be added without weakening the truthfulness policy.

---

## 15. Deferred work

The following should remain deferred until the core platform paths are real and stable:

- Linux ARM64 artifacts.
- Universal macOS packaging if separate artifacts meet the release need.
- Advanced cursor-shape reconstruction on platforms that do not expose trustworthy shape data.
- Full compositor-specific window semantics on every Wayland environment.
- Additional native capture backends not required by the declared matrix.
- Performance optimizations that are not supported by measured profiling.

A deferred capability must be represented as deferred, not implemented through a synthetic placeholder.
