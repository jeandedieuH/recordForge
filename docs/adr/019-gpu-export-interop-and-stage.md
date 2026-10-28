# ADR 019: Zero-Copy Export Interop and a YUV Stage Target

## Status

Proposed — follow-up to ADR 018. A temporary Windows shared-texture handoff
spike passed on 2026-10-28 (removed after the spike); the in-process encoder
decision is still open. No production code depends on this yet.

## Context

ADR 018 shipped the native wgpu export compositor and made `renderer: auto`
prefer it. The G4/G5 measurements (`docs/benchmarks/phase-5-results.md`) show
two remaining costs that keep `auto` from being a clear win on every layered
plan:

1. **The cross-process hop.** Every frame travels
   `FFmpeg decode → pipe → Rust Vec → wgpu upload → … → wgpu readback → Vec →
   pipe → FFmpeg encode`. At 1080p NV12 that is ~3.1 MB per frame each way
   (~186 MB/s at 30 fps), plus two `read`/`write` syscall streams. A single
   in-process FFmpeg graph never pays it.
2. **The compositor stage is 8 bytes/pixel.** The two ping-ponged
   `Rgba16Float` targets are ~16.6 MB each at 1080p. Every layer and every mask
   pass writes one, and the final pack reads one to produce 3.1 MB of NV12.
   The G4 measurement showed the 1:1 luma fast path helped only marginally;
   target bandwidth, not ALU, is the dominant compose cost.

The two are related: an interop path that hands the encoder a hardware surface
also removes the RGB→NV12 pack, while a smaller stage reduces the copy that
interop cannot avoid.

## Decision

Treat both as a single Phase 6 program, gated independently. Neither is allowed
to land without the G4 parity matrix and the per-feature timing table.

### A. Shared-texture interop (remove the pipe hop)

Introduce a `gpu::interop` boundary with a capability probe and a mandatory
fallback to the current pipes. The compatibility renderer stays authoritative.

Data path per platform:

| Platform | Decode → compositor | Compositor → encode |
| --- | --- | --- |
| Windows | FFmpeg D3D11VA (`AVHWFramesContext`) → DXGI shared NT handle → D3D11On12 → wgpu DX12 external texture | wgpu DX12 texture → shared NT handle → D3D11 encoder input (`h264_nvenc` / `hevc_nvenc` / `h264_qsv` / `hevc_qsv` / `h264_amf`) |
| macOS | VideoToolbox `CVPixelBuffer` → `IOSurface` → `MTLTexture` → wgpu Metal external texture | wgpu Metal texture → `IOSurface`-backed `CVPixelBuffer` → VideoToolbox encoder |
| Linux | VAAPI/DRM prime `dmabuf` → `VK_EXT_external_memory_dma_buf` → wgpu Vulkan external texture | wgpu Vulkan texture → exported `dmabuf` → VAAPI encoder input |

Implementation constraints:

- `wgpu` 30 exposes raw backend resources only through the `hal` feature and
  `unsafe` (`Texture::as_hal`, device/queue HAL access). That is a new native
  trust boundary and must be reviewed as such; it does not add a Tauri
  capability and frame data still never enters React.
- FFmpeg must be driven with hardware frames end to end (`-hwaccel`,
  `AVHWDeviceContext`, `AVHWFramesContext`, encoder `hw_frames_ctx`). A
  download/upload in the middle defeats the purpose and must fail the capability
  check.
- The decode filter graph currently uses CPU filters (`trim`, `setpts`,
  `fps`, `scale`, `pad`, `tpad`, `concat`). Hardware frames can only skip the
  copy if that chain is expressible on the hardware path or the decode sidecar
  writes straight into the compositor's canvas texture. Phase 6 therefore
  starts with the *plain, common-dimension, no-retime* case and keeps the pipe
  path for everything else.
- The compositor still needs CPU-visible pixels for privacy-mask readback?
  No — masks are GPU passes. Readback is only needed when the encoder cannot
  consume the shared surface, so each side is independently optional.

Phasing:

1. Instrument the copy cost separately from compose/encode (per-frame
   `upload_ms`, `readback_ms`, `pipe_write_ms`) so a regression or a win is
   attributable. Done 2026-10-28.
2. Windows shared-texture handoff: D3D12 shared resource → wgpu → NT handle →
   D3D11On12 `OpenSharedResource1` → NV12 plane readback. Proven by a temporary
   probe on 2026-10-28; the probe was removed after the spike.
3. Choose and wire the encoder that consumes the NV12 D3D11 surface: a custom
   FFmpeg import filter (preserves audio/mux/captions), in-process libavcodec
   (keeps codec mapping, moves mux/captions), or the vendor SDK (narrowest
   Windows-only spike). FFmpeg CLI cannot import an external texture.
4. Windows encode-side feed, measured against the G6 `synth`/`abl-radius`
   rows and the existing failure fallback.
5. Windows decode-side shared texture for the plain case.
6. Metal `IOSurface` path, then Vulkan `dmabuf`.
7. `auto` may prefer interop when a shared-texture path is available;
   `renderer: gpu` still requests the compositor, and `compatibility` never
   uses it.
8. Three-strike runtime fallback stays: a failed shared-texture allocation or
   device loss drops back to the pipe path for the rest of the process.

### Handoff spike (2026-10-28)

A temporary Windows-only probe created a D3D12 shared committed resource,
wrapped it in wgpu (RGBA, and NV12 as an `R8`/`Rg8` plane pair), wrote a
deterministic pattern, transitioned it to `COMMON`, exported an NT handle,
opened it with D3D11On12 + `OpenSharedResource1`, staged it, and compared every
byte. Both formats passed at 1920×1080: RGBA open/write/copy 21/4/3 ms; NV12
19/1/1 ms. The probe was removed after the spike; the measurements are retained
in `docs/benchmarks/phase-6-results.md`.

That closes the handoff risk. The remaining blocker is encoder integration: the
FFmpeg CLI cannot import an external texture. The options are:

- **Custom FFmpeg build + import filter.** Add a small source filter that maps
  the shared handle into an `AVHWFramesContext`, then feed the existing
  filter/encoder graph. Preserves audio, muxing, chapters and libass captions;
  cost is a custom FFmpeg build per platform.
- **In-process libavcodec.** Wrap the D3D11 surface in `AVHWFramesContext` and
  call `h264_nvenc`/`hevc_nvenc`/QSV/AMF directly. Keeps codec/preset mapping,
  but muxing, audio and caption burn-in have to move out of the CLI sidecar (or
  captioned plans stay on the pipe path).
- **Vendor SDK (NVENC/AMF/QSV).** Narrowest Windows-first spike; duplicates
  encoder logic and has the same mux/caption move.

Recommendation: take the custom FFmpeg import-filter path if caption/audio/mux
parity is non-negotiable; take the vendor SDK only for a Windows-only perf
prototype. The handoff spike was intentionally kept out of the export loop and
has been removed from the tree.

### Measured hop (2026-10-28)

`render_timeline_on_gpu` now reports `decode_read_ms`, `upload_ms`,
`readback_ms` split into `readback_wait_ms` / `readback_copy_ms`, plus
`pipe_write_ms`, `plate_raster_ms`, `plate_wait_ms` and `camera_wait_ms`.
Release-harness runs (`docs/benchmarks/phase-6-results.md`) show:

- pass-through plans are dominated by `pipe_write` (~56 % of elapsed) plus the
  decode read — pure hop, no GPU work to hide it;
- on composed plans the **actual CPU copy** out of the readback buffer is
  2.96 s of 13.25 s (`abl-radius`, 22 %), 2.23 s of 13.66 s (`abl-camera`,
  16 %) and 2.86 s of 23.2 s (`synth`, 12 %);
- `readback_wait` (GPU completion) and `pipe_write` (mostly encoder
  backpressure) are not removed by sharing the surface, so the realistic
  encode-side win is **10–20 %**, not the 40–55 % a raw wait+pipe sum implies;
- `synth` is also plate-heavy (44.9 s aggregate raster across workers), so
  interop helps it least.

That ordering makes **encode-side interop the first prototype** only if a
10–20 % wall win on layered plans is worth the encoder integration. It does not
require re-expressing the decode filter graph on hardware frames. Decode-side
follows.

Expected ceiling: removing both copies is bounded by the encoder/compose time,
not by pipe throughput. On the baseline laptop the encode pass is ~4.3 s per
900 frames and compose ~6 s for layered plans, so the realistic win is a
10–20 % wall-clock reduction on layered plans, not the 4× G5 target. The
important property is that `auto` stops paying a tax on plans where the GPU has
work to do.

### B. YUV / direct-NV12 stage

Replace the `Rgba16Float` stage with a YUV stage. Two candidate layouts:

| Layout | Bytes/px at 1080p | Notes |
| --- | --- | --- |
| `R16Float` Y + `Rg16Float` CbCr (4:2:0) | 4 | 16-bit per channel, preserves intermediate precision; still needs a pack pass |
| `R8Unorm` Y + `Rg8Unorm` CbCr (NV12) | 1.5 | matches FFmpeg's 8-bit yuv420 pipeline and removes RGB↔YUV work; direct plane copy to the encoder buffer |

The second is the larger lever and the more parity-faithful one: the
compatibility graph already composites in 8-bit yuv420, so a per-plane stage
removes the RGB round trip for the screen, camera, cursor and overlay quads
instead of adding one. The trade-off is that any future high-bit-depth export
needs the 16-bit layout, so the stage format is selected at compositor
creation, not baked into the shaders' public surface.

Required changes:

- Shaders output two color attachments (`Y`, `CbCr`) instead of one RGBA. The
  composite pass converts the background plate once and mixes in YUV; the
  layer pass alpha-blends Y/U/V per plane (which is what FFmpeg's `overlay`
  does), and the screen/camera paths skip YUV→RGB entirely.
- Privacy masks run per plane. The multi-scale blur path already does this
  (Y at full small-grid resolution, chroma at half resolution), so the stage
  change can reuse that split instead of inventing a second one. The small-grid
  textures become two planes (or one `Rg16` + one `R8`).
- The NV12 pack becomes a plane copy, not a color conversion. Keep a compute
  shader rather than `copy_texture_to_buffer`: WebGPU requires a 256-byte
  `bytes_per_row` alignment, and 1920 is not a multiple of 256. The shader
  writes Y then interleaved UV into the existing storage buffer.
- Captions, chapters and the output cap stay in the encode sidecar.

Validation:

- The G4 matrix must be re-run at equal encode segmentation. Blur masks are
  now in the gate (see below), so `masks` and the blur spec must clear the
  renderer profile (mean ≥ 40 dB, min ≥ 28 dB); identity/plate-free plans must
  stay bit-identical.
- Compose time is compared per feature at 1080p30 with NVENC, using the same
  cached-device harness invocation (multiple specs in one process) so the
  device/pipeline setup is not counted as compose.
- If direct NV12 parity is below the floor, fall back to the 16-bit YUV layout
  before abandoning the change; the RGBA stage is the last resort.

## Consequences

- Phase 6 is optional and additive. The pipe path and the RGBA16Float stage
  remain the fallback and the parity reference until both replacements pass.
- Interop introduces `unsafe` native code and platform-specific CI. That cost
  is concentrated in one module and can be feature-gated per platform.
- The YUV stage may improve parity by removing a lossy RGB round trip, but it
  is a large shader change: every pipeline, mask pass and pack path is touched.
  It should not be attempted in the same change as interop.
- The immediate, low-risk wins from the Phase 5 follow-ups — exact blur parity
  and bounded camera prefetch — do not depend on this ADR and land separately.

## Alternatives Considered

- **Splice/`vmsplice` on Linux only.** Removes syscall copies but not the
  device upload/readback, and does nothing on Windows/macOS.
- **Keep RGBA and lower precision to `Rgba8Unorm`.** 4 bytes/pixel, but
  blending and bicubic sampling in 8-bit linear RGB bands on gradients; it is
  neither the parity-faithful YUV path nor the full 16-bit path.
- **Move the composer into FFmpeg with a custom filter.** Ties export to one
  vendor stack and cannot share the editor's SDF/layer rasterizers (ADR 018
  already rejected this).
