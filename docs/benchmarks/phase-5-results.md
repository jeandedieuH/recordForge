# Phase 5 results — native GPU export compositor (G0)

> Measured 2026-10-26 on the baseline laptop (i5-11400H, RTX 3050 Laptop,
> Windows 11). Synthetic 30 s 1080p30 fixture from
> `tooling/benchmarks/export-synth-spec.ts`, `renderer` the only variable.
> Timing tables are from a release `export_harness` build; parity and the
> resource-lifetime re-measurement were taken with a debug harness (parity is
> encoder- and shader-side, so it is build-independent).

## What shipped

Milestone **G0** of the Phase 5 plan: passthrough + zoom through a native wgpu
compositor, with FFmpeg kept as the decode and encode sidecar. ADR 018 records
the architecture; `docs/specs/media-jobs-render-plan.md` §5.6 the contract.

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

### Three real bugs the gate caught

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

## Follow-ups

1. **G1**: background plate, canvas frame/radius/shadow, cursor tile, items.
2. **G2**: camera mask/border/shadow, privacy masks, keystrokes, side-by-side.
3. **G3**: captions, chapters, HEVC, output cap, selected range.
4. **G4/G5**: extend the parity suite across the ablation matrix, then flip
   `auto`. The renderer budget is already in `parity.ts`; G4 adds a per-feature
   row so a regression in one layer cannot hide behind the mean.
