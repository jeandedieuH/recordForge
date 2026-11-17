# Golden-frame export parity

The unit and render-smoke tests prove that a plan draws _something_; they do not
prove the exported pixels are unchanged. The golden-frame suite closes that gap
by comparing decoded frames of a real MP4 against checked-in PNG goldens with
FFmpeg's PSNR and SSIM filters.

## What it covers

`golden-spec.ts` builds the canonical fixture: a Titles-v2 designed title
(`hook-emphasis` with a gradient fill, stroke, drop shadow and a marker
emphasis span, so the new raster paths stay pinned), a filled annotation and a
shadowed curved connector, plus a one-second overlay-only tail.
The `3500.png` golden therefore pins the freeze-frame tail as well as the
overlay raster paths that have regressed before. `--long-tail` additionally
emits a 20 s chunked export whose tail spans several default chunks; the
`long-tail/` goldens prove the held frame survives chunk boundaries. `--gpu`
emits the same plan for the wgpu compositor, which exercises the GPU decode
pass's last-frame hold. `--effects` emits a second spec for the M2 pro
effects: `canvas.motionBlur` zoom/pan shutters at full strength while a frame
zoom transitions (so the multi-tap/`zoompan`+`mix` smear is pinned mid-move),
plus a parked Glass Loupe whose ring, glass and magnified sample pin the
analytic-vs-`geq` lens paths. Its goldens live in `golden/effects` (compat)
and `golden/effects-gpu`; the two differ by design — the compat lens is an
approximation — so each renderer gets its own set. The `items` ablation from
`export-synth-spec.ts` remains available for a broader fixture; prefer small,
deterministic ones so goldens stay reviewable.

## Create or refresh goldens

The dedicated fixture is a 480x270 / 3 s screen plus a real `ExportHarnessSpec`
that carries a designed title, a filled annotation and a shadowed curved
connector. Run this only after reviewing the render (the compatibility renderer
with a single pass, so encoder rate control cannot couple frames):

```bash
bun run --cwd tooling/benchmarks benchmark:golden:spec -- --long-tail --gpu --effects
cd apps/desktop/src-tauri
cargo build --features export-harness --bin export_harness
./target/debug/export_harness.exe ../../../tooling/benchmarks/out/golden/spec_golden.json
./target/debug/export_harness.exe ../../../tooling/benchmarks/out/golden/spec_longtail.json
./target/debug/export_harness.exe ../../../tooling/benchmarks/out/golden/spec_gpu_golden.json
./target/debug/export_harness.exe ../../../tooling/benchmarks/out/golden/spec_longtail_gpu.json
./target/debug/export_harness.exe ../../../tooling/benchmarks/out/golden/spec_effects.json
./target/debug/export_harness.exe ../../../tooling/benchmarks/out/golden/spec_effects_gpu.json
cd ../../..
bun run --cwd tooling/benchmarks benchmark:golden \
  out/golden/render_golden.mp4 golden/items --update
bun run --cwd tooling/benchmarks benchmark:golden \
  out/golden/render_longtail.mp4 golden/long-tail --times 10000,18000 --update
bun run --cwd tooling/benchmarks benchmark:golden \
  out/golden/render_effects.mp4 golden/effects --times 300,800,1600,2300,2900 --update
bun run --cwd tooling/benchmarks benchmark:golden \
  out/golden/render_effects_gpu.mp4 golden/effects-gpu --times 300,800,1600,2300,2900 --update
```

(`--release` works too; a debug harness keeps the fixture run inexpensive. On
Windows the binary has an `.exe` suffix.)

`export-synth-spec.ts` remains the broader parity matrix; its `items` ablation
also works with `--times 2000,7000,12000,21000` if a larger fixture is wanted.

Commit the generated `tooling/benchmarks/golden/items/*.png` files with the
change that produced them, and note the encoder/compositor in the commit body.
The default timestamps (`500,1500,2500,3500`) cover the early title/annotation
state, the steady state, the late exit and the freeze-frame overlay tail. Pass
`--times` for another spec.

## Verify a candidate

```bash
bun run --cwd tooling/benchmarks benchmark:golden out/golden/render_golden.mp4 golden/items
bun run --cwd tooling/benchmarks benchmark:golden \
  out/golden/render_longtail.mp4 golden/long-tail --times 10000,18000
# GPU candidates: same frames, resampler budget instead of identity.
bun run --cwd tooling/benchmarks benchmark:golden \
  out/golden/render_gpu_golden.mp4 golden/items --min-psnr 28 --min-ssim 0.89
bun run --cwd tooling/benchmarks benchmark:golden \
  out/golden/render_longtail_gpu.mp4 golden/long-tail --times 10000,18000 \
  --min-psnr 28 --min-ssim 0.9
# M2 effects: each renderer has its own goldens — the compat lens is an
# intentional `geq` approximation, so do NOT compare GPU against `effects`.
bun run --cwd tooling/benchmarks benchmark:golden \
  out/golden/render_effects.mp4 golden/effects --times 300,800,1600,2300,2900
bun run --cwd tooling/benchmarks benchmark:golden \
  out/golden/render_effects_gpu.mp4 golden/effects-gpu --times 300,800,1600,2300,2900 \
  --min-psnr 28 --min-ssim 0.9
```

The command exits non-zero when a golden is missing or a frame falls below
`--min-psnr 35` / `--min-ssim 0.98`. Exact or near-exact frames are expected for
the software single-pass path; the same thresholds work for the GPU renderer's
`renderer` parity budget.

> Note (Titles v2): the richer title fixture (gradient, thin stroke, marker
> highlight) adds high-frequency edges that H.264 quantizes slightly
> differently between the compatibility and wgpu pipelines. As of the v2
> refresh the GPU-vs-golden run sits at ~32–33 dB PSNR / ~0.896–0.915 SSIM —
> the remaining delta is encoder noise on hard edges (the amplified diff map is
> uniform across the frame, including the testsrc bars), not a raster
> divergence. The `items` GPU floor is therefore `--min-ssim 0.89`; investigate
> any step-down below that.
>
> Note (effects fixture): the GPU render measures ~20–35 dB PSNR against the
> compat goldens — far below the `items` budget — because the loupe's glass
> rim is deliberately approximated on the compatibility path (its
> `loupe-glass` render note covers this). That is why `effects-gpu` is a
> separate golden set rather than a budget on the shared one.

## Why not compare against the browser preview?

The preview is a canvas 2D rasterization, not the export compositor. The
maintainable contract is "the export still produces the approved pixels"; the
shared Rust scene and the preview/export parity unit tests cover the
preview-side geometry.
