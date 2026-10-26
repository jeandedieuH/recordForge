# Export Pipeline — Phase 2 + Phase 3 Results (2026-10-25 → 2026-10-26)

Implementation notes and measurements for Phase 2 (export structure) and Phase 3
(stop-to-editor). Baseline: `phase-1-results.md` /
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

## Phase 2.1 follow-up — `sendcmd` cursor tiling is not usable (2026-10-26)

The earlier note blamed the moving-plane composite for "shifting FFmpeg's soft
cursor-shadow pixels". That guess was wrong. An isolated FFmpeg 9.0.1
experiment (60-frame 640×480 clip, a soft blob as the cursor plate, one
`overlay@cursor x/y` command per frame) shows the *command* itself lands on the
wrong frame:

- `overlay` with `eval=frame` and `-loglevel trace` reports `n:1 t:0.000
  x:104` for the first output frame, while the command for `t=0` sets `x=100`.
  The filter graph dispatches `sendcmd` commands ahead of the blend that
  consumes the frame, so the position can be 1..N frames early.
- The offset is not stable: repeated runs of the same graph produced jumps of
  1–3 frames at different points (a run of frames sticks on a later command,
  then resumes). `-filter_complex_threads 1` did not remove it.
- A single sparse command (one position change at t=0.5 s) lands on the right
  frame, which is why the script generation unit test passed: the failure only
  shows up with per-frame updates.

Per-frame tiling therefore cannot be made frame-exact on the pinned FFmpeg, and
the fixed `union` tile stays the shipping default. The env knob is kept for
experiments only.

## Phase 2.2 — `yuva420p` plate transport (shipped)

The plate stream no longer ships RGBA. Workers convert each plane in Rust
(`cursor::rgba_to_yuva420p`): BT.601 limited range with a 2×2 chroma average,
full-resolution alpha, and the previously separate unpremultiply pass folded
into the same loop. The graph declares `-pix_fmt yuva420p`, so `overlay` blends
the plane directly and no longer auto-inserts a single-threaded RGBA→YUVA420P
`swscale` per plane.

- 2.5 bytes/pixel instead of 4 (**−37.5 %** plate bytes; the packed stream and
  every per-plane buffer shrink by the same factor). Measured on the 30 s
  fixture, 12 chunks: cursor plane `5048 → 3156 MiB`, items `1496 → 936 MiB`,
  all-features chunked `6720 → 4201 MiB`, single pass `11066 → 6918 MiB`.
- Plane rects are snapped to the chroma grid (`even_plane_rect`); missing planes
  now occupy a transparent 2×2 cell instead of a 1×1 one.
- Transparent pixels keep the black level and neutral chroma
  (Y=16, U=V=128, A=0), matching what swscale produced from an all-zero RGBA
  pixel.
- **Alpha transfer matched to swscale.** FFmpeg's RGBA→YUVA420P scales alpha by
  `255/254` with a `126/254` bias (128→129, 127→127, 200→201). Reproducing that
  (`swscale_alpha`) keeps the blend weight of every semi-transparent pixel equal
  to the old path; it moved the cursor ablation from 58.0 dB to **65.6 dB**.

### Conversion fidelity (measured against FFmpeg, same rendered plane)

Dumped the real items plane (1360×830) from a render and ran FFmpeg's
`format=yuva420p` on the same RGBA:

| plane | PSNR vs swscale | differing samples |
| --- | --- | --- |
| Y | 62.50 dB | 12 of 1 128 800 (0.001 %) |
| U | 60.79 dB | 2 096 of 282 200 (0.74 %) |
| V | 58.27 dB | 2 404 of 282 200 (0.85 %) |
| A | exact | 0 |

Every chroma outlier is a *fully transparent* 2×2 block where swscale's chroma
dither leaks a value from a neighbouring block; alpha is zero there, so the
composite is unaffected. Luma and alpha are effectively bit-exact.

## Parity: what passes, and why item-bearing exports cannot match the legacy artifacts

Reference renders were produced from `HEAD` (pre-change) with the same fixture,
then the new binary rendered the same 11 specs
(`parity.ts`, index-paired per-frame PSNR, mean ≥ 50 dB / min ≥ 45 dB):

| spec | frames | mean dB | min dB | result |
| --- | --- | --- | --- | --- |
| abl-plain / padding / radius / shadow / zoom / camera / captions | 900 | **100.00** | **100.00** | PASS (bit-identical) |
| abl-cursor | 900 | 65.64 | 46.26 | PASS |
| abl-items | 900 | 44.21 | 42.44 | legacy-baseline mismatch (see below) |
| synth_chunked | 900 | 47.76 | 35.39 | legacy-baseline mismatch |
| synth_single | 900 | 43.49 | 35.42 | legacy-baseline mismatch |

Frame counts and audio durations are exact on every spec.

**Why the item-bearing specs differ.** The legacy path fed an **RGBA** plate to
`overlay=format=auto`. `auto` negotiated a higher-chroma blend, and that
conversion applied to *the whole frame on every frame* — even when the overlay's
`enable` window was off:

- legacy `abl-items` frame 270 (items hidden) vs legacy `abl-plain` frame 270:
  **43.3 dB** — the presence of an (inactive) plate overlay changed the frame.
- the new `abl-items` frame 270 vs `abl-plain`: the frames differ only by the
  encoder's rate-control response to the extra filter, not by plate pixels.

So the legacy artifacts already contained a global chroma round-trip that the
new transport removes; comparing against them measures that removal, not a plate
regression. Two supporting checks:

- The plate conversion is near-exact (table above), and the composite is
  aligned: shifting the new frame by ±1 px makes the comparison strictly worse
  (identity is the minimum).
- The overlay path itself is unchanged for the cursor, whose `format=yuv420`
  was explicit in both paths — that spec passes at 65.6/46.3.

**Gate update needed (follow-up).** For plate-bearing exports the meaningful
gate is *structural* parity: exact frame counts (all specs pass), identical
audio, and a **transparency invariant** — frames where no plate content is
visible must equal a plate-free render of the same plan. The legacy-artifact
PSNR comparison stays as information for plate-free specs (where it is still
100 dB) and for the cursor.

## Frame-drop bug found by the parity run (fixed)

The first candidate run produced **896 of 900 frames** on the chunked
all-features spec, four frames short. Each loss was the **last frame of a
multi-piece zoom chunk** (PTS 4.9667, 9.9667, 17.4667, 22.4667 s).

Cause: `concat` re-bases its output onto FFmpeg's microsecond timebase, so the
last frame's timestamp lands up to 1 µs *before* the background/plate frame it
pairs with; `overlay=shortest=1` then stops one frame early. The single-stage
`zoompan` path emits on the 1/fps grid and never showed it.

Fix: re-grid the joined stream after `concat` —

```
[zoom_joined]settb=1/<fps>,setpts=N<abs>[out]
```

Verified in isolation (74 → 75 frames for an affected chunk) and end-to-end:
all specs now emit exactly 900 frames. A graph-shape test asserts the
`settb=1/30,setpts=N` tail.


## Phase 2.3 — piecewise zoom (shipped)

`camera::classify_zoom_pieces` samples every frame in the pass and classifies it
as:

- **identity** — the full canvas is sampled 1:1, so the frames pass through;
- **hold** — the integer crop `zoompan_integer_crop` would pick equals a
  neighbour's crop, so `crop=w:h:x:y` + `scale=…:flags=bicubic:threads=auto`
  reproduces it with a cached SwsContext;
- **transition** — the crop changes between frames, so `zoompan` stays.

The pass then builds `split=N` + per-run `trim` + `concat`. Runs are bounded to
8 branches (`MAX_ZOOM_PIECES`); past that the pass falls back to a single
`zoompan`, so the graph cannot grow with the number of keyframes/motion-plan
steps. A window that sits entirely inside one steady zoom skips the splice and
becomes a single `crop` + `scale` stage (its timestamps are left untouched).
`RECORDFORGE_EXPORT_ZOOM_PIECES=0` restores the single-stage graph.

Parity and frame exactness (measured with the pinned FFmpeg, 1920×1080):

| check | result |
| --- | --- |
| `crop`+`scale` vs `zoompan` at a fixed crop | 99.00 dB |
| `zoompan` inside a `trim`+`concat` branch vs whole-window `zoompan` | 99.00 dB for every branch frame |
| frames after `split`/`trim`/`concat` (30-frame source, 3 branches) | 30 (exact) |

Filter-chain timing, 150 frames (5 s of 1080p30 at 1.5× zoom), two runs each,
`-f null` so decode and filtering dominate:

| graph | run 1 | run 2 |
| --- | --- | --- |
| `format=yuv420p` only | 1190 ms | 1071 ms |
| + `zoompan` | 1363 ms | 1240 ms |
| + `crop`+`scale` | 1225 ms | 1194 ms |
| piecewise (half hold / half passthrough) | 1120 ms | 1031 ms |

So the stage is ~10–17 % cheaper on this machine, not the multiple the plan
hypothesised: on the baseline laptop the pass is dominated by decode and encode,
and `zoompan`'s per-frame SwsContext allocation is small next to the scaling
work itself. The change is still a win and it removes a serial stage, which
matters more once the encoder is idle waiting on the graph.

End-to-end A/B on the plate-free `abl-zoom` spec with one binary
(`bun run --cwd tooling/benchmarks benchmark:zoom-pieces -- <harness> <spec> 3`;
alternating runs, `RECORDFORGE_EXPORT_ZOOM_PIECES=0` vs on):

| pair | pieces on | pieces off |
| --- | --- | --- |
| 1 | 21.0 s | 42.8 s |
| 2 | 32.6 s | 35.8 s |
| 3 | 23.2 s | 24.0 s |

The machine was under heavy external load during this run (a concurrent
Phase-5 session; the plate-free `abl-plain` spec swung from 17.4 s to 45.6 s
between matrices), so the medians are not reportable. The quiet pairs and an
earlier isolated pair (compose 26.4 s vs 29.5 s) put the real gain at
**~3-10 %** for zoom-bearing passes; the direction is consistent in every pair.

## Phase 2.4 - chunk retuning (measurement only)

No default changed. The filter-chain numbers above show the chunk knobs
(`workers`, `CHUNK_FRAMES`, `pass_threads`, `plate_divisor`) are not the current
bottleneck: decode and encode dominate, and both scale with workers. The YUVA
transport already relaxes the *memory*-bound caps automatically, because the
plate feed derives its worker count and in-flight window from
`frame_bytes * 5` / `256 MiB` and the frame is now 37.5 % smaller.

The full ablation matrix was run on both binaries (`benchmark:export` with
`--out`/`--scratch`, logs under `tooling/benchmarks/out/p2p3-bench-ref*` and
`p2p3-bench-final*`). Wall times from that run are **not comparable**: a
concurrent session saturated the machine, and the plate-free `abl-plain` spec
itself moved from 17.4 s (earlier matrix) to 45.6 s (final matrix). The
load-independent metrics all hold: plate bytes −37.5 %, `zero%`/caching
unchanged, frame counts exact, chunk count and mux time unchanged. Re-run the
matrix on an idle machine before changing any chunk default.

## Phase 3.4 — parallel prepare stages (shipped)

`PrepareWorker::run` now runs three stages concurrently on a scoped thread:

- camera tracks (webcam probe + webcam sprite, or legacy secondary-stream
  extraction + sprite),
- the main thumbnail sprite,
- audio tracks (copy derivative + waveform) for every audio stream.

Database writes (`record_derivative`, progress, job status) stay on the worker
thread after the join. Each stage keeps its `prepare: stage finished`
`elapsed_ms` log, join panics become a job failure with the panic message, and
cancellation is checked before any error is reported so a cancelled prepare is
not marked failed.

Expected effect: stop-to-editor ≈ `max(webcam, thumbnails, audio)` instead of
their sum. The stages only read the finalized files and never contend on the
same output path. No real-recording timings were captured in this session (the
synthetic fixture has no live capture); the existing session/job tests cover the
path and each stage keeps its `elapsed_ms` span for the next measurement pass.

## Phase 3.5 — keyframe-only thumbnails (shipped)

`generate_thumbnails` takes a `keyframe_only` flag. Native screen and webcam
captures encode with `-g fps` (one-second GOP), so when the effective sprite
interval is ≥ 1 s the sprite only needs keyframes: the command adds
`-skip_frame nokey` as an *input* option. Imported assets pass `false` (unknown
GOP) and short clips automatically stay on the full decode because their
effective interval drops below 1 s.

## Phase 3.6 — one decode per audio stream (already satisfied)

The prepare path copies each audio stream into its derivative (`-c:a copy`) and
decodes it exactly once, for the waveform (`-ac 1 -ar 1000`). There is no second
AAC→WAV decode to remove. (The derivative file keeps the historical `.wav`
name while carrying the copied codec; that is a pre-existing naming quirk, not
a decode.)

## Phase 3.3 / 3.7 — deferred

- **3.3 webcam stream copy**: the per-segment camera offset is currently baked
  in with `tpad`/`trim`, so a stream copy needs the signed offset represented in
  the project's camera clip (`output_start`/`source_in`) and honoured by project
  creation, the preview and the export plan. That is the Phase 4.1 data-model
  check; until then the single webcam re-encode stays.
- **3.7 lossless WAV derivative** is optional and not needed once 3.6 is only
  one decode.

## Environment knobs

| Variable | Default | Effect |
| --- | --- | --- |
| `RECORDFORGE_EXPORT_CURSOR_TILE` | `union` | `union` fixed tile, `sendcmd` per-frame moving tile (faster, but `sendcmd` positions are not frame-exact on FFmpeg 9), `full`/`0` previous full plane. |
| `RECORDFORGE_EXPORT_ZOOM_PIECES` | on | `0`/`false` restores one `zoompan` stage for the whole pass (A/B parity checks). |

## Validation

- `cargo test -j 1` - 603 lib tests pass, plus integration targets.
- `cargo fmt --check`/`cargo clippy --all-targets -- -D warnings` - clean.
- `parity.ts` now accepts the `render-*.mp4` names `export-bench.ts` writes (it
  only matched `render_*` before), so a benchmark run can feed the gate
  directly.
- End-to-end parity run: 11 synthetic specs rendered from HEAD and from the
  changed tree, index-paired PSNR, exact frame counts (table above).
- New tests: single-segment hard-link publish keeps the fragment; cursor tile
  equivalence + bounds coverage; sendcmd script generation; RGBA→YUVA420P
  against FFmpeg BT.601 reference levels; swscale alpha transfer; YUVA plane
  packing; zoom piece classification (identity/hold/transition, branch cap),
  the piecewise graph shape and its `settb`/`setpts=N` re-grid; keyframe-only
  sprite command options.
- `tooling/benchmarks/zoom-pieces-ab.ts` (new, `benchmark:zoom-pieces`) runs the
  same binary with `RECORDFORGE_EXPORT_ZOOM_PIECES` on/off in alternating pairs.
