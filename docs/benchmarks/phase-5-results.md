# Phase 5 results — native GPU export compositor (G0)

> Measured 2026-10-26 on the baseline laptop (i5-11400H, RTX 3050 Laptop,
> Windows 11). Synthetic 30 s 1080p30 fixture from
> `tooling/benchmarks/export-synth-spec.ts`, `renderer` the only variable.
> Timing tables are from a release `export_harness` build; parity and the
> resource-lifetime re-measurement were taken with a debug harness (parity is
> encoder- and shader-side, so it is build-independent).

## What shipped

Milestone **G0** of the Phase 5 plan — passthrough + zoom through a native wgpu
compositor, with FFmpeg kept as the decode and encode sidecar — plus **G1**'s
canvas frame (padding, background colour/gradient/image/blur/dim, rounded
corners, canvas shadow). ADR 018 records the architecture;
`docs/specs/media-jobs-render-plan.md` §5.6 the contract.

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

`gpu::plan_limitations` keeps a plan on the FFmpeg renderer unless it is a
full-canvas screen plane (optionally zoomed) with no overlay layers, no canvas
frame/background, no timeline gaps, MP4/H.264 delivery, and a canvas that fits
a 4×2 NV12 grid. Explicit `gpu` requests outside the gate degrade with a logged
reason; runtime failures fall back once to the compatibility renderer.

Verified end-to-end with `spec_synth_chunked_gpu` (the all-features plan): the
gate rejects it (padding, radius, shadow, cursor, items, captions) and the
export finishes on the FFmpeg renderer with exit 0 — the fallback is the same
deliverable as before. A forced-failure run (invalid shader, see below) also
fell back and produced a valid file.

## Timings

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

## Parity

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
| Privacy masks (redact / blur / pixelate) | GPU ping-pong stage pass (`mask.wgsl`) | unit: redact rect paints only its rect; e2e: black redact pixels |
| Side-by-side layout windows | per-frame screen rect (uniform = single decode fit, varying = per-frame draw) | e2e: uniform slot and a mid-timeline switch from full screen to slot |
| Burned-in captions | encode sidecar `subtitles` (libass) over the GPU raster | e2e: caption glyph pixels in the lower third |
| Chapters | encode sidecar `ffmetadata` + `-map_chapters` | e2e: `ffprobe -show_chapters` carries the title |
| HEVC | same encoder path + `hvc1` tag | e2e: HEVC render validates |
| Output cap | encode-side `scale=…:flags=lanczos` | e2e: 320×240 canvas capped to 160×120 validates |
| Selected range | already a zero-based plan | gate test |

The end-to-end test renders a 1 s 320×240 fixture with a side-by-side camera
bubble, a redact mask, a burned-in caption and an embedded chapter, then reads a
frame back and asserts blue screen / red camera / black mask pixels. It skips
only when no hardware adapter exists. The parity matrix (`parity.ts`) has not
been rerun for the new layers yet; mask blur/pixelate approximate the
FFmpeg downscale/avgblur/upscale graph, and keystrokes + burned-in captions
intentionally stay on FFmpeg because the compatibility graph draws badges above
captions while the encode-side captions run after the GPU raster.

## Follow-ups

1. **G4**: extend the parity suite across the whole ablation matrix (cursor /
   items / camera / masks / captions), add a per-feature row, and measure the
   new layered passes on the 30 s fixture. The renderer budget is already in
   `parity.ts`. The GPU path currently rasterizes generated plates on the
   compose thread (the compatibility path uses a producer pool) and reads each
   camera decoder synchronously; if the matrix shows plate-bound exports, a
   bounded plate-producer queue is the first optimization.
2. **G5**: flip `auto` once the parity and failure-rate gates hold.
