# Capture Overhead — Phase 4 Results (2026-10-26)

Implementation notes, measurements and open validation for Phase 4 (GPU-first
capture) of `speed-improvement-plan.md`.

Baseline: same laptop as the earlier phases (i5-11400H, RTX 3050 Laptop, Intel
UHD iGPU), pinned FFmpeg/FFprobe **9.0.1** sidecars.

All capture numbers are **CPU seconds of the capture process** for 5 s of live
1080p30 desktop capture, read from `-benchmark` (`utime + stime`). Wall time is
useless here: `ddagrab` paces the pipeline to realtime, so `rtime` is always
~5 s whenever capture keeps up. The source really is the live desktop, so runs
are noisy — every comparison below is interleaved and repeated.

## 4.1 Aspect-preserving output geometry (shipped)

### What changed

`RecordingProfile::for_source_bounds` derives the recording frame from the
source aspect inside the profile's box (the limiting dimension is unchanged),
and `Recorder::prepare` pins that geometry for the whole session
(`resolve_profile_for_source`, `capture/session.rs`). The encoder graph, the
cursor telemetry transform, the manifest and the probe all see the same frame.

| source | profile | before | after |
| --- | --- | --- | --- |
| 1920×1080 display | balanced (1920×1080) | 1920×1080 | 1920×1080 |
| 1920×1200 display | balanced | 1920×1080 + bars | 1728×1080 |
| 1024×768 window | balanced | 1920×1080 + 240 px bars | 1440×1080 |
| 2560×1080 ultra-wide window | balanced | 1920×1080 + bars | 1920×810 |
| 600×900 region | balanced | 1920×1080 + bars | 720×1080 |
| 1920×1080 display | ultra-4k | 3840×2160 | 3840×2160 (still upscales) |

Camera profiles are untouched: their `width`/`height` is a device budget owned
by `capture::camera_plan`, not a screen box.

### Why it is also a correctness fix

The bars were not free. `CursorCoordinateTransform::from_bounds` maps the
capture rect linearly onto the output frame, with no letterbox offset, so a
4:3 window recorded into 16:9 produced cursor positions that agree at the
centre of the frame and drift by up to half the bar width at the edges (240 px
on the example above). With the aspect-preserving frame the mapping is uniform,
so the cursor lands where the pointer was.

Measured on the leftmost 20 px column of a 1024×768 capture (`signalstats`
`YMIN`, first frame):

| graph | left-edge luma |
| --- | --- |
| old: fit + pad into 1920×1080 | `16` — the `color=black` pad |
| new: fit into 1440×1080 | `190` — desktop content |

### Window resize

Geometry is pinned at session start. A window that later moves or resizes keeps
recording into that frame through the existing fit filter (letterboxed if the
aspect changed), which is what keeps resumed segments concatenable — the same
contract the fixed profile had.

## 4.2 Quick Sync zero-copy capture (shipped, validated)

### Graph

`h264_qsv` now qualifies for the GPU-resident path (`gpu_screen_filter`), with
its own device derivation:

```
-init_hw_device d3d11va=dx -init_hw_device qsv=qs@dx
filter_complex: [0:v]hwmap=derive_device=qsv,vpp_qsv=w=W:h=H:format=nv12:out_range=tv[vout]
-c:v h264_qsv            (no -pix_fmt: the encoder reads QSV frames directly)
```

`vpp_qsv` rather than `scale_qsv`: `ddagrab` delivers a **full-range** BGRA
desktop, and `scale_qsv` carries that range through, producing
`yuvj420p(pc, gbr/...)` — which plays back washed out on players that honour the
tag. `vpp_qsv=…:out_range=tv` converts to broadcast range, matching the CPU
path's `yuv420p(tv)`.

### CPU cost (5 s of live 1080p30, pinned FFmpeg)

| graph | CPU s (run 1) | CPU s (run 2) |
| --- | --- | --- |
| CPU chain: `hwdownload,format=bgra,scale,pad,format=nv12` → `h264_qsv` | 3.50 | 3.36 |
| zero-copy: `hwmap=derive_device=qsv,vpp_qsv` → `h264_qsv` | 0.63 | 0.38 |

**5.4×–9× less CPU per captured second.** The zero-copy run is almost entirely
the `ddagrab` source itself.

### End-to-end smoke test (aspect-preserving + zero-copy)

A 1024×768 source recorded at the derived 1440×1080 through the real
fragmented-MP4 muxer, 4 s:

```
width=1440 height=1080 pix_fmt=yuv420p color_range=tv
duration=4.000000 nb_read_frames=120     (exact: 4 s × 30 fps)
decode: clean
```

So 4.1 and 4.2 compose: the GPU path now covers window/region/odd-aspect
captures and produces frame-exact, limited-range files.

### NVENC / AMF / MF zero-copy (`scale_d3d11`) — **not usable on this machine**

`[0:v]scale_d3d11=width=…:height=…:format=nv12` fails at filter init
(`Failed to configure output pad`), for `h264_nvenc`, `h264_amf` and `h264_mf`,
while `ddagrab` → `hwdownload` works and `hwmap`→QSV works. That is a
D3D11-video-processor limitation of this laptop's Intel iGPU/driver, not of the
graph: the existing runtime fallback (`ddagrab-gpu` fails → retry with
`gpu_screen_capture=false`) already covers it. Quick Sync is therefore the only
zero-copy path measurable here.

## 4.3 macOS: NV12 at output size from ScreenCaptureKit (implemented, unverified)

`MacosSckCapture` now:

- starts the stream at the **recording's output size** (`profile` geometry)
  instead of the full display resolution, so SCK's GPU does the scaling and the
  FFmpeg graph has no scale/pad stage left (`[0:v]null[vout]`);
- prefers `PixelFormat::YCbCr_420v` (NV12, 1.5 bytes/px instead of 4) and packs
  both planes through the shared `capture::nv12` helper;
- falls back to packed BGRA (also at output size) if the stream cannot be
  created/started **or if the first frame is not packable within 1.2 s** — an
  OS that ignores `420v` would otherwise record an empty file;
- still streams the whole display for **region** captures, because the crop
  rect is in display pixels, and crops in FFmpeg.

`build_video_filter` short-circuits to `null` when the fd-3 input is already
NV12 at the target size.

**Not verified:** there is no macOS host in this session. The packing itself is
covered by the platform-neutral `capture/nv12.rs` unit tests, and the failure
mode degrades to today's BGRA path, but a real macOS 13/14/26 run is still
required before trusting the numbers from the plan (62.5 % fewer pipe bytes).

## 4.4 Encoder-side improvements (partial, measurement-driven)

### NV12 at the end of the CPU graph (shipped)

Hardware encoders now get `…,format=nv12` as the graph's last stage plus
`-pix_fmt nv12` (`screen_pix_fmt`), instead of an auto-inserted conversion at
the encoder boundary. Required by Quick Sync and Media Foundation, neutral on
NVENC:

| NVENC, 1080p30, 5 s | CPU s |
| --- | --- |
| `-pix_fmt yuv420p` | 1.47 / 0.83 / 0.80 |
| `…,format=nv12` + `-pix_fmt nv12` | 1.53 / 0.66 / 1.19 |

Within run-to-run noise on this machine; kept because it removes a redundant
conversion for QSV/MF and makes the graph's output format explicit.

### Multithreaded `scale` — **hypothesis rejected, kept opt-in**

The plan expected extra swscale threads at ≥1440p / ≥60 fps. Measured on the
baseline machine, they do not pay off:

| case | threads=1 | threads=0 (auto) |
| --- | --- | --- |
| 1920×1080 → 1920×1080 @30, x264, 5 s | 2.36 / 2.13 / 2.25 | 2.97 / 2.48 / 2.92 |
| 2560×1440 → 2560×1440 @60, x264, 4 s | 7.48 / 5.41 | 5.70 / 6.00 |
| 3840×2160 → 1920×1080 @30, x264, 5 s | 2.64 / 2.80 | 3.22 / 2.06 |

Explicit `threads=2` (9.02 / 6.92) and `threads=4` (9.45 / 9.25) at 1440p60 were
clearly worse. The stage is memory-bound — the capture source already saturates
the memory bus — so extra slice threads mostly add overhead. Default stays
single-threaded; `RECORDFORGE_CAPTURE_SCALE_THREADS=1` turns auto-threading on
for machines where the trade-off differs.

## 4.5 Linux PipeWire NV12 (implemented, opt-in)

- `NV12` is now a negotiable format (`video_input_from_format` → `nv12`,
  shared bi-planar packing, `ParamBuffers` with two data blocks).
- The offer only includes NV12 when `RECORDFORGE_CAPTURE_PIPEWIRE_NV12=1`.
  Default is the previous BGRx-first list: the packing is unit-tested but has no
  Wayland host to validate the negotiated plane layout, and getting it wrong
  would silently break screen capture for every PipeWire session.
- I420 was not offered: it needs a three-plane packer, and no compositor here
  can confirm it is worth the extra path.

## Environment knobs (new)

| Variable | Default | Effect |
| --- | --- | --- |
| `RECORDFORGE_CAPTURE_SCALE_THREADS` | off | `1` lets swscale pick a thread count for ≥1440p / ≥60 fps screen capture (measured neutral-to-worse on the baseline laptop). |
| `RECORDFORGE_CAPTURE_PIPEWIRE_NV12` | off | `1` offers NV12 first during PipeWire format negotiation. |

## Validation

- `cargo check --all-targets` — clean (no warnings).
- `cargo clippy --all-targets -- -D warnings` — clean.
- `cargo fmt --check` — clean.
- `cargo test -j 1` — lib 592 passed / 10 ignored (live-desktop only), plus the
  integration targets (`cross_platform_…` 7, `macos_e2e_…` 6, `p0_blocker_…` 6).
  `cargo test -j 1 capture::` on its own: 263 passed / 8 ignored.
- New unit tests:
  - `config`: matching/mismatched aspect, budget regressions (4:3, 16:10, 21:9,
    portrait), even/never-degenerate geometry, camera budget untouched,
    `resolve_profile_for_source`.
  - `ffmpeg`: QSV derived-device graph, even-rounded aspect accepted on the GPU
    path, 4-pixel mismatch rejected, QSV has no `-pix_fmt`, CPU chains feed
    NV12, scale threads stay opt-in and size-gated.
  - `nv12`: tight packing, stride padding + offsets, short/odd/malformed planes,
    realistic frame layout (runs on every host — the module is not
    platform-gated).
  - `linux_pipewire`: NV12 `ParamBuffers` pod serializes, odd heights rejected.
- Sidecar evidence: QSV zero-copy smoke test above (frame-exact, `color_range=tv`,
  clean decode) and the pad-vs-content left-edge luma check for 4.1.

## Limitations and follow-ups

- **macOS 4.3 and Linux 4.5 need hardware validation.** Both are written against
  the pinned crate/FFmpeg APIs, but no macOS or Wayland host was available.
  4.3 degrades to BGRA and 4.5 is off by default, so neither changes behavior on
  an unvalidated machine.
- **`scale_d3d11`** could not be exercised here; NVENC/AMF/MF zero-copy remains
  unmeasured. If it works on other hardware, 4.1's aspect-preserving geometry
  now makes window and region captures eligible for it.
- **Hybrid-GPU machines still prefer NVENC.** On this laptop the encoder
  priority picks `h264_nvenc`, whose `scale_d3d11` graph fails, and the retry
  falls back to the *same* encoder on the CPU path — so Quick Sync's zero-copy
  win is only reachable on machines without NVENC/AMF/MF. Retrying the next
  encoder candidate after a GPU-graph failure is the natural follow-up (it also
  needs the encoder pre-flight from Phase 1.5 to stay cheap).
- **QSV availability** depends on the driver accepting
  `-init_hw_device qsv=qs@dx`; a failure is covered by the existing GPU→CPU
  retry, at the cost of one failed startup attempt per segment.
- **Cursor registration** for aspect-preserved frames is covered by the
  coordinate-transform unit tests, but a live capture with a real 4:3 window and
  the overlay cursor should be eyeballed once.
- **3.3 (webcam stream copy) is still blocked** on its own data-model change
  (the signed start offset in the project's camera clip). 4.1 fixed the screen
  output geometry, which is a different assumption.
