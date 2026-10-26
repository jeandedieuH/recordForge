# ADR 018: Native GPU Export Compositor (wgpu)

## Status

Accepted - Phase 5, milestones G0-G3 implemented (2026-10-26)

## Context

ADR 004 keeps FFmpeg as the decode/encode engine, and the export renderer built
on it is one large `filter_complex` graph per pass. Every overlay layer —
screen fit, background plate, rounded corners, zoom, camera, cursor plate,
items, masks, captions — is a filter stage. Measurement (`docs/benchmarks/`)
shows the graph is CPU-bound: on the baseline i5-11400H / RTX 3050 laptop a
30 s 1080p30 fixture renders at 0.93× realtime even after Phase 1 and Phase 2
removed the largest per-frame costs. Phases 1–2 lowered the constant factor;
they cannot move the work to the GPU that is otherwise idle during export.

The editor preview already composites on the GPU in the webview. The export
path should be able to do the same for the layers that are pure pixel work,
while keeping FFmpeg for what it is uniquely good at: hardware-accelerated
decode, hardware encoders, muxing, and burn-in caption parity via libass.

## Decision

Add an optional native compositor built on `wgpu`, selected per export through
`ExportSettings.renderer` (`auto` | `gpu` | `compatibility`).

### Pipeline

```
FFmpeg (decode sidecar)        wgpu (render thread)          FFmpeg (encode sidecar)
screen segments ──┐                                          ┌── audio graph (existing)
trim/setpts/fps   │  rawvideo NV12   YUV→RGB   compose   RGB→NV12   rawvideo NV12   │   h264/hevc + mux
scale/pad/concat ─┴─► stdout ──────► battery ─► readback ─┴─► stdin ────────────────┘
```

- **Decode** reuses the compatibility renderer's per-segment chain (`trim`,
  `setpts`, speed, `fps`, `scale`, `pad`, `tpad`, `concat`) so frame counts,
  timestamps and seams stay identical. It emits `rawvideo`/`nv12` on stdout.
  `-hwaccel auto` decodes on the GPU and downloads each frame once; it is opt-in
  because the download cancels the win for a system-memory compositor.
- **Compose** uploads the NV12 planes, samples them with a Catmull-Rom bicubic
  shader through an integer crop rect from `camera::zoompan_integer_crop`, and
  writes an `Rgba16Float` canvas. Colour conversion is BT.601 limited both ways,
  matching swscale's assumption for the untagged screen chain.
- **Layers** are drawn in the compatibility graph's stack order: cursor tile,
  camera shadow/bubble/border, privacy masks, overlay items, then keystroke
  badges. Generated plates reuse the existing Rust rasterizers
  (`CursorFramePlan`/`OverlayWorkerState`) and upload YUVA420p planes; camera
  overlays are shaped, opacity-blended NV12 quads fed by one decode sidecar
  each. Two RGBA16Float stage targets ping-pong through mask passes, so
  redact/blur/pixelate never need an extra copy or a CPU pass. Side-by-side
  layout windows are per-frame destination rects (a uniform layout decodes
  straight into the slot; a varying layout scales the full picture per frame).
- **Burned-in captions stay in FFmpeg** (libass parity) on the GPU raster:
  `subtitles` runs in the encode sidecar before the final pixel-format/scale
  stage. Chapters, HEVC tagging and the license output cap ride the same
  encoder command.
- **Pack** runs a compute shader that converts RGB→NV12 into a storage buffer
  whose layout is byte-for-byte the encoder's expected pixel format, so the
  readback feeds the encoder stdin with no further conversion or copy.
- **Encode** is the existing `append_export_video_args` / audio graph /
  `hvc1` / `faststart` path, driven from stdin instead of a filter graph.
- **Identity frames bypass the GPU entirely.** A frame whose zoom transform is
  the identity is forwarded from decoder to encoder untouched, which is both
  the fastest case and bit-exact against the compatibility path (whose
  piecewise zoom also passes identity runs through).

### Resource lifetime

The device, adapter and pipelines are process-wide. Creating them costs
~1.5–2.5 s on the baseline laptop (adapter probe, DX12 device, naga/FXC shader
compile), which is a large share of a short export, and none of it depends on
the canvas size. Only the size-dependent planes, render target, bind groups and
readback buffers are allocated per export. A cached device that reports a loss
is dropped, so the next export builds a fresh one. `RECORDFORGE_EXPORT_GPU_CACHE=0`
disables reuse for measurement.

Readback is pipelined: three host-visible buffers form a ring, a submit returns
the frame that has been on the GPU longest, and the async map is started at
submit time. The compose loop therefore overlaps GPU work with the CPU copy and
the encoder write instead of blocking on every frame.

### Selection and fallback

`renderer = auto` resolves to the compatibility renderer today
(`GPU_ENABLED_BY_DEFAULT = false`); milestone G5 flips it once the parity and
failure-rate gates hold. `RECORDFORGE_EXPORT_GPU=1` opts `auto` in for A/B
benchmarks. `renderer = gpu` asks for the GPU path explicitly and still
degrades per feature.

`gpu::plan_limitations` is the single source of truth for what the compositor
supports. Anything outside it keeps the FFmpeg renderer: timeline gaps and
coverage holes, mixed or unknown source dimensions, animated containers
(GIF/WebP), canvases that are not a 4×2 NV12 grid, and the one stack-order pair
the hybrid cannot express (keystroke badges must sit above burned-in captions,
but captions run through libass in the encode sidecar after the GPU raster).
Canvas framing, letterboxed fits, zoom, cursor/items, camera and side-by-side,
privacy masks, keystrokes, burned-in captions, chapters, HEVC, the license
output cap, and selected-range plans are in scope. Explicit `gpu` requests that
fall outside the gate render on FFmpeg with the reason logged — failing an
export over a renderer preference would be worse than rendering it on the path
that works.

Runtime failures (no qualifying adapter, device loss, sidecar failure) also
fall back once to the compatibility renderer, mirroring the existing
hardware→software encoder retry.

Adapters are rejected when they are software rasterizers (CPU device type, or
WARP/llvmpipe/SwiftShader names): the GPU path must not silently become a
slower software path.

### Scope and boundaries

- No new Tauri capabilities; the compositor runs inside the existing export
  worker.
- The decode filter graph is passed inline and plans larger than
  `MAX_INLINE_FILTER_LEN` stay on FFmpeg. Generated assets (caption directory,
  chapter `ffmetadata`, camera border/shadow plates) are ordinary export temp
  files under the existing guards; camera shadow plates are deleted as soon as
  they are uploaded.
- Frame data never leaves Rust.
- `wgpu` is pinned in `apps/desktop/src-tauri/Cargo.toml` with the `dx12`,
  `metal`, `vulkan`, `gles` and `wgsl` backends only.

### Milestones

| Gate | Scope |
|---|---|
| G0 | Passthrough + zoom at canvas size (implemented) |
| G1 | Background plate, canvas frame/corners/shadow, cursor tile, overlay items (implemented) |
| G2 | Camera mask/border/shadow, privacy masks, keystrokes, side-by-side (implemented) |
| G3 | Captions (libass burn-in in the encode sidecar), chapters, HEVC, output cap, selected range (implemented) |
| G4 | Parity suite across the ablation matrix; ships behind the setting |
| G5 | `auto` turns GPU on by default once parity and failure gates hold |

G0 closed its parity question in favour of a *methodology* fix rather than a
pixel fix: the renderer's encode input is bit-exact, and the residual gap is the
resampler kernel. Two real shader bugs were found while proving it (RGB→YUV
chroma matrix, half-width chroma packing) plus a one-texel bicubic tap offset;
see `docs/benchmarks/phase-5-results.md`.

## Consequences

- Export can use the GPU that capture and preview already leave idle, which is
  the only remaining lever once per-frame CPU work is minimized.
- Two renderers now exist. The FFmpeg graph stays authoritative: it renders
  every feature, it is the fallback, and it is the parity reference for the GPU
  path.
- A cross-process pipeline (decode | compose | encode) adds an NV12 copy per
  frame over what a single FFmpeg process does. That is ~3.1 MB/frame at
  1080p, which the pipe handles; 4K tops out around 100 fps over pipes, and
  D3D11/Metal interop is future work.
- Any pixel difference (colour conversion, resampler) needs the parity gate,
  not visual review.
- Driver bugs and device loss are inherent to shipping a GPU path; the
  automatic fallback and the `compatibility` setting are the mitigations.

## Alternatives Considered

- **Keep tuning the FFmpeg graph.** Phases 1–2 already did the available
  per-frame work; the remaining cost is the work itself, not its layout.
- **Link a native FFmpeg filter with CUDA/Vulkan filters.** Ties the export
  to one vendor stack and cannot express SDF corners, item rasterization or
  the camera mask composition shared with the preview.
- **Move compositing into the webview/canvas.** Frame data would cross the IPC
  boundary, which the architecture rules forbid.
