# Phase 6 — Gate, Camera Queue A/B, and Hop Instrumentation (2026-10-28)

This pass closes the Phase 5 blur/prefetch work and measures the decode → compose
→ encode hop before committing to ADR 019.

## G6 matrix — full parity after the blur/prefetch changes

Fixture: `export-synth-spec.ts --single-pass --encoder nvenc` for both sides,
`--renderer gpu` on the candidate; rendered with the release `export_harness`
(parity is content-based, not speed-based). `parity.ts --suffix _gpu --profile
renderer`:

| Spec | Frames | Mean dB | Min dB | Result |
|---|---:|---:|---:|---|
| `abl-camera` | 900 | 40.71 | 40.46 | PASS |
| `abl-captions` | 900 | 100.00 | 100.00 | PASS (bypass + libass) |
| `abl-cursor` | 900 | 45.22 | 44.59 | PASS |
| `abl-items` | 900 | 51.30 | 44.71 | PASS |
| `abl-keys` | 900 | 50.32 | 44.63 | PASS |
| `abl-masks` | 900 | 58.96 | 32.64 | PASS |
| `abl-padding` | 900 | 46.23 | 45.72 | PASS |
| `abl-plain` | 900 | 100.00 | 100.00 | PASS (bypass) |
| `abl-radius` | 900 | 47.08 | 46.66 | PASS |
| `abl-shadow` | 900 | 46.21 | 45.71 | PASS |
| `abl-zoom` | 900 | 57.21 | 30.64 | PASS |
| `blur` (multi-scale, radius 24) | 300 | 50.36 | 29.89 | PASS |
| `fallback_gap` | 300 | 100.00 | 100.00 | PASS (fallback) |
| `synth` (all features) | 900 | 46.19 | 33.14 | PASS |

All rows have exact frame counts and audio Δ0 ms. The blur row is the new gate
member; `fallback_gap` is the remaining intentionally-gated shape.
`export-bench --filter blur --require-gpu` also passed, so the blur row was not
a silent compatibility fallback.

## Camera prefetch A/B (`abl-camera`, 900 frames, release harness)

`RECORDFORGE_EXPORT_GPU_CAMERA_QUEUE` swept 1/2/4, five interleaved rounds each
(averages):

| Depth | Elapsed ms | Compose ms | Decode read ms | Upload ms | Readback ms | Pipe write ms |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 12,008 | 7,035 | 3,179 | 1,718 | 4,099 | 2,015 |
| 2 | 11,958 | 6,945 | 3,154 | 1,704 | 4,045 | 1,991 |
| 4 | 12,035 | 7,045 | 3,195 | 1,716 | 4,125 | 1,995 |

Depth 2 is ~0.4 % faster than depth 1 and depth 4 is within noise; there is no
clear win from a deeper queue. Keep the default at 2 for latency smoothing, not
as a claimed speedup.

## Hop instrumentation

`render_timeline_on_gpu` now logs aggregate per-direction costs:

- `decode_read_ms` — time spent reading decoded NV12 from the decode sidecar
  (reader thread, overlaps compose),
- `upload_ms` — CPU→GPU `write_texture` of the screen frame,
- `readback_ms` — GPU→CPU map/copy of the composed NV12 frame (includes waiting
  for GPU completion),
- `pipe_write_ms` — encoder stdin write (writer thread),
- existing `compose_ms`, `decode_wait_ms`, `encode_wait_ms`.

`upload_ms` and `readback_ms` are subsets of `compose_ms` (they happen inside
`submit`/`pop_ready`), so they are not additive with it. `decode_read_ms` and
`pipe_write_ms` are measured in the sidecar threads and overlap the compose
loop; treat them as shares/directions, not a sum that equals `elapsed_ms`.

Release-harness runs, one each (all 1080p, NVENC; `blur` is 300 frames, the rest
900):

| Spec | Elapsed | Compose | Decode read | Upload | Readback | Pipe write |
|---|---:|---:|---:|---:|---:|---:|
| `synth` | 18,977 | 12,518 | 3,937 | 1,955 | 5,150 | 3,068 |
| `abl-plain` | 8,594 | 7 | 4,105 | 0 | 0 | 4,820 |
| `abl-radius` | 11,275 | 7,498 | 3,333 | 1,956 | 4,438 | 1,745 |
| `blur` | 5,717 | 1,767 | 1,296 | 413 | 1,005 | 1,034 |

Reading:

- **Pass-through plans** are dominated by the pipe: `pipe_write` is ~56 % of
  elapsed and the decode read is the other side of the same copy. There is no
  GPU work to hide it.
- **Composed plans** spend the largest transfer share in readback: 5.2 s of
  19.0 s on `synth` (27 %) and 4.4 s of 11.3 s on `abl-radius` (39 %), versus
  ~2.0 s of upload. Readback includes waiting for the GPU, so it is an upper
  bound on the copy itself.
- `encode_wait`/`decode_wait` are small once the sidecar queues have frames, so
  the remaining cost is per-frame transfer, not queue starvation.

Conclusion: **encode-side shared-texture interop is the first prototype**, since
it removes the readback plus the stdin write in one move. Decode-side interop
second; the YUV stage after that, gated on another matrix run.

## Wait vs copy split (release harness)

The earlier `readback_ms` and `pipe_write_ms` included waits. The split now
separates the actual CPU copy from GPU/encoder waiting:

| Spec | Elapsed | Readback wait | **Readback copy** | Upload | Pipe write | Plate raster (aggregate) | Plate wait |
|---|---:|---:|---:|---:|---:|---:|---:|
| `synth` | 23,215 | 4,383 | **2,859** | 1,615 | 3,353 | 44,857 | 1,155 |
| `abl-radius` | 13,251 | 2,041 | **2,958** | 1,877 | 1,916 | 0 | 0 |
| `abl-camera` | 13,662 | 1,951 | **2,228** | 1,578 | 2,092 | 0 | 0 |
| `blur` | 6,688 | 424 | **594** | 507 | 1,199 | 0 | 0 |

`readback_copy` is the cleanly removable part for encode-side interop:
**22 % of wall on `abl-radius`, 16 % on `abl-camera`, 12 % on `synth`, 9 % on
`blur`**. `readback_wait` is GPU completion; `pipe_write` is mostly encoder
backpressure, neither of which interop removes. `upload` is the decode-side
copy and needs decode-side interop separately.

`plate_raster` is aggregate CPU time across the plate workers, not wall time;
it confirms `synth` is also CPU-heavy, so interop would help it least.

**Decision gate result:** encode-side interop has a credible **10–20 %** wall
case on layered non-plate plans, not the 40–55 % the raw wait+pipe numbers
suggested. Proceed only if that is a product priority; otherwise the next
lever is plate raster/compose, not encoder interop.

## Shared-texture handoff spike (Windows, 2026-10-28; probe removed)

A temporary dev-only probe ran two cases behind the `export-harness` feature:

1. a 1920×1080 RGBA D3D12 committed resource with `D3D12_HEAP_FLAG_SHARED`,
2. a 1920×1080 NV12 resource wrapped as an `R8Unorm` luma plane and an
   `Rg8Unorm` chroma plane via `with_plane_slice(0/1)`.

Each case wrote a deterministic pattern through wgpu, transitioned the resource
to `COMMON`, created an NT handle with `ID3D12Device::CreateSharedHandle`, opened
it on a D3D11On12 device with `OpenSharedResource1`, copied to a staging
texture, mapped it, and compared every byte.

| Case | Size | Open | wgpu write | D3D11 stage/copy | Bytes |
|---|---|---:|---:|---:|---|
| RGBA8 | 1920×1080 | 21 ms | 4 ms | 3 ms | exact |
| NV12 | 1920×1080 | 19 ms | 1 ms | 1 ms | exact |

`open` includes creating the D3D11On12 device on the same D3D12 adapter; the
handoff itself is the small write + copy numbers. This is the proof ADR 019
wanted before committing to an encoder path: the shared-resource half works.
The probe code and its Windows dependency features were removed after the
spike; the measurements are retained here.

**Remaining blocker:** the FFmpeg **CLI** sidecar cannot import an external
D3D11/DX12 texture. `h264_nvenc`/`hevc_nvenc`, QSV, and AMF can consume this
NV12 surface only through an in-process `AVHWFramesContext` (libavcodec), a
custom FFmpeg import filter, or the vendor SDK. The next decision is which
encoder integration to take; the handoff is no longer the risk.

## Reproduction

```powershell
bun run tooling/benchmarks/export-synth-spec.ts out/g6-ref --single-pass --encoder nvenc
bun run tooling/benchmarks/export-synth-spec.ts out/g6-gpu --single-pass --encoder nvenc --renderer gpu
# render each dir with export_harness, then:
bun run tooling/benchmarks/parity.ts out/g6-ref out/g6-gpu --suffix _gpu --profile renderer --skip-missing
```

The camera sweep and hop table are parsed from the `gpu export: finished` log
line; no extra tooling is required.
