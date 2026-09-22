---
name: testing-recordforge-export
description: How to exercise recordForge's real timeline export/render path end-to-end on a dev box without the full Tauri UI (bun/node_modules/dist may be absent) — temporary Rust shim + JSON-spec harness binary, media generation with lavfi frame counters, and how to verify chunked/parallel export output integrity (frame-exactness, seams, chapters, faststart).
---

# Testing recordForge exports end-to-end without the app UI

## When to use

Verifying changes in `apps/desktop/src-tauri/src/exports/mod.rs` (e.g. `run_render_plan`, chunked/parallel rendering, mux, chapters, captions) when the desktop UI can't be run — e.g. no bun, no `node_modules`, no frontend `dist`, or constructing a ≥20s multi-element project via UI is impractical.

## Approach: temporary shim + harness binary (blessed fallback)

The full export entry (`export_timeline` Tauri command) needs an AppHandle, SQLite rows, and a work dir. Instead add a **temporary** pub shim inside `exports/mod.rs` that calls the real render entry point directly:

- `pub fn devin_test_render(ffmpeg_path, output_path, plan, project_id, asset_paths, settings, cancel, on_progress, ffprobe_path, force_single_pass)` — for chunked-dispatcher changes, call `render_timeline_composition(...)`; for the single-pass baseline call `render_composition_window(CompositionWindow::full(plan), CompositionPass::standalone(), ...)`. Both are private — the shim must live *inside* `exports/mod.rs`.
- `pub unsafe extern "C" fn devin_render_spec(spec_ptr, spec_len) -> i32` — deserializes a JSON spec (the same serde types `export_timeline` receives: `RenderPlan`, `ExportSettings`, asset-id→path map). Init `tracing_subscriber` with EnvFilter default `info` so the real `info!` log lines are visible on stderr.
- `src/bin/chunked_harness.rs` — thin driver: `chunked_harness.exe <spec.json>` → calls `devin_render_spec`, returns its code.

Build: `cargo build --lib --bin chunked_harness` — works even though `cargo test` fails to link on this box (the GNU-ld ordinal issue is **test-profile only**; cdylib+bin build fine).

**Rust commands need** `export PATH="/c/ch/bin:/c/Users/Administrator/tools/mingw64/bin:$PATH"`.

## ffmpeg/ffprobe resolution gotcha (Windows)

`crate::media::resolve_executable` scans `target/debug/` *first* — chocolatey **shimgen stubs** `target/debug/ffmpeg.exe`/`ffprobe.exe` exist, spawn OK, then exit 127 (`Cannot find file ...`). Symptoms: `probe render asset for stream selection failed` or ffmpeg exiting instantly. **Fix:** pass explicit paths in the spec to the real binaries: `C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/{ffmpeg,ffprobe}.exe`. This is a dev-environment artifact, not a product bug.

## Media generation (self-identifying frames!)

Generate sources with **burned-in frame counters + timecodes** so every output frame self-identifies its source index — makes seam/dup/drop bugs trivially provable:

```
ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=32" -f lavfi -i "sine=frequency=440:duration=32" \
  -vf "drawtext=text='F%{n}':fontsize=96:fontcolor=white:x=20:y=20:box=1:boxcolor=black@0.7,drawtext=text='%{pts\:hms}':fontsize=48:x=20:y=140:fontcolor=yellow" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest screen.mp4
```

Read F-numbers by extracting frames (`-vf "select='between(t,11.24,11.45)',crop=W:H:x:y,scale=...:flags=neighbor"`) and viewing them.

## Verifying chunked/parallel export

Expected math on an 8-core box (`workers = cores/2` clamped 2..4 → 4; `chunk_frames = max(ceil(total/8), 2*fps)`):
- 30s@30fps → 900 total frames, chunk_frames=113 → 8 chunks at boundaries 113,226,339,452,565,678,791.
- Confirm chunking via: log line `export: rendering timeline in parallel chunks chunks=8 workers=4`, `%TEMP%/recordforge_chunks_{project}_{uuid}/chunk_NNNNN.mkv`, and `export: chunked render muxed`.

Correctness checklist:
- `-count_frames` → `nb_read_frames` == `ceil(duration_ms*fps/1000)` exactly.
- format duration within ~250ms of plan.
- streams: v=h264 canvas size/fps; a=aac ≈duration.
- `-show_chapters` for chapter_mode=embed; moov before mdat for faststart (`-v trace` atom order).
- **Per-chunk frame counts**: capture `recordforge_chunks_*` mid-run (poll %TEMP% every ~20ms and copy new `.mkv` — they persist until job end; also grab `rf-filter-complex-*.txt` filter scripts). `ffprobe -count_frames` each `chunk_*.mkv` — any count ≠ expected frames for its window is a defect.
- **Seam integrity**: extract ±1-frame windows at each boundary and read F-numbers; look for duplicated frames (same F at consecutive pts), missing frames, or freezes. Also compare `chunk_N_last.png` vs `chunk_N+1_first.png` (PSNR ~inf = true duplicate).
- Audio: `volumedetect` on ±0.2s windows straddling boundaries (sine → mean_volume ≈ -21dB, not -91dB silence).

## Pitfalls hit during PR #5 testing

- **Captions burn-in escaping**: `subtitles=filename='C\\:/path'` (double backslash from `escape_filter_path` in `exports/captions.rs`) fails to parse on ffmpeg 8.1.2 — "No option name near ...". `filename='C\:/path'` (single backslash) works. Verified identical failure on single-pass → pre-existing bug, not chunked-specific.
- `select` filter `n` indexes the decode-order stream; use `between(t,...)`/`eq(t,...)` (pts-based) or `showinfo` for unambiguous frame↔pts mapping on files with B-frames.
- `-f framemd5` without `-map`/`-an` includes audio packets — filter to `^0,` lines.
- Grouped `cd X && cmd > log &` backgrounds the whole chain; use absolute paths.
- MSYS2 `/tmp` ≠ Windows `C:/tmp` — ffmpeg reads Windows paths inside filter scripts.
- PNG sequence output needs `%d` pattern or `-update` flag.

## Known-good repro for the boundary-dup bug (PR #5 — fixed in 5c6be54)

A camera/overlay element **spanning a chunk boundary** caused one chunk to emit a duplicated final frame (total 901 vs 900). Repro: 30s plan, overlay [6800,8600)ms crossing boundary 7533ms → `chunk_00002.mkv` had 114 frames instead of 113. Overlay fully inside a chunk → clean. Zoom-only and plain-segment plans → clean.

Root cause was `overlay eof_action=repeat` on the camera shadow/border `loop=-1` secondaries leaking an extra tail frame; fixed by `trim=end_frame={window.frame_count}` on the windowed pass's final stream. **Keep this as a regression test**: if a future change removes the cap or adds another unbounded overlay branch, the 114th frame comes back — check `nb_read_frames` per `chunk_*.mkv` (expect 113/109 on the 30s/8-core math above).

## Devin secrets needed

None — all local tooling.
