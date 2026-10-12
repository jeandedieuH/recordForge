# Spec 004 — Recording Modes

> **Status:** Implemented — camera-only recording mode (M1–M4)
> **Scope:** Documents the camera-only recording mode end to end: tiers, the
> capture planner, session semantics, diagnostics, library integration, the
> setup/HUD UX, and editor defaults. Screen/window/region capture remains the
> primary mode described by the capture state machine spec.

---

## 1. Overview

RecordForge supports four primary capture source kinds: `display`, `window`,
`region`, and `camera`. A camera-source recording (`source.kind === "camera"`)
captures a webcam directly as the session's **primary** video stream — not as
a sidecar PiP — producing one `output.mp4` with muxed microphone audio. It is
the "talking head" mode: no screen, no cursor, no smart-zoom metadata.

---

## 2. Camera tiers

Camera recordings choose a quality tier instead of a screen profile. Tiers
are defined in `cameraTiers` (`packages/contracts/src/recording.ts`), mirrored
1:1 by `camera_profiles()` in Rust and pinned by
`tooling/fixtures/camera-tiers.json` so the two languages cannot drift.

| Tier id           | Label        | Output budget | fps | Intent                              |
| ----------------- | ------------ | ------------- | --- | ----------------------------------- |
| `camera-low`      | Low Impact   | 1280×720      | 30  | Battery/low-end machines            |
| `camera-balanced` | Balanced     | 1920×1080     | 30  | Default                             |
| `camera-high`     | High Quality | 1920×1080     | 30  | Higher nominal bitrate              |
| `camera-ultra`    | Ultra        | 3840×2160     | 30  | Devices that negotiate 4K           |

Each tier carries an id, an output budget (never upscaled past the negotiated
mode), a nominal bitrate set, and a usage intent. The tier's budget bounds
the encode; the negotiated camera mode fills it as far as the device allows
(`limitedByCamera` marks the shortfall).

---

## 3. Capture planner

`capture::camera_plan` (`src-tauri/src/capture/camera_plan.rs`) turns a tier +
the device's advertised modes (`webcam::probe_camera_modes`) into an ordered
list of `CameraCapturePlan` attempts:

- **Ranking** is by *fitted output* area, not input area — a USB2 raw
  1080p@5 MJPEG-less mode loses to a 720p@30 mode because slideshow frame
  rates are unusable for primary capture (`fps_floor = min(target, 24)`).
- **Fit modes** describe how input frames map to the output: `Native` (exact
  match, no scale), `Scale` (aspect-preserving scale), `Letterbox`
  (scale + pad to a locked size — used when a resume forces the first
  segment's geometry), and `Adaptive` (device-defaults clamp that never
  upscales).
- **Device-defaults fallback** is always the last attempt (`input: None`) so
  startup succeeds even when no advertised mode fits; the plan is bounded to
  `MAX_MODE_ATTEMPTS = 4` like the sidecar path.
- **Output lock** (`CameraOutputLock`): once segment 0 commits to a
  size/rate, resumed segments are forced to the same geometry so pause/resume
  fragments stay stream-copy-concat compatible.
- `limitedByCamera` reports when the device cannot fill the tier budget on
  both axes — a 4:3 output filling the budget height is *not* limited.

The plan is surfaced to the UI via `plan_camera_tiers` and the contract
`cameraCapturePlanSchema`.

---

## 4. Session semantics

- **Primary capture = camera.** `is_camera_source(config)` flips the session
  into the camera path: the camera feed is written to `output.mp4` as the
  main video; microphone audio is muxed in as usual.
- **No screen sidecars.** Camera sessions produce no `cursor_events.bin`,
  `cursor_telemetry.json`, `webcam*.mp4` sidecar, keystroke capture, or
  smart-zoom suggestion seed — there is no cursor to record.
- **Preview modes are self-view.** `webcamPreviewMode` (`off`/`low`/
  `standard`) becomes the presenter self-view quality rather than a PiP
  preview.
- **Pause/resume** concatenates matching segments under the output lock.
- **Disk guard.** Camera recordings refuse to start with less than **1 GiB**
  free on the sessions volume (`ensure_camera_disk_space`); an unreadable
  stat degrades to "unknown" rather than blocking.
- **Finalization** is shared with screen recordings: probe output, generate
  `poster.jpg` thumbnail from `output.mp4`, insert the library row.

---

## 5. Status & diagnostics

- `RecordingStatus.sourceKind === "camera"` while a camera session is live.
- Per-segment capture diagnostics land under the **camera slot**:
  `captureSegmentDiagnostics.camera` carries the primary capture's encoder,
  backend, startup readiness, and `cameraFirstFrameOffsetMs` /
  `cameraTimingRejection` A/V-alignment correlation; `screen` stays `None`.
- The manifest persists `source` (a `captureSourceSchema` with
  `kind: "camera"` + tier bounds) and the tier name in `profileName`.

---

## 6. Library integration

- **Naming.** Camera sessions insert as `Camera <sessionId8>` instead of
  `Recording <sessionId8>` (`database/library.rs`), for completed and
  recovered sessions alike.
- **Dimensions.** The row first stores the tier budget, then is overwritten
  with the *probed* output geometry at finalize — the negotiated mode can be
  smaller than the tier budget.
- **Thumbnails.** `poster.jpg` is generated from `output.mp4` by the shared
  finalization path — camera recordings need no special handling.
- **Badge.** Library cards and rows show a neutral `Camera` badge (Video
  icon) for `source.kind === "camera"`; the editor's media panel shows the
  same badge as the source type.

---

## 7. Recording UX (M3)

- **Setup stage.** The new-recording modal's source switcher offers a Camera
  mode with its own stage (`camera-stage.tsx`): device picker, per-tier plans
  from `plan_camera_tiers` (probed per device, 60 s cache), framing guide,
  and live self-view (`use-camera-preview`).
- **Self-view & states.** Preview degrades through explicit states — denied
  permission, no camera, preview-unavailable-but-recordable.
- **HUD.** While recording, the floating HUD shows a mic level meter
  (`hud-mic-meter`) and camera-specific warnings (`use-hud-warnings`).
- **Titlebar split button.** The record titlebar exposes a split
  screen/camera start action.
- **Camera defaults settings.** A "Camera defaults" card in Settings
  (`camera-defaults-card.tsx`) holds the preferred tier/device defaults.

---

## 8. Editor defaults (M4)

`createTimelineFromRecording` branches on `recording.source.kind === "camera"`:

- The primary screen-kind track is named **"Camera"** (kind stays `screen`;
  export treats it identically). No camera clip or cursor track is created.
- Canvas defaults: `padding: 0`, `borderRadius: 0`, `shadow: false` — full
  bleed. The default background is kept (invisible at padding 0, still
  user-changeable).
- `cameraSyncOffsetMs` applies to the **audio clips** (there is no camera
  clip): `startMs = max(0, offset)`, `sourceInMs = min(clipDuration, |offset|)`
  when negative, `sourceOutMs = sourceInMs + clipDuration`. The calibration
  semantics "positive = video delayed" read as "audio delayed" when video is
  the fixed primary. Screen recordings keep the offset on the camera sidecar
  clip.
- The **Cursor** task is hidden in the editor task rail; a persisted
  selection shows a not-applicable panel. The Smart Zoom card explains that
  camera recordings have no cursor telemetry; manual zoom still works
  (focus falls back to canvas center).
- `initializeSmartZoom` with `telemetry = null` early-returns — camera
  projects get no generated zoom segments.
