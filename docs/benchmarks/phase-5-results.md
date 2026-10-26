# Phase 5 results — native GPU export compositor (G0–G5)

> Measured 2026-10-26 on the baseline laptop (i5-11400H, RTX 3050 Laptop,
> Windows 11). Synthetic 30 s 1080p30 fixture from
> `tooling/benchmarks/export-synth-spec.ts`, `renderer` the only variable.
> Timing tables are from a release `export_harness` build; parity and the
> resource-lifetime re-measurement were taken with a debug harness (parity is
> encoder- and shader-side, so it is build-independent).

## What shipped

Phase 5 is complete: **G0** (passthrough + zoom through a native wgpu
compositor), **G1** (canvas frame), **G2/G3** (camera, masks, keystrokes,
side-by-side, captions, chapters, HEVC, output cap, selected range), **G4**
(parity across the ablation matrix) and **G5** (`auto` selects the GPU). FFmpeg
remains the decode and encode sidecar throughout. ADR 018 records the
architecture; `docs/specs/media-jobs-render-plan.md` §5.6 the contract.

- `apps/desktop/src-tauri/src/exports/gpu/mod.rs` — renderer selection
  (`ExportSettings.renderer`), the per-feature gate, and the
  decode → compose → encode pipeline.
- `gpu/decode.rs` — FFmpeg NV12 sidecar that reuses the compatibility
  renderer's per-segment `trim`/`setpts`/`speed`/`fps`/`scale`/`pad`/`concat`
  chain, so frame counts and timestamps match.
- `gpu/compositor.rs` — wgpu device/pipelines, NV12 plane upload, integer
  `zoompan_integer_crop` sampling with Catmull-Rom bicubic, BT.601 limited
  YUV→RGB, `Rgba16Float` canvas, compute RGB→NV12 into a storage buffer laid
  out byte-for-byte as NV12.
- `gpu/encode.rs` — the encoder sidecar: NV12 on stdin, the existing semantic
  audio graph, encoder args, `hvc1`/`faststart`.
- `gpu/shaders/composite.wgsl`, `gpu/shaders/nv12_encode.wgsl`.
- Contracts: `exportRendererSchema` + `exportSettingsSchema.renderer`; frontend
  `setExportRenderer` and an export-sheet renderer selector.
- Tooling: `export-synth-spec.ts --renderer`, `parity.ts --suffix`.

## Gate behaviour

At G0 the gate accepted only a full-canvas screen plane (optionally zoomed) with
no overlay layers, no canvas frame/background, no timeline gaps, MP4/H.264
delivery and a canvas that fits a 4×2 NV12 grid. G1–G3 widened it to every
editor layer (canvas framing, cursor/items, camera and side-by-side, redact and
pixelate masks, keystrokes, burned-in captions, chapters, HEVC, the license
output cap, selected ranges); G4 added the blur-mask exclusion described below.
Explicit `gpu` requests outside the gate degrade with a logged reason; runtime
failures fall back once to the compatibility renderer.

Verified end-to-end at G0 with `spec_synth_chunked_gpu` (the all-features plan):
the gate rejected it then, the export finished on the FFmpeg renderer with exit
0, and the fallback was the same deliverable as before. A forced-failure run
(invalid shader, see below) also fell back and produced a valid file. G4 keeps
that property pinned with the `fallback_gap` and `fallback_blur` matrix rows
(both 100 dB).

## G0 timings

Median of three runs each, `composition_ms` from the harness (excludes process
startup). This laptop's thermal state moves wall-clock by up to ±50 % between
runs, so the minimum of the three is quoted where it is materially better.

| Encoder | Spec | Compat (median / min) | GPU (median / min) | Speed-up |
|---|---|---|---|---|
| libx264 veryfast | `abl-plain` | 13.35 s / 10.43 s | 13.18 s / 13.04 s | 1.01× |
| libx264 veryfast | `abl-zoom` | 14.85 s / 14.66 s | 13.33 s / 13.08 s | 1.11× |
| h264_nvenc | `abl-plain` | 10.71 s / 10.59 s | 8.35 s / 7.71 s | 1.28× |
| h264_nvenc | `abl-zoom` | 10.86 s / 10.50 s | 9.50 s / 9.38 s | 1.14× |

Realtime multiples (30 s of content): NVENC + GPU **3.2–3.6×**; NVENC compat
2.8×; x264 + GPU 2.3×. With software x264 the encoder is the wall, so the GPU
compositor only buys back the compositing time.

Stage isolation (single process, no pipe): the decode sidecar chain alone runs
at **4.0× realtime** (7.5 s) and `h264_nvenc` alone at **5.8×** (5.2 s).

### Where the time goes

A single instrumented run of the NVENC plain spec (per-run spans logged by the
compositor):

| Span | Time |
|---|---|
| setup (ffprobe plan, wgpu device, shader/pipeline creation, sidecar spawn) | 3.0–5.0 s |
| decode wait (compose loop blocked on the decoder) | 0.5 s |
| encode wait (compose loop blocked on the encoder) | 2.2–8.4 s |
| flush (encoder finalize + faststart) | 0.13–0.29 s |

Two conclusions:

1. **Fixed setup dominates a 30 s export.** About 1.8–2.9 s is wgpu
   adapter/device creation (DX12 backend; `Backends::PRIMARY` was worse — it
   initialises DXGI, Vulkan *and* GLES), roughly 0.9 s is naga/FXC shader
   compilation, and the rest is ffprobe + sidecar spawn. On a multi-minute
   export this amortises; on a 30 s clip it is ~40 % of the wall time.
2. **The steady-state pipeline is much faster than the end-to-end number.**
   With setup subtracted, 900 frames ran in **4.7 s = 6.4× realtime**. The
   pipeline is encode-bound (NVENC), not compositor-bound.

Optimisations already applied from measurement: `-hwaccel auto` on the decode
sidecar was **3.3 s slower** (it downloads every frame anyway) and is now
opt-in (`RECORDFORGE_EXPORT_GPU_DECODE_HWACCEL=1`); the backend is restricted to
one native API per platform (`WGPU_BACKEND` still overrides).

## G0 parity

`tooling/benchmarks/parity.ts`, compatibility render vs GPU render of the same
fixture (index-paired PSNR, exact frame count, audio presence). **Both sides are
single-pass**: the GPU renderer always encodes one stream, so the reference must
too. Comparing against a *chunked* compatibility render scores ~46 dB no matter
what the GPU does, purely because each chunk restarts x264's rate control — that
measurement error is what the first G0 report recorded as a "46 dB encode-input
delta".

| Spec | Frames | Mean dB | Min dB | Audio | Result |
|---|---|---|---|---|---|
| `abl-plain` (pure passthrough) | 900/900 | **100.00** | **100.00** | yes, Δ0 ms | bit-identical |
| `abl-zoom` | 900/900 | **53.20** | 30.88 (frame 127) | yes, Δ0 ms | pass at the renderer budget |

Command:

```bash
bun run tooling/benchmarks/export-synth-spec.ts out/p5ref --single-pass
bun run tooling/benchmarks/export-synth-spec.ts out/p5gpu --single-pass --renderer gpu
# render both spec sets with export_harness, then
bun run tooling/benchmarks/parity.ts out/p5ref out/p5gpu \
  --suffix _gpu --profile renderer --skip-missing
```

### Why the gate needed a budget, not a pixel fix

`parity.ts --profile renderer` encodes the measured ceiling: two different
compositors cannot resample identically. Swapping swscale's default bicubic for
another FFmpeg kernel on the same crop scores, on the fixture frame:

| Reference kernel | Mean dB vs `scale=…:flags=bicubic` |
|---|---|
| `bicubic` (Catmull-Rom, B=0 C=0.5) | 43.54 |
| `bilinear` | 43.24 |
| `lanczos` | 42.89 |
| `spline` | 42.84 |
| `bicubic` (B-spline, B=1 C=0) | 41.52 |

So ~43–48 dB is what *FFmpeg itself* scores against FFmpeg with a different
kernel; the GPU compositor is at that ceiling. Identity frames are held to the
strict standard and are bit-identical.

### The gate caught three real bugs

1. **RGB→NV12 chroma matrix.** `nv12_encode.wgsl` computed
   `Cb = (B − Kr·R − Kg·G) / 2(1−Kb)`, dropping the `Kb·B` term of the colour
   difference (and the `Kr·R` term for `Cr`). Luma was correct, so the failure
   was chroma-only and scored 14.2 dB mean / 8.7 dB min.
2. **Half-width chroma packing.** The same compute pass wrote chroma words at
   `id.x / 2` and only for even `id.x`, which stretched the left half of every
   chroma row across the whole row and left the right half unwritten.
3. **One-texel bicubic offset.** The Catmull-Rom taps sit at `base−1 … base+2`,
   but the shader started at `base`, shifting every sampled frame one texel
   right. Identity sampling was off by exactly one column.

Each is now pinned by a GPU unit test in `gpu/compositor.rs` (identity ramp
position, crop position at canvas size, chroma block boundary, ring ordering,
plus `zoom_crop`'s transition quantisation in `gpu/mod.rs`). The tests skip
cleanly on a machine without a hardware adapter.

## G1 — canvas frame and background (2026-10-26)

`gpu::plan_limitations` no longer rejects canvas padding, background colour /
image / gradient / blur / dim, corner radius or the canvas shadow. The decode
sidecar now scales each segment into the **fitted content rect** and pads out to
the canvas at that rect's origin (the same `scale`→`pad` chain the compatibility
graph builds), and the compositor paints:

- the canvas background: the existing `prepare_canvas_background_plate` PNG
  (colour, gradient, image, blur, dim and the canvas shadow are all baked in by
  the current generator) sampled 1:1, or a parsed solid colour when no plate is
  needed;
- the content rect on top, with an analytic signed-distance rounded-corner mask
  (≈1 px coverage falloff), and the zoom crop applied in *content* uv so the
  crop math matches `zoompan`'s input size.

Reusing the plate generator keeps one source of truth for canvas framing and
avoids a second blur/shadow implementation on the GPU.

Parity (`--profile renderer`, single-pass on both sides):

| Spec | Frames | Mean dB | Min dB | Result |
|---|---|---|---|---|
| `abl-plain` | 900 | 100.00 | 100.00 | bit-identical |
| `abl-padding` | 900 | 43.50 | 42.25 | pass |
| `abl-radius` | 900 | 43.96 | 42.93 | pass |
| `abl-shadow` | 900 | 43.48 | 42.33 | pass |
| `abl-zoom` | 900 | 53.20 | 30.87 | pass |

Padding/radius/shadow land at the same ~43 dB resampler ceiling: the content is
fitted to 1748×984 (a 0.91× swscale downscale in the compatibility graph versus
Catmull-Rom here), so the residual is the kernel, not the framing. The framing
itself was verified visually and by unit tests (padding shows the background,
the rounded corner reveals it, the content interior survives).

## Resource lifetime and readback pipelining

The device/adapter/pipelines are process-wide (ADR 018 "Resource lifetime"), and
readback runs through a three-buffer ring. Measured on the baseline laptop in one
harness process rendering both GPU specs:

| Span | Before | After |
|---|---|---|
| wgpu device + pipelines, 1st export | ~1.8 s | ~1.8 s |
| wgpu device + pipelines, 2nd export | ~1.8 s (recreated) | **0 ms** (cached) |

The readback ring removes the per-frame `map → poll → copy` stall, but on the
30 s fixture the pipeline is still encode-bound (`encode_wait_ms` ≈ 4.8 s vs
`compose_ms` ≈ 4.4 s in an unoptimised debug build), so the wall-clock win shows
up for many-export sessions and for larger canvases rather than in a single
short export. Frame-count queues are now `RECORDFORGE_EXPORT_GPU_DECODE_QUEUE`
(8) and `_ENCODE_QUEUE` (6).

## G1 remainder, G2 and G3 (2026-10-26)

The compositor is now a layered pass, and the gate accepts every editor layer:

| Layer / feature | Where it runs | Evidence |
|---|---|---|
| Cursor tile, overlay items, keystroke badges | GPU (`layer.wgsl`, YUVA420p textures) | unit: cursor tile composites at its per-frame origin |
| Camera mask/border/shadow | GPU (`layer.wgsl` + generated plates), one decode sidecar per overlay | end-to-end: camera pixel survives the screen/background |
| Privacy masks (redact / pixelate; blur stays on FFmpeg) | GPU ping-pong stage pass (`mask.wgsl`) | unit: redact rect paints only its rect; e2e: black redact pixels |
| Side-by-side layout windows | per-frame screen rect (uniform = single decode fit, varying = per-frame draw) | e2e: uniform slot and a mid-timeline switch from full screen to slot |
| Burned-in captions | encode sidecar `subtitles` (libass) over the GPU raster | e2e: caption glyph pixels in the lower third |
| Chapters | encode sidecar `ffmetadata` + `-map_chapters` | e2e: `ffprobe -show_chapters` carries the title |
| HEVC | same encoder path + `hvc1` tag | e2e: HEVC render validates |
| Output cap | encode-side `scale=…:flags=lanczos` | e2e: 320×240 canvas capped to 160×120 validates |
| Selected range | already a zero-based plan | gate test |

The end-to-end test renders a 1 s 320×240 fixture with a side-by-side camera
bubble, a redact mask, a burned-in caption and an embedded chapter, then reads a
frame back and asserts blue screen / red camera / black mask pixels. It skips
only when no hardware adapter exists. Parity for these layers was run at G4
(below): every layer passes, redact/pixelate are shader-exact, blur masks stay on
FFmpeg, and keystrokes + burned-in captions intentionally stay on FFmpeg because
the compatibility graph draws badges above captions while the encode-side
captions run after the GPU raster.

## G4 — parity across the ablation matrix (2026-10-26)

The synthetic fixture now emits the full matrix for both renderers
(`export-synth-spec.ts`): `plain`, `padding`, `radius`, `shadow`, `zoom`,
`cursor`, `items`, `masks` (redact + pixelate), `keys` (keystroke badges),
`captions`, `camera`, plus the all-features `synth` plan and two deliberately
gated shapes (`fallback_gap`: a timeline hole, `fallback_blur`: a blur mask).
`export-bench.ts --require-gpu` fails a run that asked for the GPU renderer and
silently rendered on FFmpeg, so a gated plan cannot masquerade as a GPU row.

Command (both sides single-pass, the CPU's rate control is segmentation-agnostic):

```bash
bun run tooling/benchmarks/export-synth-spec.ts out/g4-ref --single-pass --encoder nvenc
bun run tooling/benchmarks/export-synth-spec.ts out/g4-gpu --single-pass --encoder nvenc --renderer gpu
# render both spec sets with export_harness (export-bench does this and keeps logs)
bun run tooling/benchmarks/parity.ts <ref> <gpu> --suffix _gpu --profile renderer
```

| Spec | Frames | Mean dB | Min dB | Result |
|---|---|---|---|---|
| `abl-plain` | 900 | **100.00** | **100.00** | bit-identical (bypass) |
| `abl-padding` | 900 | 46.23 | 45.72 | pass |
| `abl-radius` | 900 | 47.08 | 46.66 | pass |
| `abl-shadow` | 900 | 46.21 | 45.71 | pass |
| `abl-zoom` | 900 | 57.21 | 30.64 | pass (swscale ceiling) |
| `abl-cursor` | 900 | 45.22 | 44.59 | pass |
| `abl-items` | 900 | 51.30 | 44.71 | pass |
| `abl-masks` | 900 | 58.96 | 32.64 | pass |
| `abl-keys` | 900 | 50.32 | 44.63 | pass |
| `abl-captions` | 900 | **100.00** | **100.00** | bit-identical (bypass + encode-side libass) |
| `abl-camera` | 900 | 40.71 | 40.46 | pass |
| `synth` (all features) | 900 | 46.19 | 33.14 | pass |
| `fallback_gap` | 300 | **100.00** | **100.00** | fallback = compatibility output |
| `fallback_blur` | 300 | **100.00** | **100.00** | fallback = compatibility output |

Frame counts are exact on both sides and audio duration matches to 0 ms in every
row.

### Bugs the matrix caught

1. **Camera border was never drawn.** `generate_camera_border_png` returns PNG
   bytes, but the compositor uploaded them straight into a raw-RGBA quad. The
   border ring was missing on every GPU camera overlay: `abl-camera` scored
   34.01 dB mean (22 dB inside the bubble). Decoding the PNG fixed it to
   40.71 / 40.46 dB.
2. **Mask end-boundary off-by-one.** The GPU used `start <= t < end`, FFmpeg's
   `enable='between(t,start,end)'` includes both ends, so a mask whose span ended
   exactly on a frame timestamp was dropped one frame early (18.6 dB on that
   frame). The schedule is now inclusive and `abl-masks` passes.
3. **Pixelate block phase.** Point scaling samples the block's first column
   (`floor(k * W / Ws)`), not its centre; the shader now matches (58.96 mean).
4. **Plate raster serialized the compose loop.** The cursor/item plates are
   `~18 ms/frame` of CPU work (measured by the compatibility path's producer
   counters) and were being rendered inline. They now run on
   `producer_worker_count()` plate threads (frame `i` on worker `i % n`) behind a
   two-frame bounded queue (`RECORDFORGE_EXPORT_GPU_PLATE_WORKERS` overrides).
   `abl-cursor` dropped from 20.5 s to 13.4 s wall.

### Blur masks stay on FFmpeg (deliberate limit)

The compatibility graph's blur is `crop → scale(bilinear, ÷factor) →
avgblur(3×3) → scale(bilinear)`. swscale's bilinear **downscale** widens its
support with the factor (≈ an area average), so the shader cannot match it with
point/bilinear taps: measured 33 dB inside the mask rect and 18.6 dB on the
worst frame against a 28 dB floor. Redact and pixelate are exact (redact paints
an opaque box; pixelate is nearest-neighbour). `gpu::plan_limitations` therefore
keeps any enabled blur mask on the compatibility renderer with a logged reason;
the `fallback_blur` matrix row proves that path still renders bit-identically.
The follow-up is to reproduce swscale's weighted downscale in a downscale pass,
not to loosen the gate.

### Per-feature measurement (30 s fixture, NVENC, one run each)

| Spec | Compat wall s | GPU wall s | Compat graph ms | GPU compose ms | GPU realtime |
|---|---|---|---|---|---|
| `abl-plain` | 7.59 | 8.18 | 4917 | 0 (bypass) | 4.2× |
| `abl-padding` | 8.71 | 10.62 | 5925 | 6130 | 3.2× |
| `abl-radius` | **15.80** | **10.61** | 12964 | 6024 | 3.2× |
| `abl-shadow` | 9.55 | 11.00 | 6126 | 6056 | 3.0× |
| `abl-zoom` | 8.10 | 8.93 | 5325 | 2020 | 3.8× |
| `abl-cursor` | 10.91 | 13.40 | 8332 | 8765 | 2.4× |
| `abl-items` | 9.66 | 10.86 | 7012 | 5355 | 3.1× |
| `abl-masks` | 7.89 | 8.99 | 5119 | 2307 | 3.8× |
| `abl-keys` | 8.22 | 9.17 | 5627 | 3171 | 3.7× |
| `abl-captions` | 7.66 | 8.58 | 5118 | 0 (bypass) | 4.0× |
| `abl-camera` | 14.18 | **12.40** | 10351 | 5984 | 2.7× |

Reading: the GPU wins where the compatibility graph is expensive (corner radius
forces its RGBA `alphamerge` round trip: **1.49×**; a camera overlay adds a
decode sidecar and mask/border/shadow plates: **1.14×**) and is ~10 % slower
everywhere else on this laptop, because the export is encode-bound at
~4.3 s/900 frames and the pipeline pays a decode-sidecar → Rust → encode-sidecar
copy (~3.1 MB/frame each way) that the in-process FFmpeg graph does not. An
interleaved A/B (`plain` 7.8/8.3/7.8 s vs GPU 8.7/13.4/9.3 s; `zoom` 8.4/8.8/8.3
vs 9.6/9.7/9.5) confirms the ordering is not a thermal artefact. Removing that
copy needs D3D11/Metal interop (already the ADR's future work).

## G5 — `auto` selects the GPU by default (2026-10-26)

`GPU_ENABLED_BY_DEFAULT = true`. `renderer: "auto"` now resolves to the wgpu
compositor whenever `plan_limitations` is empty and the adapter is real hardware
(WARP/llvmpipe/SwiftShader/CPU devices are still refused at device creation).

Two guards keep the default honest:

- **Passthrough-only plans stay on FFmpeg.** If the whole timeline would bypass
  the compositor (identity zoom, no layers/masks/keystrokes, plain full-canvas
  fit), there is nothing to composite and the cross-process copy is pure cost, so
  `auto` keeps the compatibility renderer. An explicit `gpu` request still honours
  the preference.
- **Three-strike failure gate.** Three consecutive runtime GPU failures (no
  adapter, device loss, sidecar error) drop `auto` back to FFmpeg for the rest of
  the process; a successful GPU render resets the counter, and an explicit `gpu`
  request keeps trying. `RECORDFORGE_EXPORT_GPU=0` is the manual opt-out.

Failure-rate evidence from the matrix: 12/12 GPU-requested specs rendered on the
GPU (the two `fallback_*` shapes are intended fallbacks and scored bit-identical
to the compatibility output), and the earlier forced-failure run (invalid shader)
fell back and produced a valid file — 0 unrecovered failures, 0 bad outputs.

Known limitation, stated plainly: on the baseline laptop the default is a
performance *parity* change for most plans (see the table above), not the 4×
target; it is a win for rounded-corner and camera-heavy exports. The renderer
selector and the env opt-out remain available.

## Follow-ups

1. **Pipe overhead.** The decode → Rust → encode hop costs ~3.1 MB/frame each
   way. D3D11/Metal interop (or feeding the encoder from the decoder's shared
   texture) is what would make `auto` a clear win for layered plans too.
2. **Blur parity.** Reproduce swscale's widened bilinear downscale in a
   dedicated GPU downscale pass (or pre-blur the rect on the CPU) so blur masks
   can come back into the gate.
3. **Camera decoders are read synchronously** in the compose loop; a bounded
   prefetch per camera overlay is the next producer-side optimisation if
   `abl-camera` stays compose-bound.
4. **Compose cost.** The 1:1 luma fast path helped only marginally; an
   `Rgba16Float` stage is 8 bytes/pixel, so a 16-bit-per-channel YUV stage or a
   direct NV12 blend target is the larger lever.
