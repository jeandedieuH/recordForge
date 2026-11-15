# M3 — B-roll, Gaps, and Camera-Layout Fixtures (2026-11-15)

Measured results for the first run of these fixtures are in
[`phase-7-m3-results.md`](./phase-7-m3-results.md).

This note covers the fixture changes the M3 milestone (gaps F2, video layers F3,
camera layout lane #5, b-roll #13, media tracks #14) adds to
`tooling/benchmarks/export-synth-spec.ts`. It documents what is measured and how
to run it; measured numbers live in the phase reports that follow each release.

## What changed

| Fixture                         | Shape                                                                                                                       | Parity policy                                                                                                                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abl-b-roll`                    | Static `role: "video"` layer (640×360, `fit: cover`, radius, border, shadow) over the plain plan, source = the webcam asset | **Parity row.** Both renderers decode the same asset and composite the same quad, so the pair is held to the renderer profile (mean ≥ 40 dB, min ≥ 28 dB).                                                                        |
| `gap_fill` (was `fallback_gap`) | 10 s plan with a mid-timeline hole (4.5 s–5.5 s)                                                                            | **Parity row.** Since F2 the decode pass splices a black source for every declared gap and the composite pass paints the canvas background, so the plan is inside the GPU gate. The pair should stay at 100 dB (identity frames). |
| `approx-camera-layout`          | Camera bubbles grown to full-bleed and back via `cameraLayouts` keyframes                                                   | **Approximation row.** The compatibility renderer keeps the static bubble (ADR 020 `camera-layouts` downgrade). `parity.ts` reports `approx-` stems as SKIP; the benchmark measures their wall time.                              |

The `gap_fill` rename means the `fallback_gap` rows in `phase-5-results.md` and
`phase-6-results.md` describe the pre-M3 gate. Those reports stay as historical
records; from M3 on, gap plans render on the compositor.

## Commands

Compatibility baseline (single-pass so segmentation matches the GPU renderer):

```bash
bun run --cwd tooling/benchmarks export-synth-spec.ts out/m3 --single-pass
```

GPU candidate, including the approximation row:

```bash
bun run --cwd tooling/benchmarks export-synth-spec.ts out/m3-gpu --single-pass --renderer gpu
```

Render both with the harness (multiple specs per process so the device cache
counts), then:

```bash
bun run tooling/benchmarks/parity.ts out/m3 out/m3-gpu --suffix _gpu --profile renderer
```

Budget for the milestone: zoom-free specs ±2 % wall; the camera-layout spec is
the heaviest row (the camera decodes at canvas size for the whole track), and its
wall time is expected to stay within the camera row's decode budget because the
layout only changes the quad destination, not the frame count.

## Golden frames

`b-roll` and `camera-layout` are also candidates for the checked-in
golden-frame set (`benchmark:golden`). Add them only after a visual review:
video-layer animation and layout interpolation are visual changes, so a golden
refresh must be intentional.
