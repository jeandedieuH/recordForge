# Export benchmark: plate-plane bounding crops (2026-10-23)

Machine: see `baseline-machine.md` (i5-11400H 6c/12t, RTX 3050, 24GB, Balanced).

Fixture: `tooling/benchmarks/export-synth-spec.ts` — 30s of 1080p30 with cursor
plate + items plate (titles, annotations, callouts), plus a bounded audio pass.
Run: `bun run tooling/benchmarks/export-bench.ts tooling/benchmarks/out/synth --workers 2,6`.
Times are wall-clock; `raster`/`write`/`starved` are summed across the plate
feed's producer threads; `plate MiB` is total rawvideo bytes pushed to FFmpeg.

## Baseline → per-plane bbox crops

| run | plate MiB | raster ms | write ms | wall s | comp speed |
| --- | --- | --- | --- | --- | --- |
| chunked auto (w6) | 14 232 → **8 068** | 55 437 → 52 177 | 53 953 → 34 097 | 44.6 → **34.4** | 0.21x → 0.29x |
| chunked w2 | 14 236 → 9 657 | 77 020 → 71 597 | 55 718 → 57 585 | 39.7 → 40.3 | 0.51x |
| chunked w6 | 14 232 → 8 068 | 57 858 → 57 138 | 60 293 → 42 575 | 40.4 → 41.5 | 0.27x |
| single-pass | 14 238 → 10 992 | 49 495 → 48 627 | 35 499 → 32 293 | 39.9 → **36.6** | 0.84x → 0.93x |

## Notes

- The feed is now **write-bound** (~340 MB/s stdin pipe), not raster-bound:
  per-pass `feed_ms` ≈ `write_ms`. Further wins on this axis need smaller
  planes still — per-frame dynamic rects are impossible with a static filter
  graph — or a different plate transport (mezzanine file, alpha-only planes).
- Planes tile along the cheaper axis (side-by-side vs stacked) per pass via
  `pack_plane_layout`; each plane's `crop` slice + `overlay=x:y` composite is
  emitted from `CursorFramePlan.plane_offsets`/`plane_rects`.
- Items/keys rect = union of `OverlayEngine::items_bounds` /
  `KeystrokeRenderer::bounds_in_range` over the pass's frames — evaluation
  only, no raster (~µs per frame). Spotlight annotations force full canvas.
- The cursor plane uses the fitted screen rect in every plane mix now (was
  cursor-only streams before); its raster still runs at canvas size then
  crops — the next crop-level win is rendering cursor telemetry directly
  into the rect instead.
- chunk p50 ≈ 14.2s unchanged: chunk wall time is dominated by decode+zoompan+
  encode, not the plate feed — the crop's win shows in feed share (~90→~60%
  of pass) and total bytes.

## Verification

- `cargo test --release exports::` — 156 tests, incl. chunked end-to-end.
- `cargo test --release --features native-render` (overlay-engine) — 34 tests,
  incl. `parity_test_renders_fixture_project_overlays`.
- `bench-spec_synth_*.log` — all four runs produced valid mp4 output.
