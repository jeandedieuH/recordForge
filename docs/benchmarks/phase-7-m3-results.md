# M3 — Parity Run: b-roll, gaps and camera layouts (2026-11-15)

First measured pass of the M3 fixtures (ADR 022). This run covers the four
shapes M3 added or unblocked, plus the identity baseline; the rest of the
14-spec matrix was not re-run here.

## Environment

- Windows 11, **NVIDIA GeForce RTX 3050 Laptop GPU (Dx12)** through wgpu; the
  compositor reported a hardware adapter for every GPU spec.
- `export_harness` built with `--features export-harness` in the **debug**
  profile. Parity is content-based, so debug/release does not affect the dB
  numbers; wall-clock timings are therefore **not** reported here (a debug
  harness is not a valid timing baseline — use the release build for the
  benchmark table).
- Fixtures: `export-synth-spec.ts out/m3 --single-pass` (compatibility) and
  `export-synth-spec.ts out/m3-gpu --single-pass --renderer gpu`. Both sides
  rendered the same plan JSONs with the same binary in one process per side.
- Gate: `parity.ts out/m3 out/m3-gpu --suffix _gpu --profile renderer
--skip-missing` (mean ≥ 40 dB, min ≥ 28 dB, exact frame counts, audio Δ).

## Results

| Spec                                   | Frames |    Mean dB |     Min dB | Worst frame | Audio | Result                        |
| -------------------------------------- | -----: | ---------: | ---------: | ----------: | ----- | ----------------------------- |
| `abl-b-roll` (static video layer, #13) |    900 |      42.61 |      41.75 |         801 | Δ0 ms | PASS                          |
| `abl-plain` (identity baseline)        |    900 | **100.00** | **100.00** |           1 | Δ0 ms | PASS (decoder→encoder bypass) |
| `gap_fill` (mid-timeline hole, F2)     |    300 |      44.70 |      42.20 |         221 | Δ0 ms | PASS                          |
| `synth` (all features)                 |    900 |      44.10 |      36.77 |         133 | Δ0 ms | PASS                          |
| `approx-camera-layout` (#5)            |    300 |          - |          - |           - | -     | SKIP: approximation (ADR 020) |

`parity OK — 5 pair(s), mean ≥ 40 dB, min ≥ 28 dB`.

### What the numbers say

- **Gaps (F2).** A declared mid-timeline hole now renders on the compositor:
  the decode pass splices a black source and the composite pass paints the
  canvas background, and the pair still lands at 44.70/42.20 dB with exact frame
  counts. Before M3 this plan never reached the GPU renderer at all.
- **Video layers (F3/#13).** A static `role: "video"` layer with a rounded
  border and shadow sits comfortably above the renderer profile. The row is a
  parity row, so the shared decode/quad path is behaving like the camera row
  did (phase-6 measured `abl-camera` at 40.71/40.46).
- **Zero cost when unused (F4).** `abl-plain` is still bit-identical at 100 dB:
  the layer-order and video-layer fields changed no pixels for a plan that does
  not use them.
- **Camera layouts (#5)** are reported as an approximation, not a parity row:
  the compatibility renderer draws the bubble at its static rect, so the row is
  measured for wall time only (this run confirms it renders 300 frames on the
  GPU renderer with one camera layer and no fallback).

## Bug found by this run (fixed)

The first GPU attempt of `approx-camera-layout` failed with:

```
media_failed: camera frame size does not match the overlay
```

and fell back to the compatibility renderer. Cause: `build_cameras` grew the
camera decode plane to the largest layout keyframe for **every** camera track,
while `compositor_spec` only did so for `role: "camera"` overlays. A plan whose
camera overlay carried no role (older plans, benchmark fixtures) therefore
decoded at 1920×1080 into a 320×320 quad.

Fix: both call sites now go through `camera_layout_max_for(plan, track)`, which
gates on the role, plus a regression test
(`only_camera_layers_take_the_layout_plane`). The benchmark fixture also sets
`role: "camera"`/`id` on its camera overlay, matching what the editor emits.

After the fix the spec renders on the GPU renderer with `composed=300`,
`cameras=1`, no fallback.

## Known fixture issue

Every spec logs `cursor telemetry is unavailable; exporting without a cursor
overlay`, on both renderers. The synthetic V2 telemetry pair
(`cursor_telemetry.json` + `cursor_events.bin`) is accepted by neither the V2
nor the V1 reader in this build, so the cursor plate is absent from the `synth`
row. Because it is absent on both sides the parity comparison is still valid,
but the `synth` row currently does not exercise the cursor overlay. The
dedicated `abl-cursor` rows were not part of this run; fix the fixture before
using them as evidence.

## Not run here

- The remaining ablations (`padding`, `radius`, `shadow`, `zoom`,
  `zoom-border`, `items`, `masks`, `keys`, `captions`, `camera`, `blur`) and the
  chunked synth pair.
- Release-profile wall times and the M3 budgets (zoom-free ±2 %, zoom-heavy
  ≤ +10 %).
- `--require-gpu` re-checks for each row; the renderer line in the harness log
  was checked manually for this subset.
- Golden-frame refresh for b-roll/camera layouts (needs a visual review first).
