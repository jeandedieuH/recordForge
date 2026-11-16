# ADR 021: On-Device ML Runtime and Camera AI

## Status

Accepted — 2026-11-16. Extends ADR 013 (asset derivatives), ADR 016
(entitlements) and ADR 020 (GPU-first effects and downgrade reporting).

## Context

M4 adds four camera features:

1. colour grade with bundled and user `.cube` LUTs (Free),
2. portrait cutout with a replaceable background (Pro),
3. face-tracked framing (Pro),
4. hide the camera during silence (Pro).

Cutout and face tracking need inference, and the product is local-first: no
frames, mattes or face data may leave the device. Bundling ONNX Runtime and
~26 MB of weights in every installer would be wasteful for a Pro-only feature
that many users never enable, and inference during export would make export
time depend on model speed.

## Decision

### 1. Runtime and model delivery (mirrors `whisper.rs`)

- **`ort` 2.0.0-rc.15 with `load-dynamic`.** The crate is linked without an
  ONNX Runtime library; the native runtime is downloaded into
  `<app_data>/ml/runtime/` and loaded with `ort::init_from(path)`.
- **Pinned ONNX Runtime 1.31.0**, one archive per platform
  (Windows x64/ARM64, Linux x64/ARM64, macOS ARM64). Each archive's SHA-256 is
  compiled in and verified before extraction; a mismatch deletes the download.
- **Pinned models** (SHA-256 verified on download):
  - **MODNet Webcam** (`modnet_webcam.onnx`, 25,969,398 B, Apache-2.0) for the
    portrait matte. It is trained for webcam framing, ships as ONNX with a
    dynamic input shape, and replaces the planned MediaPipe TFLite segmenter
    (which would have required a conversion pipeline before every release).
  - **YuNet 2023mar** (`face_detection_yunet_2023mar.onnx`, 232,589 B, MIT)
    from OpenCV Zoo, pinned to commit `f12e1279…`.
- `RECORDFORGE_ORT_DYLIB` overrides the runtime path for development builds.
  URLs are pinned and the bytes are hash-checked, so a moved tag cannot change
  what the app runs.

### 2. Execution providers

`ort::init_from` is called once per process. The environment requests
DirectML (Windows) or CoreML (macOS) first and retries with the CPU provider
when the loaded runtime cannot register it. The Microsoft `win-x64` GitHub
archive is CPU-only; users who want DirectML can point
`RECORDFORGE_ORT_DYLIB` at a DirectML build. Intel macOS has no pinned 1.31
archive, so the UI reports Camera AI as unsupported there.

### 3. Inference is an offline derivative job

A new `camera_ai` job decodes the camera stream once with FFmpeg at a 512-px
short side, runs the matte model on every frame and YuNet at ~8 Hz, and writes:

- `<work_dir>/derivatives/camera_ai/stream_NNN/matte.mp4` — grayscale H.264 at
  the camera frame rate, temporally EMA-smoothed and guided-filter refined at
  full working resolution;
- `<work_dir>/derivatives/camera_ai/stream_NNN/face_track.json` — face boxes
  in camera source pixels (sample time + confidence).

The job is cancellable, reports progress, and caches by deterministic path.
**Export never runs inference**: it consumes the matte and face track.

Each run is also a durable `media_jobs` row (`kind: "camera_ai"`) keyed by the
UI's job id. Progress/stage updates and the completed matte/face-track paths are
persisted there (and registered as `derivatives` rows), so the shared jobs
surface sees the work, cancellation survives a view change, and a startup sweep
fails a row interrupted by an app exit. The in-memory camera-AI registry is only
the busy gate and cancel channel that owns the decoder/encoder children; the
SQLite row is the durable record.

### 4. Colour is one composed table

`overlay-engine/src/color.rs` is the single source of truth. It parses `.cube`
files (2…65³, finite 0…1 values), generates seven bundled procedural looks, and
composes adjustments ∘ LUT ∘ intensity into one 33³ table.

- Export writes the table as a `.cube` and applies
  `lut3d=interp=tetrahedral` inside the camera decode chain, so both renderers
  match.
- The preview calls the same code compiled to WASM (`camera_lut_texture`) and
  uploads the RGBA8 table as a WebGL2 3D texture. No second LUT implementation
  exists.
- User `.cube` files are project assets (`role: "lut"`, `kind: "lut"`),
  validated at import time and revalidated on the render plan.

### 5. Cutout and face-tracked framing at export

- The camera decode chain mirrors the matte chain (same trims, fps and crop),
  alpha-merges them, applies `none`/`blur`/`color`/`image` background inside the
  same FFmpeg graph, and emits `yuva420p`.
- The GPU compositor gains a real alpha plane: camera quads created with
  `alpha = true` sample a full-resolution R8 plane in `layer.wgsl` (format 1),
  so cutout bubbles composite correctly over animated layouts and b-roll. The
  compatibility renderer overlays the same RGBA stream.
- Face tracking is resolved in `editor-core/face-crop.ts` with a One-Euro
  filter and emitted as ≤10 Hz `cropKeyframes`. Both renderers drive a named
  `crop` filter through `sendcmd`, and the preview applies the same resolver to
  its CSS crop.
- Hide-during-silence reuses Smart Cut's analysed ranges and replaces only
  `source: "silence"` camera-layout segments in one undoable command.

### 6. The preview composites the cutout

`camera-preview.tsx` plays the finished matte on a second dual-slot video pair
synced to the same source time as the camera track, and `camera-lut-canvas.tsx`
samples camera + matte + LUT in one WebGL2 pass:

- the shader applies the renderer's alpha math (`edgeShrink` shifts the matte
  luma, `edgeSoftness` blurs it) and composites `none` (transparent over the
  screen), `blur` (9-tap disc blur of the graded camera), `color`, or `image`
  (cover-fitted, asset resolved through the project registry) backgrounds;
- the plain `<video>` surfaces are hidden while the canvas draws, and the canvas
  reproduces the CSS framing (`object-cover` without a crop, `object-fill` with
  one) so grading and cutout stay aligned;
- the exact background paint and blur kernel remain the exporter's; the preview
  approximates the box blur and is not a pixel-parity reference.

Until a matte exists the preview keeps the plain camera frame; the inspector
shows matte readiness and offers Generate matte, so the export is never the
first place a missing matte appears.

### 7. Entitlements

Cutout, face tracking and hide-during-silence are Pro keys
(`camera-cutout`, `face-tracking`, `hide-during-silence`) enforced in Rust at
export admission and mirrored in `editor-core/pro-features.ts`. Colour grading,
`.cube` import, 720p/24-60 fps, borders, speed, b-roll and custom tracks remain
Free. Free "export without Pro" disables cutout/face tracking, keeps their
settings for upgrade, and drops generated silence layouts.

### 8. Security review

- **No new Tauri capability.** Model/runtime downloads use the existing Rust
  `reqwest` client, not the webview. Model files live under the app-data dir;
  mattes and face tracks under the project work dir.
- Download URLs are HTTPS and pinned; every artifact is SHA-256 verified before
  use. A failed model download is deleted so status never reports it as ready.
- The render plan carries `cutout.mattePath` as an absolute path. Admission
  canonicalizes it and rejects anything outside the recording work dir, so a
  crafted plan cannot read arbitrary files.
- `.cube` import is bounded (8 MB), parsed in Rust, and rejected on malformed
  or non-finite values.
- No screen, camera frame, matte or face sample is logged. Inference is local.

## Consequences

- Installers stay small; the first use of cutout/face tracking downloads
  ~26 MB (matte), ~230 KB (face) plus the ~11–37 MB runtime.
- Export speed is unchanged for plans without camera AI, and unchanged with it
  because inference is precomputed.
- CPU inference is the default on Windows; DirectML is opt-in through a custom
  runtime build. Face tracking and matte quality are model-bound and offline.
- The editor previews the colour grade, face-tracked crop, and the cutout with
  its background mode in WebGL2 from the same matte the export consumes. The
  preview's blur kernel and edge softening are close approximations rather than
  pixel parity; the exported file stays authoritative.
- Camera-AI runs are durable `media_jobs` rows, so progress and cancellation
  behave like every other media job and a row interrupted by an app exit shows
  as failed instead of silently disappearing.
- Intel macOS has no Camera AI runtime until a pinned x64 build is published.
- Older app versions strip the new optional camera fields on save, as with
  every optional project-v1 addition; release notes call this out.
