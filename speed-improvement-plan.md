---
agent: devin-local
session: tangy-makemake
created: 2026-10-25T10:46:20Z
---
# RecordForge performance plan: recording to export

A phased plan to make RecordForge faster from stop to export. It starts with a measurement baseline and parity gates, then makes low-risk FFmpeg-graph fixes, restructures the cursor/overlay plate transport and zoom, cuts stop-to-editor latency, adds GPU-first capture paths, and ends with a native wgpu export compositor (FFmpeg keeps decode/encode).

## 1. How the pipeline works today (what I studied)

**Capture** (`capture/ffmpeg.rs`, `capture/session.rs`)
- Windows: ddagrab → either the zero-copy `scale_d3d11` → NVENC/AMF/MF path (`gpu_screen_filter`, ffmpeg.rs:1508-1536) or `hwdownload,format=bgra` → CPU scale/pad → encoder (ffmpeg.rs:1579-1585). The GPU path is used only when the source aspect matches the profile exactly and the encoder is NVENC/AMF/MF. Fallback is gdigrab.
- macOS: ScreenCaptureKit hands **BGRA** frames to a pipe, then FFmpeg rawvideo → swscale → VideoToolbox (macos_sck.rs:269,413). Linux: PipeWire BGRx over a pipe, or x11grab.
- Audio is native (WASAPI/CoreAudio/PipeWire) and written to WAV. Recordings use a 1 s GOP (`-g fps`, ffmpeg.rs:1659) and fragmented MP4 segments.

**Stop → editor ready** (session.rs:2240-2350, capture/media/mod.rs, jobs/mod.rs:1380-1824)
1. Each segment: mux the WAVs into AAC with the video stream-copied, using `+faststart` (a full rewrite of the file). The WAVs are then deleted.
2. `finalize_webcam_asset`: always a **full webcam re-encode**, run *before* screen assembly, sequentially (media/mod.rs:206-251).
3. `concatenate_segments`: a single segment is handled with **`fs::copy`** (a full file copy); multiple segments go through concat with `+faststart` again.
4. Probe and poster frame.
5. Prepare job, all stages sequential: thumbnail sprite (**decodes every frame** and the `fps` filter drops most of them), then per audio stream an AAC→WAV extract plus a **second decode** for the waveform.

**Export** (`exports/mod.rs`, 13k LOC)
- `run_render_plan` → `render_timeline_composition_shared` → single pass or chunked (≥20 s and ≥4 cores; `workers = cores/2` clamped, NVENC capped at 3).
- One FFmpeg `filter_complex` per pass. It contains:
  - per-segment trim/setpts/scale/pad/fps/tpad;
  - a background plate;
  - rounded corners via `format=rgba` + `alphamerge`;
  - `zoompan`;
  - camera overlays (full-canvas RGBA shadow plate, mask, border);
  - privacy masks, libass captions, keystrokes;
  - the encoder.
- Cursor, overlay items and keystrokes are rasterized in Rust (tiny-skia), packed side by side into one **RGBA rawvideo stream on stdin**, then split and cropped in the graph. FFmpeg auto-converts each plane RGBA→YUVA before `overlay`.

## 2. Measured baseline and root causes

From `docs/benchmarks/export-plate-crops.md` and `tooling/benchmarks/out/synth/*.log`: a 30 s 1080p30 fixture with zoom, corner radius, shadow, cursor, titles and captions, on the i5-11400H / RTX 3050 laptop.

| Run | Wall time | Plate bytes | Notes |
|---|---|---|---|
| Single pass | 36.6 s (0.93x realtime) | 10 992 MiB (≈12.2 MB/frame) | `write_ms` ≈ feed time, so the feed is consumer-bound |
| Chunked w6 | 34.4 s | 8 068 MiB | chunk p50 ≈ 14 s for 75 frames; machine CPU-saturated |

Findings, each backed by code or measurement:

1. **The cursor plane is the whole fitted screen rect** (mod.rs:4445-4459). That is ~7.5 MB/frame at 1080p for a ~32 px cursor. Rust fills a canvas-size pixmap, crops it, scans it to unpremultiply, and packs it (mod.rs:4763-4791, 4583-4605). FFmpeg then converts and blends the whole plane every frame.
2. **`zoompan` allocates and initializes a new SwsContext on every output frame**, single-threaded bicubic. It does this even at zoom=1 (I checked upstream `vf_zoompan.c` `output_single_frame`). `has_zoom` is plan-wide (mod.rs:2155), so every frame of every pass goes through it once any zoom exists.
3. **Rounded corners force two full-frame colorspace conversions per frame**: screen → `format=rgba` → `alphamerge`, then RGBA → YUVA inside `overlay` (mod.rs:2409-2418, 2445-2451). The benchmark fixture uses a radius.
4. **The camera shadow is a canvas-size RGBA plate** blended every frame while the camera is visible (mod.rs:2722-2729).
5. **Chunking can't fix a CPU-saturated pipeline.** Roughly 0.45 CPU-seconds per frame are spent, so the only real lever is less work per frame. Separately, the NVENC cap of 3 is outdated: GeForce drivers allow 8 sessions since driver 551 and 12 since driver 591.
6. **A hardware-encoder failure re-runs the whole export in software** (mod.rs:1049-1092). It is only probed at startup, with generic settings.
7. **The harness always uses libx264** (mod.rs:1251, 1269). The benchmarks don't reflect the GPU-first target.
8. `CursorRenderer` derives `Clone` but shares `Arc<Mutex<CursorEngine>>`. All producer workers and chunk passes therefore serialize on one engine lock. The comment in `OverlayWorkerState` is stale. This is a small cost, but per-frame evaluation should be precomputed anyway (needed for 2.1).
9. The stop path writes the screen file about 4 times (capture, mux, faststart, copy). The webcam re-encode runs serially before screen assembly, and prepare decodes the media 3+ times.

## 3. Plan

Priority follows the GPU-first decision: Phase 0 runs first; Phase 1 and the Phase 5 G0 spike run in parallel. How deep Phase 2 goes is decided after the G0 result, because Phase 2 becomes the CPU/no-GPU fallback path.

### Phase 0: Measurement and guardrails (prerequisite)
- **0.1 Harness encoder override.** Add `encoder: "auto"|"software"|"nvenc"|"qsv"|"amf"|"videotoolbox"|"vaapi"` to `ExportHarnessSpec` (mod.rs:1199). Resolve it through `encoding::resolve_export_encoder` with the capture-side probe.
- **0.2 Ablation matrix.** Extend `tooling/benchmarks/export-synth-spec.ts` to emit these variants: plain, +radius, +shadow, +zoom, +cursor, +items, +camera, +captions, +all. Produce each at 30 s and 5 min, and for software and NVENC. `export-bench.ts` reports the marginal cost of each feature.
- **0.3 Producer breakdown.** Split `raster_ms` in `feed_cursor_frames` into cursor / items / keys / pack / convert.
- **0.4 Stop-path and prepare spans.** Log `elapsed_ms` per step (webcam finalize, mux, concat/copy, probe, poster, each prepare stage) plus `time_to_editor_ms`.
- **0.5 Capture overhead.** Use the existing `capture/benchmark.rs` / `metrics.rs` to record CPU%, dropped frames and backend (`ddagrab-gpu` vs `ddagrab-cpu`) for display, window and region at 1080p30 and 1440p60.
- **0.6 Parity gate.** Add `tooling/benchmarks/parity.ts`, built on the index-paired PSNR recipe in the `testing-recordforge-export` skill. It checks:
  - exact frame count (`nb_read_frames == ceil(duration*fps/1000)`);
  - mean PSNR ≥ 50 dB and per-frame minimum ≥ 45 dB against stored baseline renders of each ablation spec;
  - seam checks for chunked output.
- **0.7** Record results in `docs/benchmarks/perf-baseline-<date>.md`.

### Phase 1: Export quick wins (low risk, FFmpeg path)
- **1.1 Window-local zoom.** Decide whether a pass needs zoom by sampling `camera::evaluate_zoom_transform` on every frame of the window. A pass only needs zoom if some frame's transform is not identity, which covers bridged shots, follow mode and motion plans. Snap chunk boundaries (`render_timeline_chunked`, mod.rs:3813-3820) to the edges of zoomed regions so zoom-free chunks drop `zoompan` entirely. The cursor is unaffected because it evaluates the camera independently.
- **1.2 Corner patches instead of RGBA alphamerge.** Overlay the opaque screen on the background in yuv420. Then overlay 4 small, precomputed corner plates: the background crop with alpha = 1−mask, cached in `PlateCache`, sized radius×radius. This removes two full-frame swscale passes per frame. Fallback: `format=yuva420p` + `alphamerge` (no RGB round trip) when the layout varies (side-by-side windows).
- **1.3 Crop the camera shadow plate** to its blur bounding box and overlay it at (x,y) (`generate_camera_shadow_plate_png`, mod.rs:2060-2083). Keep loop branches bounded: the eof_action=repeat duplicate-frame regression described in the skill must stay fixed.
- **1.4 NVENC chunk cap** 3 → 8 (env-overridable). Keep the existing session-failure fallback. Measure it, because NVENC engine throughput is shared across sessions.
- **1.5 Encoder pre-flight at exact geometry.** Before the full render, run a 2-frame test encode with the real `-s/-pix_fmt/-r/codec` arguments (~200 ms). On failure, start in software instead of retrying after a full failed render.
- **1.6 Bound single-pass audio inputs** with `-t` (and `-ss` with an atrim offset when `source_in` is large), mirroring the chunked audio pass (mod.rs:1863-1890 vs 3947-3956).

### Phase 2: Export structural work (FFmpeg path; becomes the no-GPU fallback)
- **2.1 Cursor tile plane positioned with `sendcmd`.**
  - Precompute per-frame cursor evaluation and drawn bounds (new `CursorRenderer::frame_bounds`, evaluation only).
  - Tile size = max bounds over the window, rounded up to even + margin.
  - Render into the tile with an origin offset (new `render_frame_at_offset`, with `ClipRect`, including corner radius, translated). Choose even tile origins (overlay snaps to the chroma grid) and keep the subpixel offset inside the tile.
  - Emit a `sendcmd` script driving `overlay@cursor x/y`, only when the position changes. Upstream `overlay` supports `x`/`y` commands (verified).
  - `sendcmd` scans every interval on every frame (verified in `f_sendcmd.c`), so cap pass length (≤60 s windows, sequential when not parallel) to bound N.
  - Spotlight keeps the full-rect mode.
  - Expected result: cursor bytes −95%+, much less raster/scan/pack work, and far less FFmpeg convert+blend.
- **2.2 RGBA→YUVA420P in Rust, shipping `yuva420p`.** Convert in the producer workers (BT.601 limited, matching swscale's default for the untagged screen chain; check the stream's color tags first), folding the unpremultiply step into the same pass. This means 37.5% fewer bytes and no auto-inserted single-threaded swscale per plane. Plane packing offsets must be even. Gated by the 0.6 parity check.
- **2.3 Piecewise zoom graph (spike first).**
  - Classify output frames into: identity (passthrough); hold (fixed integer crop w/h; per-frame x/y expressions for follow modes; then `crop` + `scale=...:flags=bicubic:threads=auto` with a cached context); transition (`zoompan`, or crop/scale via commands).
  - Join the pieces with `split` + `trim=start_frame/end_frame` + `concat`.
  - Interval values come from Rust (`evaluate_zoom_transform` + `zoompan_integer_crop`), which also removes the deep-expression `MAX_DEPTH` risk.
  - The spike must show: PSNR ≥ 45 dB against `zoompan`, cursor registration tests passing unchanged, and a measured speedup. If parity fails, keep `zoompan` for transitions only.
- **2.4 Retune chunking** after 2.1–2.3: `workers`, minimum chunk length (to amortize per-process cost), `plate_divisor`, `pass_threads`. Re-measure on the ablation matrix.
- **2.5 (Deferred / optional)** Hoist static items: send long unchanged display-list spans as looped PNG overlays with `enable` windows. Phase 5 makes this unnecessary, so only do it if the fallback path still needs it.

### Phase 3: Stop-to-editor latency
- **3.1 Parallel finalize.** Run `finalize_webcam_asset` on a thread alongside concat, probe and poster (session.rs:2250 vs 2292). Join before the manifest write that needs the webcam path.
- **3.2 Fewer full-file passes.**
  - Single segment: mux straight into `output.partial.mp4` with faststart and rename it; no `fs::copy` (media/mod.rs:49-55).
  - Multiple segments: drop `+faststart` from the per-segment mux, since the concat applies it.
  - Remove the duplicate `sync_file` calls.
  - Check that recovery never needs a finalized segment file (`capture/recovery.rs`).
- **3.3 Webcam stream copy (design spike).**
  - When every webcam segment shares codec parameters, stream-copy via the concat demuxer. Represent the signed start offset in the project's camera clip (`output_start`/`source_in`) instead of baking it in with `tpad`/`trim`.
  - Mismatched segments keep the current re-encode.
  - Needs confirmation that project creation, the preview and export plans all honor a camera clip offset.
- **3.4 Parallel prepare stages.** Run thumbnails, webcam thumbnails and audio extract/waveform as concurrent FFmpeg processes (jobs/mod.rs:1681-1792), within the existing worker/resource gate.
- **3.5 Keyframe-only thumbnails.** Use `-skip_frame nokey` (+ `-hwaccel auto`) when the effective interval is ≥ the source GOP (recordings: 1 s). Keep the full decode for short clips (500 ms minimum interval) and for imported assets with an unknown GOP. Check the timestamps in the manifest against UI expectations.
- **3.6 One decode per audio stream.** Write the WAV, then compute peaks in Rust from that WAV (or use two FFmpeg outputs) instead of a second decode in `waveform.rs::extract_peaks`.
- **3.7 (Optional)** Write the aligned native WAV as an extra output of `mux_audio_tracks` and keep it as the audio derivative. Prepare then skips AAC→WAV, and the audio stays lossless.

### Phase 4: Capture overhead (GPU-first)
- **4.1 Aspect-preserving output dimensions** so windows and regions qualify for the zero-copy `scale_d3d11` path (ffmpeg.rs:1527-1528). Risk check: cursor telemetry mapping, the letterbox assumptions in `build_aspect_fit_filter` (P0.5), editor canvas fit from probed dimensions, and recovery.
- **4.2 QSV zero-copy path** (ddagrab → `hwmap=derive_device=qsv` / `scale_qsv`, or D3D11 frames straight into `h264_qsv`). Spike on the baseline machine's Intel UHD iGPU with the pinned FFmpeg 9.0.1.
- **4.3 macOS: NV12 at output size from ScreenCaptureKit** (GPU scaling, `420v`) instead of full-resolution BGRA. That is 62.5% fewer pipe bytes and no swscale. FFmpeg then reads rawvideo `nv12` straight into VideoToolbox. Check that `screencapturekit` 11 exposes the format, and handle bi-planar packing in `pack_*`.
- **4.4 CPU fallback.** Add `threads` to scale/convert at ≥1440p or ≥60 fps, and feed `nv12` to hardware encoders.
- **4.5 Linux PipeWire.** Prefer NV12/I420 in format negotiation when the compositor offers it (low priority).

### Phase 5: Native GPU export compositor (wgpu); FFmpeg stays the decode/encode sidecar
- **Architecture:**
  - **Decode:** FFmpeg sidecar processes with `-hwaccel auto`, reusing today's per-segment trim/setpts/fps/tpad chains. They output rawvideo NV12 on stdout, which keeps frame-exactness parity.
  - **Rust scheduler → wgpu render thread:**
    - YUV→RGB.
    - Fit and zoom sampling from the `camera.rs` integer-crop math.
    - SDF rounded corners.
    - Background and shadow plate textures.
    - Camera: mask, border, shadow.
    - Blur, pixelate and redact shaders.
    - Cursor tile, items and keys rasterized by the *same* tiny-skia code and uploaded as textures; items are cached per display-list hash.
  - **RGB→NV12** compute shader, then an async readback ring (3–4 frames).
  - **Encode:** FFmpeg reads rawvideo NV12 on stdin, plus the existing single-pass audio render. Burn-in captions use the `subtitles` filter (libass parity), along with chapters, faststart, hvc1 and the output cap.
  - The existing validation runs at the end.
- **Selection:** add `ExportSettings.renderer = auto|gpu|compatibility`. `auto` picks GPU when the adapter is real hardware (not WARP/llvmpipe/SwiftShader) and every feature in the plan is supported. Otherwise it uses the FFmpeg path (Phases 1–2). If the device is lost mid-render, retry on the FFmpeg path, mirroring today's hardware→software retry. Licensing gates are unchanged (enforced in Rust, cap at the final stage). GIF/WebP stay on FFmpeg.
- **Code location:** `apps/desktop/src-tauri/src/exports/gpu/{mod,decode,scheduler,compositor,readback,encode}.rs` plus `shaders/*.wgsl`, hooked in at `render_timeline_composition_shared`. New ADR `docs/adr/018-gpu-export-compositor.md`. It adds the `wgpu` dependency (pin a version published at least 7 days ago) and no new Tauri capabilities. ADR 004 still holds.
- **Milestones and gates:**
  - **G0 spike:** passthrough + zoom at 1080p30. Target ≥4x realtime with NVENC on the RTX 3050 and PSNR ≥45 dB against the FFmpeg path. **Below 2x → stop and re-plan.**
  - **G1:** background, fit, corners, shadow, zoom, cursor, items.
  - **G2:** camera, masks, keystrokes, side-by-side layout windows.
  - **G3:** captions, chapters, HEVC, output cap, selected range.
  - **G4:** parity suite across the ablation matrix; ships behind the setting, off by default.
  - **G5:** `auto` turns GPU on by default once the parity and failure-rate gates hold.
- **Known limits:** pipe throughput is ~3.1 MB/frame at 1080p NV12, which is fine. 4K tops out at ~100 fps over pipes; D3D11/Metal interop is future work.

## 4. Files to modify (main ones)
- `apps/desktop/src-tauri/src/exports/mod.rs`: harness encoder, window-local zoom, corner patches, shadow crop, pre-flight, audio bounds, cursor tile + `sendcmd`, YUVA transport, piecewise zoom, chunk retune, GPU dispatch.
- `apps/desktop/src-tauri/src/exports/cursor.rs`: `frame_bounds`, `render_frame_at_offset`, per-window evaluation precompute.
- `apps/desktop/src-tauri/src/exports/camera.rs`: per-frame transform classification and interval extraction.
- `apps/desktop/src-tauri/src/exports/encoding.rs`: pre-flight probe args.
- `apps/desktop/src-tauri/src/exports/gpu/**` (new), `Cargo.toml` (wgpu).
- `apps/desktop/src-tauri/src/capture/session.rs`, `capture/media/mod.rs`, `capture/recovery.rs`: finalize parallelism, rename, faststart, webcam copy.
- `apps/desktop/src-tauri/src/jobs/mod.rs`, `media/thumbnails.rs`, `media/waveform.rs`, `media/audio.rs`: parallel prepare, keyframe thumbnails, single-decode audio.
- `apps/desktop/src-tauri/src/capture/ffmpeg.rs`, `capture/macos_sck.rs`, `capture/linux_pipewire.rs`: GPU and NV12 capture paths.
- Frontend: export renderer setting (`apps/desktop/src/features/export/**`, `packages/contracts` schema).
- `tooling/benchmarks/*` (ablation, parity), `docs/benchmarks/*`, `docs/specs/media-jobs-render-plan.md` §5, `AGENTS.md` (new commands/stack).

## 5. Verification
- Per change:
  - `cargo test -j 1 exports::` (156+ tests, including chunked end-to-end);
  - `cargo test --features native-render` in `packages/overlay-engine`;
  - `cargo fmt --check` and `cargo clippy -- -D warnings`.
- Export behavior: harness specs from the ablation matrix (software + NVENC). The harness's built-in `validate_export_output` must pass. Run `parity.ts` (frame count exact, PSNR ≥50 mean / ≥45 min). For chunked output, check per-chunk `nb_read_frames` and seams (from the skill; includes the 30 s/8-core regression of 113/109 frames).
- New unit tests:
  - per-frame zoom classification;
  - tile bounds always cover every drawn pixel (raster the full rect vs the tile at matching offset → identical pixels);
  - `sendcmd` script generation (times, even origins);
  - RGBA→YUVA against FFmpeg reference frames;
  - corner-patch composite against an alphamerge reference.
- Stop path: existing live/synthetic capture tests (`cargo test -j 1 ... -- --ignored` for the live ones) plus the new `time_to_editor_ms` spans. Recovery tests in `capture/recovery.rs` still pass.
- Benchmarks: rerun `bun run --cwd tooling/benchmarks benchmark:export` before and after each phase, and record the results in `docs/benchmarks/`.
- Whole repo: `bun run check`.

## 6. Expected impact (hypotheses; Phase 0 confirms or corrects them)
| Item | Expected effect on the 30 s fixture |
|---|---|
| 1.1 window-local zoom | removes `zoompan` cost outside zoomed regions (often 60–80% of frames) |
| 1.2 corner patches | removes 2 full-frame swscale passes per frame |
| 2.1 cursor tile | plate bytes from ~12 MB to ~5 MB per frame; large drop in raster and blend work |
| 2.2 YUVA transport | a further −37.5% plate bytes; no per-plane swscale |
| Phases 1–2 combined | likely 2–4x faster than 0.93x realtime on CPU-bound machines |
| Phase 5 GPU compositor | target ≥4x realtime at 1080p30 on GPU machines |
| Phase 3 | stop-to-editor ≈ max(webcam, screen) instead of the sum; fewer full-file writes; prepare up to several times faster on long recordings |

## 7. Risks and considerations
- **Parity:** Rust color conversion, the piecewise zoom and GPU sampling can shift pixels. All of it is gated by 0.6; cursor registration must stay exact (`zoompan_integer_crop` contract, spec §5.3).
- **`sendcmd` per-frame cost grows with the number of intervals.** Pass windows must stay bounded. Confirm all command behavior on the **pinned FFmpeg 9.0.1** (not just upstream master).
- **Frame-exactness / seam regressions:** new `loop`/overlay branches must stay bounded (the known duplicate-frame bug).
- **GPU variance:** adapter and driver bugs and device loss → auto fallback plus telemetry-free logging (no media paths, per security rules).
- **The webcam stream-copy (3.3) and aspect-preserving capture (4.1) change data-model assumptions.** Each needs its own design check before implementation.
- **Security:** no new Tauri capabilities. Temp files (sendcmd scripts, corner plates) go into the existing `STALE_EXPORT_TEMP_PREFIXES` sweep and temp guards.
