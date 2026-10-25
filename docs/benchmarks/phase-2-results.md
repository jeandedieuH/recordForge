# Export Pipeline — Phase 2.1 + Stop-Path Results (2026-10-25)

Implementation notes and measurements for the first slice of Phase 2 (cursor
tile) and Phase 3 (stop-to-editor). Baseline: `phase-1-results.md` /
`perf-baseline-2026-10-25.md`, same machine and synthetic fixture.

## Phase 2.1 — cursor tile plane

### Shipped

The cursor plate now ships only the pixels the cursor can draw into instead of
the whole fitted screen rect:

- `CursorRenderer::frame_bounds` sweeps per-frame sprite + click bounds (the
  spotlight keeps the full clip rect).
- `CursorRenderer::render_frame_at_offset` rasterizes into an
  origin-anchored tile; `DrawTarget` maps canvas coordinates into the tile.
- The plate layout has three modes (`RECORDFORGE_EXPORT_CURSOR_TILE`):
  - `union` (default): one fixed tile covering every frame in the pass, no
    `sendcmd`. Pixel-identical to the old full-plane output.
  - `sendcmd`: a smaller per-frame tile moved by an `overlay@cursor` `sendcmd`
    script (time-shifted commands generated with even origins). Faster, but
    the moving-plane composite shifts FFmpeg's soft cursor-shadow pixels enough
    to fail the parity gate; kept opt-in for investigation.
  - `full` / `0`: the previous full fitted-screen plane.

### Why the default is `union`

`sendcmd` produced the best producer numbers (cursor plane 7116 → 370 MiB,
`abl-cursor` 20.1 s) but every comparison against the stored baseline landed
around 56 dB mean / 34 dB min — above the mean gate but below the 45 dB
per-frame minimum. Rendering the same bounds into a tile is byte-identical to
the full-canvas render (unit test), and a static RGBA plane cropped and
composited at an even origin is also identical, so the residual is in FFmpeg's
per-frame moving-plane composite. Until that is understood, the union tile is
the shipping path.

### Benchmark

`tooling/benchmarks/out/phase2-final/bench-results-2026-10-25T15-14-30-313Z.json`

| spec | Phase 1 wall s | Phase 2.1 wall s | plate MiB (P1 → P2) | cursor raster ms (P1 → P2) |
| --- | --- | --- | --- | --- |
| abl-cursor | 22.4 | 20.6 | 7116 → 5048 | 19 808 → 14 241 |
| synth chunked | 31.8 | 31.3 | 8152 → 6720 | 47 273 → 41 327 |
| synth single | 33.7 | 35.6 | 11 036 → 11 066 | 29 597 → 31 641 |

The cursor-only ablation is the clearest win (−8% wall, −29% plate bytes, −28%
cursor raster). On the all-features fixture the items plane dominates the plate
stream and the cursor union grows across the pass, so the wall delta is inside
run-to-run noise. The sendcmd variant remains the path to the planned −95%
bytes once parity is resolved.

### Parity

All 11 Phase 0 software baselines pass (`parity.ts --mean 50 --min 45`):
`abl-*` at 100/100 dB, `synth_chunked` 99.85/76.48 dB, `synth_single`
99.86/76.12 dB. Frame counts are exact and audio durations match.

Tests added:

- tile render equals the full-canvas crop at every sampled cursor position
  (including shadow and click effects);
- `frame_bounds` covers every drawn pixel;
- `sendcmd` script times/origins and change-only emission.

## Phase 3 — stop-to-editor latency (partial)

### 3.1 Parallel finalize (shipped)

`finalize_session` now starts the webcam re-encode on a worker thread as soon
as finalization begins, then validates/concatenates/probes/posters the screen
output while it runs. The manifest — which needs both output paths — joins the
worker just before the final write. Extracted as
`publish_webcam_asset(...)` so it only needs cloned inputs.

Expected effect: stop-to-editor becomes roughly `max(webcam_reencode,
screen_assembly + probe + poster)` instead of their sum. No real-recording
timings were captured in this session (the synthetic fixture has no live
webcam finalize); the existing session tests cover the path.

### 3.2 Fewer full-file passes (shipped)

- Single-segment sessions publish `output.partial.mp4` as a hard link to the
  captured fragment (copy fallback on filesystems without hard links), removing
  the full-file copy while keeping the fragment for recovery.
- Removed the duplicate `sync_file` after concat (concat already syncs).

Multi-segment mux still keeps `+faststart` per segment; moving it fully to the
concat stage is deferred because a session that turns out to have one segment
would then publish a slow-start file.

### Not yet implemented

- 3.3 webcam stream copy (needs the data-model design check).
- 3.4 parallel prepare stages (thumbnails + audio tracks/waveforms).
- 3.5 keyframe-only thumbnails (needs a trustworthy GOP signal).
- 3.6 one decode per audio stream (single FFmpeg invocation for M4A + peaks).
- 3.7 lossless native WAV derivative.

## Environment knobs

| Variable | Default | Effect |
| --- | --- | --- |
| `RECORDFORGE_EXPORT_CURSOR_TILE` | `union` | `union` fixed tile, `sendcmd` per-frame moving tile (faster, parity-failing), `full`/`0` previous full plane. |

## Validation

- `cargo test -j 1` — 569 lib tests pass, plus integration targets.
- `cargo clippy --all-targets -- -D warnings` — clean.
- `cargo fmt --check` — clean.
- New tests: single-segment hard-link publish keeps the fragment; cursor tile
  equivalence + bounds coverage; sendcmd script generation.
