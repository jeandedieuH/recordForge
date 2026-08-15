# Hardware-accelerated export + single-pass render + hardware proxy

Three coordinated changes: (A) hardware encoders for export, (B) merge the two export FFmpeg passes into one, (C) hardware encoders for proxy generation. All reuse the existing detection/selection infrastructure from the capture side — no new Tauri commands or capabilities.

## A. Hardware encoder preference for export

**Contract** (TS → Rust in lockstep):
- `packages/contracts/src/timeline.ts` `exportSettingsSchema`: add `encoder: z.enum(["auto", "software"]).default("auto")`. Auto = best available hardware encoder, falling back to software. (Per-vendor selection is deliberately out of scope; "software" is the escape hatch for users who need x264/x265 quality.)
- `apps/desktop/src-tauri/src/exports/mod.rs` `ExportSettings`: add `encoder: String` with `#[serde(default = "default_export_encoder")]` ("auto") — serde default keeps old persisted job `options` JSON parsing; extend `validate_export_settings` to whitelist the two values.

**New module `exports/encoding.rs`:**
- `ExportEncoder` enum: `Software | Nvenc | Qsv | Amf | Mf`.
- `resolve_export_encoder(preference, codec, available, ffmpeg_path)`: software when forced; else first available of nvenc → qsv → amf → mf (matching `select_best_encoder` priority). H.264 uses the cached startup detection. HEVC hardware (`hevc_nvenc`/`hevc_qsv`/`hevc_amf`) is **not** in the startup probe list, so when codec=hevc + auto, verify the candidate with a one-shot `probe_encoder` (expose `capture/encoder.rs::probe_single_encoder` as `pub(crate)`) at export-job start; fall back to `libx265` if it fails.
- `append_export_video_args(command, settings, encoder, fps)`: replaces `append_video_encoding_args`. Software branch keeps today's exact preset/CRF mapping. Hardware branches map export presets to per-encoder quality args (NVENC `-preset p4/p5/p7 -tune hq -rc vbr -cq N -b:v 0`; QSV `-preset … -global_quality N` (+`-look_ahead 1` h264); AMF `-quality quality -rc cqp -qp_i/-qp_p`; MF `-rate_control quality` + bitrate safety) — exact flags verified against the pinned FFmpeg 9.0 sidecar (`ffmpeg -h encoder=…`) during implementation. `-r` and `-pix_fmt yuv420p` stay common. `validate_export_output` already passes since NVENC/QSV/AMF output still probes as `h264`/`hevc`.

**Threading detection to the job path:**
- `capture/session.rs`: add `pub fn available_encoders(&self) -> &[String]` getter.
- `jobs/mod.rs`: `JobManager::new` takes `available_encoders: Vec<String>` (constructed in `commands/recording.rs::init` right after `Recorder::new`); `ExportWorker::run` passes it into `run_render_plan` (one new parameter).

**UI:** `export-view.tsx` — "Encoder" select next to codec: *Auto (hardware when available)* / *Software (x264/x265)*, with a hint line showing the detected hardware encoder name when available. Data from the existing (currently unused) `recorder-store.loadEncoders`, invoked on app-shell mount. `timeline-store.ts`: `setExportEncoder` mirroring `setExportCodec`. Design tokens only; hint renders only when detection data is present.

## B. Single-pass export (merge cursor overlay into composition)

`render_frame` is a pure function of `output_ms` + plan (confirmed — it never reads the pass-1 file), and the existing pass 2 already streams RGBA via stdin, so:

- Move renderer construction out of `apply_cursor_overlay` into a helper `build_cursor_renderers(plan, asset_paths, project_id)` called from `render_timeline_composition`.
- When renderers exist: append a rawvideo input after the asset inputs (`-f rawvideo -pix_fmt rgba -s WxH -r fps -i -`, input index = asset count), and append `[composed][N:v]overlay=shortest=1:format=auto[vout]` as the final video filter — same overlay semantics as today (the `ceil(duration×fps)` ±1 frame discrepancy is absorbed exactly as the current pipe-closed logic does).
- Generalize `run_ffmpeg_command` into a shared runner with (a) an optional stdin frame-feeder closure (keeps the per-frame cancel check + broken-pipe tolerance) and (b) optional real progress: parse `time=` from stderr like `media::run_ffmpeg_with_progress` does, mapping to the 0.15→0.80 range with the existing 250 ms throttle pattern. Without renderers it behaves like the old pass 1.
- Delete `apply_cursor_overlay`, `cursor_partial_output_path`, and the dead `render_timeline_with_audio`. `cleanup_export_files` still removes legacy `*.cursor.partial.mp4` files (stale outputs from older versions).
- Progress milestones collapse to: 0.08 resolving-assets → 0.15 rendering (composition + cursor, now with real per-tick progress) → 0.84 captions sidecar → 0.9 validating.

Net effect: one encode instead of two, no intermediate file, and the single encode uses the hardware encoder from (A).

## C. Hardware proxy generation

- `media/proxy.rs`: extract a pure `build_proxy_command(...)` builder; take the encoder id as a parameter. Hardware branches favor speed (NVENC `-preset p4 -run -rc vbr -cq 28 -b:v 0` typo-corrected: `-preset p4 -rc vbr -cq 28 -b:v 0`, QSV `-preset veryfast -global_quality 28`, AMF `-quality speed`, MF CBR at a computed bitrate); software keeps today's `libx264 veryfast crf 28`.
- `jobs/mod.rs` proxy call site: `select_best_encoder(&manager.available_encoders, &default_encoder_priority())` (reuse from `capture/config.rs`).
- Unit-test `build_proxy_command` for hardware vs software branches, following the `thumbnails.rs`/`waveform.rs` builder-test convention.

## Explicit non-goal

Decode-side `-hwaccel` (d3d11va etc.) for export inputs: every input frame passes through CPU filters (`geq`, `drawbox`, `overlay`, scale), so hardware frames would need an immediate `hwdownload` and gain only the decode stage while complicating every input line. Encode-side acceleration is where the win is.

## Files changed

- `packages/contracts/src/timeline.ts`, `packages/contracts/src/project.ts` (alias, no change expected)
- `apps/desktop/src/features/export/export-view.tsx`, `apps/desktop/src/stores/timeline-store.ts`, `apps/desktop/src/app/app-shell.tsx`
- `apps/desktop/src-tauri/src/exports/mod.rs`, new `exports/encoding.rs`
- `apps/desktop/src-tauri/src/capture/encoder.rs` (expose probe), `capture/session.rs` (getter)
- `apps/desktop/src-tauri/src/jobs/mod.rs`, `commands/recording.rs` (init wiring)
- `apps/desktop/src-tauri/src/media/proxy.rs`
- Tests: new Rust unit tests in `exports/encoding.rs` + `media/proxy.rs`; update existing partial-path/cleanup tests in `exports/mod.rs`; update `packages/contracts/src/project.test.ts` defaults

## Validation

- `bun run check` (typecheck + tests), `cargo fmt`, `cargo clippy`, `cargo test -j 1` (per AGENTS Windows note)
- Manual smoke on this machine: export with cursor telemetry → verify single ffmpeg invocation, hardware encoder used, output passes `validate_export_output`; force "software" → byte-comparable behavior with today; proxy prepare job uses detected encoder.

## Known limitations

- HEVC hardware export adds up to ~1–3 one-second probes on first hevc export (cached list doesn't cover hevc variants).
- Hardware encoders are slightly lower quality-per-bit than tuned x264; users can force Software.
- The startup detection cache can go stale if drivers/GPUs change mid-session (already true for recording today).
- Progress percentages during "rendering" depend on ffmpeg `time=` parsing; rawvideo-only exports (no file inputs) still show milestones only if stderr parsing proves unreliable there.