# Export Pipeline — Phase 1 Results (2026-10-25)

Implementation results for Phase 1 of `speed-improvement-plan.md`, measured
against the Phase 0 baseline in
[perf-baseline-2026-10-25.md](perf-baseline-2026-10-25.md). Same machine
(baseline-machine.md), harness, fixture, FFmpeg 9.0.1 sidecars and `--repeats 1`
(short runs; treat sub-10% deltas as noise).

## What shipped

| Item | Status | Notes |
| --- | --- | --- |
| 1.1 Window-local zoom | shipped | A pass samples `evaluate_zoom_transform` on every frame; zoom-free passes replace `zoompan` with a cached same-size `scale`, which is pixel-identical to identity `zoompan` and avoids its per-frame SwsContext allocation. |
| 1.2 Corner patches | opt-in | Implemented (four radius-sized inverse-mask plates + corner PNG strip). It removes the full-frame RGBA/alphamerge round trip and measured ~10% faster, but its anti-aliased corner blend shifts pixels by ~1 code level, so the 50 dB parity gate rejects it. `RECORDFORGE_EXPORT_CORNER_PATCHES=1` enables it. |
| 1.3 Camera shadow crop | shipped | The shadow plate is rendered then cropped to its blur bounds (even-aligned) and composited at that origin. Bit-identical output; removes a full-canvas RGBA plate per visible camera. |
| 1.4 NVENC chunk cap | shipped | Driver cap raised from 3 to 8, but only for plate-free exports. Plate producers compete with extra encode sessions for CPU: 12 chunks/6 workers measured 12% slower than 6 chunks/3 workers on this laptop. `RECORDFORGE_EXPORT_NVENC_CHUNK_WORKERS` overrides. |
| 1.5 Exact-geometry pre-flight | shipped | Two-frame `-f null -` encode with the real codec/geometry/pix_fmt args before the full render; a failure downgrades to software immediately instead of after a whole failed pass. Verified against NVENC/AMF-MF/QSV on the baseline machine. |
| 1.6 Bounded audio inputs | shipped | Dedicated audio inputs get `-ss` past the unused head plus `-t`, and `append_audio_graph` subtracts the same seek from every `atrim`. Applies to single-pass and chunked audio renders. |

Additional Phase 1 decisions from measurement:

- **Chunk-boundary snapping is opt-in.** `chunk_boundaries_with_zoom` snaps
  cuts onto zoom-region edges, but on the 30 s matrix it added a chunk, ran
  slower than the uniform grid (20.7 s vs 18.5 s on `abl-zoom`), and moved
  enough frame boundaries to fail the parity gate. Zoom-free chunks already
  skip `zoompan` without it. `RECORDFORGE_EXPORT_ZOOM_SNAP=1` enables it.

## Benchmark (software x264, 30 s / 900 frames)

`tooling/benchmarks/out/phase1-final-run/bench-results-2026-10-25T13-18-08-327Z.json`

| spec | Phase 0 wall s | Phase 1 wall s | Δ |
| --- | --- | --- | --- |
| abl-plain | 22.2 | 17.4 | −21.6% |
| abl-padding | 22.0 | 18.2 | −17.3% |
| abl-radius | 27.4 | 21.1 | −23.0% |
| abl-shadow | 27.2 | 18.5 | −32.0% |
| abl-zoom | 25.6 | 19.0 | −25.8% |
| abl-cursor | 23.8 | 22.4 | −5.9% |
| abl-items | 22.0 | 21.0 | −4.5% |
| abl-captions | 19.9 | 17.7 | −11.1% |
| abl-camera | 22.8 | 23.8 | +4.4% |
| synth chunked | 34.6 | 31.8 | −8.1% |
| synth single | 32.5 | 33.7 | +3.7% |

Marginal costs relative to `abl-padding` show the targeted wins more clearly:

| ablation | Phase 0 vs padding | Phase 1 vs padding |
| --- | --- | --- |
| shadow | +23.2% | +1.7% |
| zoom | +15.5% | +4.4% |
| radius | +24.2% | +16.3% (unchanged alpha path; patch path is opt-in) |

`abl-plain` also improved, so part of the wall-clock difference is machine
variance between the Phase 0 and Phase 1 sessions. The shadow and zoom deltas
relative to padding are the attributable wins.

Full-run details (plate MiB, raster/write/feed timings) are in the results JSON
and sibling `bench-*.log` files.

## Parity gate

Every Phase 0 baseline render was compared with
`tooling/benchmarks/parity.ts --mean 50 --min 45`:

| encoder | pairs | result |
| --- | --- | --- |
| software x264 | 11/11 | PASS — 900/900 frames, 100.00 dB mean and min on every spec |
| NVENC | 2/2 | PASS — synth single 100/100 dB; synth chunked 83.26/48.97 dB (NVENC session nondeterminism, still above gate) |

Frame counts are exact and audio duration deltas are 0 ms on every pair.

## Environment knobs

| Variable | Default | Effect |
| --- | --- | --- |
| `RECORDFORGE_EXPORT_CHUNK_WORKERS` | auto | Existing worker override. |
| `RECORDFORGE_EXPORT_CHUNK_FRAMES` | auto | Existing chunk-length override. |
| `RECORDFORGE_EXPORT_NVENC_CHUNK_WORKERS` | 3 with plate work, 8 without | NVENC parallel pass cap. |
| `RECORDFORGE_EXPORT_ZOOM_SNAP` | off | Snap chunk cuts onto zoom-region edges. |
| `RECORDFORGE_EXPORT_CORNER_PATCHES` | off | Use the four-plate rounded-corner path instead of RGBA + alphamerge. |

## Validation

- `cargo test -j 1 exports::` — 165 passed.
- `cargo clippy --all-targets -- -D warnings` — clean.
- `cargo fmt --check` — clean.
- New unit tests: per-frame zoom classification, zoom-region edge extraction,
  zoom-aware chunk boundaries, audio decode windows, corner-patch inverse-mask
  math, camera-shadow crop bounds, encoder pre-flight arguments.
